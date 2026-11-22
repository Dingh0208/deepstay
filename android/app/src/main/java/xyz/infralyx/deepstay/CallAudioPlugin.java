package xyz.infralyx.deepstay;

import android.Manifest;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.NoiseSuppressor;
import android.os.Build;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

@CapacitorPlugin(
    name = "CallAudio",
    permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class CallAudioPlugin extends Plugin {
    private static final int INPUT_RATE = 16000;
    private static final int OUTPUT_RATE = 24000;
    private static final int FRAME_SAMPLES = 320;
    private static final int MAX_WRITE_BYTES = 1_048_576;
    private static final long PLAYBACK_HEAD_MODULO = 0x1_0000_0000L;

    private final Object sessionLock = new Object();
    private final ExecutorService audioIo = Executors.newSingleThreadExecutor();
    private final AtomicLong startGeneration = new AtomicLong();
    private final ConcurrentHashMap<String, Long> pendingStarts = new ConcurrentHashMap<>();
    private AudioSession session;

    private static final class AudioSession {
        final AudioRecord recorder;
        final AudioTrack player;
        final AudioManager audioManager;
        final int priorMode;
        final boolean priorSpeaker;
        final AudioDeviceInfo priorCommunicationDevice;
        final AcousticEchoCanceler echoCanceler;
        final NoiseSuppressor noiseSuppressor;
        final AtomicBoolean stopping = new AtomicBoolean(false);
        final AtomicBoolean cleaned = new AtomicBoolean(false);
        final AtomicLong eventSequence = new AtomicLong();
        final AtomicLong playbackEpoch = new AtomicLong();
        final CountDownLatch cleanupDone = new CountDownLatch(1);
        volatile boolean muted;
        volatile Thread captureThread;
        long lastPlaybackHead;
        long playedSamples;
        long lastReportedSamples;

        AudioSession(
            AudioRecord recorder,
            AudioTrack player,
            AudioManager audioManager,
            int priorMode,
            boolean priorSpeaker,
            AudioDeviceInfo priorCommunicationDevice,
            AcousticEchoCanceler echoCanceler,
            NoiseSuppressor noiseSuppressor
        ) {
            this.recorder = recorder;
            this.player = player;
            this.audioManager = audioManager;
            this.priorMode = priorMode;
            this.priorSpeaker = priorSpeaker;
            this.priorCommunicationDevice = priorCommunicationDevice;
            this.echoCanceler = echoCanceler;
            this.noiseSuppressor = noiseSuppressor;
        }

        synchronized long updatePlayedSamples() {
            long current = Integer.toUnsignedLong(player.getPlaybackHeadPosition());
            long delta = (current - lastPlaybackHead + PLAYBACK_HEAD_MODULO) % PLAYBACK_HEAD_MODULO;
            playedSamples += delta;
            lastPlaybackHead = current;
            return playedSamples;
        }

        synchronized void resetPlaybackHead() {
            lastPlaybackHead = Integer.toUnsignedLong(player.getPlaybackHeadPosition());
        }

        void cleanup() {
            if (!cleaned.compareAndSet(false, true)) {
                try {
                    cleanupDone.await(1, TimeUnit.SECONDS);
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                }
                return;
            }
            stopping.set(true);
            try {
                try { recorder.stop(); } catch (RuntimeException ignored) {}
                try { player.pause(); } catch (RuntimeException ignored) {}
                try { player.flush(); } catch (RuntimeException ignored) {}
                Thread thread = captureThread;
                if (thread != null && thread != Thread.currentThread()) {
                    thread.interrupt();
                    try { thread.join(500); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                }
                releaseEffect(echoCanceler);
                releaseEffect(noiseSuppressor);
                recorder.release();
                player.release();
                restoreAudioRoute();
            } finally {
                cleanupDone.countDown();
            }
        }

        private void restoreAudioRoute() {
            try {
                audioManager.setMode(priorMode);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    audioManager.clearCommunicationDevice();
                    if (priorCommunicationDevice != null) {
                        audioManager.setCommunicationDevice(priorCommunicationDevice);
                    }
                } else {
                    audioManager.setSpeakerphoneOn(priorSpeaker);
                }
            } catch (RuntimeException ignored) {
                // Route restoration is best-effort when the OS removes a device during a call.
            }
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        long generation = startGeneration.incrementAndGet();
        pendingStarts.put(call.getCallbackId(), generation);
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "microphonePermissionResult");
            return;
        }
        startWithPermission(call, generation);
    }

    @PermissionCallback
    private void microphonePermissionResult(PluginCall call) {
        if (call == null) return;
        Long generation = pendingStarts.remove(call.getCallbackId());
        if (generation == null || generation != startGeneration.get()) {
            call.reject("Voice call start was cancelled", "CALL_AUDIO_CANCELLED");
            return;
        }
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("Microphone permission is required", "CALL_AUDIO_PERMISSION");
            return;
        }
        startWithPermission(call, generation);
    }

    private void startWithPermission(PluginCall call, long generation) {
        audioIo.execute(() -> {
            if (generation != startGeneration.get()) {
                pendingStarts.remove(call.getCallbackId(), generation);
                call.reject("Voice call start was cancelled", "CALL_AUDIO_CANCELLED");
                return;
            }
            synchronized (sessionLock) {
                if (session != null && !session.stopping.get()) {
                    pendingStarts.remove(call.getCallbackId(), generation);
                    call.resolve(sessionInfo(session));
                    return;
                }
            }

            AudioSession created = null;
            AudioManager audioManager = null;
            AudioRecord recorder = null;
            AudioTrack player = null;
            AcousticEchoCanceler aec = null;
            NoiseSuppressor ns = null;
            int priorMode = AudioManager.MODE_NORMAL;
            boolean priorSpeaker = false;
            AudioDeviceInfo priorDevice = null;
            try {
                audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
                if (audioManager == null) throw new IllegalStateException("Audio service unavailable");
                priorMode = audioManager.getMode();
                priorSpeaker = audioManager.isSpeakerphoneOn();
                priorDevice = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                    ? audioManager.getCommunicationDevice() : null;
                audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);

                int inputBuffer = AudioRecord.getMinBufferSize(
                    INPUT_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
                );
                int outputBuffer = AudioTrack.getMinBufferSize(
                    OUTPUT_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT
                );
                if (inputBuffer <= 0 || outputBuffer <= 0) throw new IllegalStateException("Audio format unavailable");

                AudioFormat inputFormat = new AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(INPUT_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                    .build();
                recorder = new AudioRecord.Builder()
                    .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
                    .setAudioFormat(inputFormat)
                    .setBufferSizeInBytes(Math.max(inputBuffer * 2, FRAME_SAMPLES * 4))
                    .build();
                if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
                    throw new IllegalStateException("Microphone could not be initialized");
                }

                AudioAttributes attributes = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build();
                AudioFormat outputFormat = new AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(OUTPUT_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build();
                player = new AudioTrack.Builder()
                    .setAudioAttributes(attributes)
                    .setAudioFormat(outputFormat)
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .setBufferSizeInBytes(Math.max(outputBuffer * 2, OUTPUT_RATE * 2 / 5))
                    .build();
                if (player.getState() != AudioTrack.STATE_INITIALIZED) {
                    throw new IllegalStateException("Voice playback could not be initialized");
                }

                int audioSessionId = recorder.getAudioSessionId();
                try {
                    if (AcousticEchoCanceler.isAvailable()) {
                        aec = AcousticEchoCanceler.create(audioSessionId);
                        if (aec != null) aec.setEnabled(true);
                    }
                } catch (RuntimeException ignored) {}
                try {
                    if (NoiseSuppressor.isAvailable()) {
                        ns = NoiseSuppressor.create(audioSessionId);
                        if (ns != null) ns.setEnabled(true);
                    }
                } catch (RuntimeException ignored) {}

                created = new AudioSession(
                    recorder, player, audioManager, priorMode, priorSpeaker, priorDevice, aec, ns
                );
                AudioSession started = created;
                synchronized (sessionLock) {
                    if (generation != startGeneration.get()) {
                        started.cleanup();
                        pendingStarts.remove(call.getCallbackId(), generation);
                        call.reject("Voice call start was cancelled", "CALL_AUDIO_CANCELLED");
                        return;
                    }
                    if (session != null && !session.stopping.get()) {
                        started.cleanup();
                        pendingStarts.remove(call.getCallbackId(), generation);
                        call.resolve(sessionInfo(session));
                        return;
                    }
                    session = started;
                    setSpeakerRoute(started, true);
                    recorder.startRecording();
                    player.play();
                    started.captureThread = new Thread(() -> capture(started), "deepstay-call-mic");
                    started.captureThread.start();
                }
                pendingStarts.remove(call.getCallbackId(), generation);
                if (!isCurrent(created)) {
                    call.reject("Voice call start was cancelled", "CALL_AUDIO_CANCELLED");
                    return;
                }
                call.resolve(sessionInfo(created));
            } catch (Exception error) {
                pendingStarts.remove(call.getCallbackId(), generation);
                if (created != null) {
                    clearSession(created);
                    created.cleanup();
                } else {
                    releaseEffect(aec);
                    releaseEffect(ns);
                    if (recorder != null) recorder.release();
                    if (player != null) player.release();
                    if (audioManager != null) restoreAudioRoute(audioManager, priorMode, priorSpeaker, priorDevice);
                }
                notifyCallError(error);
                call.reject("Unable to start call audio", "CALL_AUDIO_START");
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopCurrentSession();
        call.resolve(new JSObject());
    }

    @PluginMethod
    public void setMuted(PluginCall call) {
        AudioSession current = getSession(call);
        if (current == null) return;
        current.muted = call.getBoolean("muted", false);
        call.resolve(new JSObject().put("muted", current.muted));
    }

    @PluginMethod
    public void setSpeaker(PluginCall call) {
        AudioSession current = getSession(call);
        if (current == null) return;
        boolean speaker = call.getBoolean("speaker", true);
        try {
            setSpeakerRoute(current, speaker);
            call.resolve(new JSObject().put("speaker", speaker));
        } catch (RuntimeException error) {
            call.reject("Unable to change call audio route", "CALL_AUDIO_ROUTE");
        }
    }

    @PluginMethod
    public void setPlaybackGain(PluginCall call) {
        AudioSession current = getSession(call);
        if (current == null) return;
        Double value = call.getDouble("value");
        if (value == null || !isValidGain(value)) {
            call.reject("Playback gain must be between 0 and 1", "CALL_AUDIO_GAIN");
            return;
        }
        current.player.setVolume(value.floatValue());
        call.resolve(new JSObject().put("value", value));
    }

    @PluginMethod
    public void write(PluginCall call) {
        AudioSession current = getSession(call);
        if (current == null) return;
        String encoded = call.getString("pcm");
        if (encoded == null || encoded.length() > MAX_WRITE_BYTES * 2) {
            call.reject("Invalid PCM data", "CALL_AUDIO_PCM");
            return;
        }
        long epoch = current.playbackEpoch.get();
        audioIo.execute(() -> {
            if (!isCurrent(current) || current.stopping.get() || epoch != current.playbackEpoch.get()) {
                call.resolve(new JSObject().put("interrupted", true).put("samplesWritten", 0));
                return;
            }
            final byte[] bytes;
            try {
                bytes = Base64.decode(encoded, Base64.DEFAULT);
            } catch (IllegalArgumentException error) {
                call.reject("Invalid PCM data", "CALL_AUDIO_PCM");
                return;
            }
            if (bytes.length == 0 || bytes.length > MAX_WRITE_BYTES || (bytes.length & 1) != 0) {
                call.reject("PCM data must contain an even number of samples", "CALL_AUDIO_PCM");
                return;
            }
            int offset = 0;
            try {
                if (current.player.getPlayState() != AudioTrack.PLAYSTATE_PLAYING) current.player.play();
                while (offset < bytes.length && isCurrent(current) && !current.stopping.get() &&
                    epoch == current.playbackEpoch.get()) {
                    int written = current.player.write(bytes, offset, bytes.length - offset, AudioTrack.WRITE_BLOCKING);
                    if (written < 0) {
                        if (epoch != current.playbackEpoch.get() || current.stopping.get()) break;
                        throw new IllegalStateException("AudioTrack write failed: " + written);
                    }
                    if (written == 0) break;
                    offset += written;
                }
                call.resolve(new JSObject()
                    .put("interrupted", epoch != current.playbackEpoch.get())
                    .put("samplesWritten", offset / 2));
            } catch (RuntimeException error) {
                if (epoch != current.playbackEpoch.get() || current.stopping.get()) {
                    call.resolve(new JSObject().put("interrupted", true).put("samplesWritten", offset / 2));
                } else {
                    call.reject("Call audio playback failed", "CALL_AUDIO_PLAYBACK");
                }
            }
        });
    }

    @PluginMethod
    public void stopPlayback(PluginCall call) {
        AudioSession current = getSession(call);
        if (current == null) return;
        long samplesPlayed = current.updatePlayedSamples();
        current.playbackEpoch.incrementAndGet();
        try {
            current.player.pause();
            current.player.flush();
            current.resetPlaybackHead();
            call.resolve(new JSObject().put("samplesPlayed", samplesPlayed));
        } catch (RuntimeException error) {
            call.reject("Unable to stop call playback", "CALL_AUDIO_PLAYBACK");
        }
    }

    private void capture(AudioSession current) {
        short[] frame = new short[FRAME_SAMPLES];
        int filled = 0;
        try {
            while (!current.stopping.get()) {
                int count = current.recorder.read(frame, filled, FRAME_SAMPLES - filled, AudioRecord.READ_BLOCKING);
                if (count < 0) throw new IllegalStateException("AudioRecord read failed: " + count);
                if (count == 0) continue;
                filled += count;
                if (filled == FRAME_SAMPLES) {
                    if (!current.muted) emitAudioFrame(current, frame);
                    filled = 0;
                }
                long played = current.updatePlayedSamples();
                if (played != current.lastReportedSamples) {
                    current.lastReportedSamples = played;
                    emitPlayLevel(current, played);
                }
            }
        } catch (RuntimeException error) {
            if (!current.stopping.get()) {
                notifyCallError(error);
                clearSession(current);
                current.cleanup();
            }
        }
    }

    private void emitAudioFrame(AudioSession current, short[] frame) {
        JSObject event = new JSObject()
            .put("pcm", Base64.encodeToString(pcm16Bytes(frame, frame.length), Base64.NO_WRAP))
            .put("samples", frame.length)
            .put("sampleRate", INPUT_RATE)
            .put("level", normalizedRms(frame, frame.length))
            .put("sequence", current.eventSequence.incrementAndGet());
        notifyForSession(current, "audioFrame", event);
    }

    private void emitPlayLevel(AudioSession current, long samplesPlayed) {
        JSObject event = new JSObject()
            .put("samplesPlayed", samplesPlayed)
            .put("sampleRate", OUTPUT_RATE)
            .put("sequence", current.eventSequence.incrementAndGet());
        notifyForSession(current, "playLevel", event);
    }

    private void notifyForSession(AudioSession current, String eventName, JSObject event) {
        if (getActivity() != null) {
            getActivity().runOnUiThread(() -> {
                if (isCurrent(current) && !current.stopping.get()) notifyListeners(eventName, event);
            });
        }
    }

    private void notifyCallError(Exception error) {
        if (getActivity() != null) {
            JSObject event = new JSObject().put("code", "CALL_AUDIO_CAPTURE");
            getActivity().runOnUiThread(() -> notifyListeners("audioError", event));
        }
    }

    private AudioSession getSession(PluginCall call) {
        synchronized (sessionLock) {
            if (session == null || session.stopping.get()) {
                call.reject("Call audio is not running", "CALL_AUDIO_CLOSED");
                return null;
            }
            return session;
        }
    }

    private boolean isCurrent(AudioSession current) {
        synchronized (sessionLock) {
            return session == current;
        }
    }

    private void stopCurrentSession() {
        startGeneration.incrementAndGet();
        AudioSession current;
        synchronized (sessionLock) {
            current = session;
            session = null;
        }
        if (current != null) current.cleanup();
    }

    private void stopActiveSession() {
        synchronized (sessionLock) {
            if (session == null) return;
        }
        stopCurrentSession();
    }

    private void clearSession(AudioSession current) {
        synchronized (sessionLock) {
            if (session == current) session = null;
        }
    }

    private static void setSpeakerRoute(AudioSession state, boolean speaker) {
        AudioManager manager = state.audioManager;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            int wanted = speaker ? AudioDeviceInfo.TYPE_BUILTIN_SPEAKER : AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
            for (AudioDeviceInfo device : manager.getAvailableCommunicationDevices()) {
                if (device.getType() == wanted && manager.setCommunicationDevice(device)) return;
            }
            if (!speaker) {
                for (AudioDeviceInfo device : manager.getAvailableCommunicationDevices()) {
                    int type = device.getType();
                    if ((type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
                        type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
                        type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                        type == AudioDeviceInfo.TYPE_BLE_HEADSET) && manager.setCommunicationDevice(device)) return;
                }
            }
            if (manager.clearCommunicationDevice()) return;
            throw new IllegalStateException("Requested call audio device is unavailable");
        }
        manager.setSpeakerphoneOn(speaker);
    }

    private static void restoreAudioRoute(
        AudioManager manager,
        int priorMode,
        boolean priorSpeaker,
        AudioDeviceInfo priorCommunicationDevice
    ) {
        try {
            manager.setMode(priorMode);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                manager.clearCommunicationDevice();
                if (priorCommunicationDevice != null) manager.setCommunicationDevice(priorCommunicationDevice);
            } else {
                manager.setSpeakerphoneOn(priorSpeaker);
            }
        } catch (RuntimeException ignored) {
            // Route restoration is best-effort when the OS removes a device during startup.
        }
    }

    private static JSObject sessionInfo(AudioSession state) {
        return new JSObject()
            .put("sampleRate", INPUT_RATE)
            .put("frameSamples", FRAME_SAMPLES)
            .put("echoCancellation", state.echoCanceler != null && state.echoCanceler.getEnabled())
            .put("noiseSuppression", state.noiseSuppressor != null && state.noiseSuppressor.getEnabled());
    }

    static byte[] pcm16Bytes(short[] samples, int count) {
        if (samples == null || count < 0 || count > samples.length) throw new IllegalArgumentException("Invalid PCM samples");
        ByteBuffer buffer = ByteBuffer.allocate(count * 2).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < count; i++) buffer.putShort(samples[i]);
        return buffer.array();
    }

    static double normalizedRms(short[] samples, int count) {
        if (samples == null || count < 0 || count > samples.length) throw new IllegalArgumentException("Invalid PCM samples");
        if (count == 0) return 0;
        double sum = 0;
        for (int i = 0; i < count; i++) {
            double value = samples[i] / 32768.0;
            sum += value * value;
        }
        return Math.sqrt(sum / count);
    }

    static boolean isValidGain(double gain) {
        return !Double.isNaN(gain) && !Double.isInfinite(gain) && gain >= 0 && gain <= 1;
    }

    private static void releaseEffect(android.media.audiofx.AudioEffect effect) {
        if (effect != null) {
            try { effect.setEnabled(false); } catch (RuntimeException ignored) {}
            try { effect.release(); } catch (RuntimeException ignored) {}
        }
    }

    @Override
    protected void handleOnPause() {
        stopActiveSession();
    }

    @Override
    protected void handleOnStop() {
        stopActiveSession();
    }

    @Override
    protected void handleOnDestroy() {
        stopCurrentSession();
        audioIo.shutdownNow();
    }
}
