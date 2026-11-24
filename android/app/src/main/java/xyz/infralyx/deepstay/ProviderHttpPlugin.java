package xyz.infralyx.deepstay;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.net.URI;
import java.net.ConnectException;
import java.net.UnknownHostException;
import java.net.SocketTimeoutException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.SSLException;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.BufferedSource;
import okio.ByteString;

@CapacitorPlugin(name = "ProviderHttp")
public class ProviderHttpPlugin extends Plugin {
    private static final int MAX_CONNECTIONS = 4;
    private static final int MAX_READ_BYTES = 16384;
    private static final int MAX_BODY_CHUNK_BYTES = 24 * 1024;
    private static final int BODY_QUEUE_CAPACITY = 2;

    private final OkHttpClient client = new OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .connectTimeout(20, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(0, java.util.concurrent.TimeUnit.MILLISECONDS)
        .build();
    private final ExecutorService io = Executors.newCachedThreadPool();
    private final ConcurrentHashMap<String, RequestState> requests = new ConcurrentHashMap<>();

    static final class RequestState {
        final Call call;
        final BlockingQueue<BodyChunk> bodyChunks;
        final long expectedBodyBytes;
        final AtomicBoolean bodyWritten;
        final CountDownLatch responseReady = new CountDownLatch(1);
        volatile Response response;
        volatile BufferedSource source;
        volatile IOException failure;
        volatile boolean earlyHttpResponse;
        long queuedBodyBytes;
        boolean bodyFinishRequested;

        RequestState(Call call, long expectedBodyBytes, BlockingQueue<BodyChunk> bodyChunks, AtomicBoolean bodyWritten) {
            this.call = call;
            this.expectedBodyBytes = expectedBodyBytes;
            this.bodyChunks = bodyChunks;
            this.bodyWritten = bodyWritten;
        }

        boolean stopForEarlyHttpResponse() {
            synchronized (this) {
                if (bodyChunks == null || bodyWritten.get()) return false;
                earlyHttpResponse = true;
                stopChunkedBody(bodyChunks);
                return true;
            }
        }

        void fail(IOException error) {
            failure = error;
            if (bodyChunks != null) {
                bodyChunks.clear();
                bodyChunks.offer(BodyChunk.error(error));
            }
            responseReady.countDown();
        }

        void close() {
            call.cancel();
            if (bodyChunks != null) {
                bodyChunks.clear();
                bodyChunks.offer(BodyChunk.error(new IOException("Provider request closed")));
                if (failure == null) failure = new IOException("Provider request closed");
                responseReady.countDown();
            }
            Response current = response;
            if (current != null) current.close();
        }
    }

    static final class BodyChunk {
        final byte[] bytes;
        final boolean end;
        final IOException error;

        private BodyChunk(byte[] bytes, boolean end, IOException error) {
            this.bytes = bytes;
            this.end = end;
            this.error = error;
        }

        static BodyChunk data(byte[] bytes) { return new BodyChunk(bytes, false, null); }
        static BodyChunk end() { return new BodyChunk(null, true, null); }
        static BodyChunk error(IOException error) { return new BodyChunk(null, false, error); }
    }

    @PluginMethod
    public void open(PluginCall call) {
        String id = call.getString("id");
        String url = call.getString("url");
        String method = call.getString("method");
        String authorization = call.getString("authorization");
        String accept = call.getString("accept");
        String body = call.getString("body");
        Boolean streamBodyOption = call.getBoolean("streamBody");
        Long bodyLengthOption = readBodyLength(call.getInt("bodyLength"), call.getLong("bodyLength"));
        boolean streamBody = Boolean.TRUE.equals(streamBodyOption);
        long bodyLength = streamBody && bodyLengthOption != null ? bodyLengthOption : -1;
        String audioModel = call.getString("audioModel");
        String audioFileName = call.getString("audioFileName");
        String audioContentType = call.getString("audioContentType");
        String audioBase64 = call.getString("audioBase64");

        URI uri;
        try {
            uri = URI.create(url == null ? "" : url);
        } catch (IllegalArgumentException error) {
            call.reject("Invalid provider URL", "PROVIDER_URL");
            return;
        }
        String path = uri.getRawPath();
        boolean models = path != null && path.endsWith("/models") && "GET".equals(method);
        boolean completions = path != null && path.endsWith("/chat/completions") && "POST".equals(method);
        boolean transcriptions = path != null && path.endsWith("/audio/transcriptions") && "POST".equals(method);
        boolean allowedScheme = supportsProviderScheme(uri.getScheme(), uri.getHost());
        boolean hasAudioPayload = audioModel != null || audioFileName != null || audioContentType != null || audioBase64 != null;
        RequestBody audioBody = transcriptions
            ? createTranscriptionBody(audioModel, audioFileName, audioContentType, audioBase64)
            : null;
        if (id == null || !id.matches("[A-Za-z0-9-]{1,64}") ||
            !allowedScheme || uri.getHost() == null ||
            uri.getUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null ||
            !supportsProviderPath(uri) ||
            !(models || completions || transcriptions) ||
            (completions && ((streamBody && (body != null || bodyLength <= 0 || bodyLength > Integer.MAX_VALUE)) ||
                (!streamBody && body == null))) ||
            (!completions && streamBody) ||
            (transcriptions && (body != null || audioBody == null)) ||
            (!transcriptions && hasAudioPayload)) {
            call.reject("Unsupported provider request", "PROVIDER_URL");
            return;
        }
        if (requests.size() >= MAX_CONNECTIONS) {
            call.reject("Too many provider requests", "PROVIDER_BUSY");
            return;
        }

        BlockingQueue<BodyChunk> chunks = streamBody ? new ArrayBlockingQueue<>(BODY_QUEUE_CAPACITY) : null;
        AtomicBoolean bodyWritten = new AtomicBoolean(false);
        RequestBody streamedBody = streamBody ? createChunkedRequestBody(bodyLength, chunks, bodyWritten) : null;
        Call networkCall = createProviderCall(client, url, method, authorization, accept, body, audioBody, streamedBody);
        if (networkCall == null) {
            call.reject("Unsupported provider request", "PROVIDER_URL");
            return;
        }
        RequestState state = new RequestState(networkCall, streamBody ? bodyLength : -1, chunks, bodyWritten);
        if (requests.putIfAbsent(id, state) != null) {
            call.reject("Duplicate provider request", "PROVIDER_URL");
            return;
        }
        networkCall.enqueue(new Callback() {
            @Override
            public void onFailure(Call ignored, IOException error) {
                if (streamBody) {
                    state.fail(error);
                } else {
                    requests.remove(id, state);
                    rejectNetwork(call, error);
                }
            }

            @Override
            public void onResponse(Call ignored, Response response) {
                if (networkCall.isCanceled() || requests.get(id) != state) {
                    response.close();
                    return;
                }
                state.response = response;
                ResponseBody responseBody = response.body();
                if (responseBody != null) state.source = responseBody.source();
                if (streamBody && !response.isSuccessful()) state.stopForEarlyHttpResponse();
                JSObject result = new JSObject();
                state.responseReady.countDown();
                if (!streamBody) {
                    result.put("status", response.code());
                    result.put("contentType", response.header("Content-Type"));
                    call.resolve(result);
                }
            }
        });
        if (streamBody) {
            JSObject result = new JSObject();
            result.put("uploading", true);
            call.resolve(result);
        }
    }

    static boolean supportsProviderScheme(String scheme, String host) {
        return "https".equalsIgnoreCase(scheme) ||
            ("http".equalsIgnoreCase(scheme) && isPrivateNetworkHost(host));
    }

    static Long readBodyLength(Integer integerValue, Long longValue) {
        return integerValue == null ? longValue : integerValue.longValue();
    }

    static boolean isPrivateNetworkHost(String input) {
        if (input == null) return false;
        String host = input.toLowerCase(java.util.Locale.ROOT);
        if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
        if ("localhost".equals(host)) return true;
        if (host.matches("\\d{1,3}(\\.\\d{1,3}){3}")) {
            String[] parts = host.split("\\.");
            int[] octets = new int[4];
            try {
                for (int i = 0; i < 4; i++) {
                    octets[i] = Integer.parseInt(parts[i]);
                    if (octets[i] > 255) return false;
                }
            } catch (NumberFormatException error) {
                return false;
            }
            return octets[0] == 10 || octets[0] == 127 ||
                (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31) ||
                (octets[0] == 192 && octets[1] == 168) ||
                (octets[0] == 169 && octets[1] == 254);
        }
        if (host.indexOf(':') < 0 || !host.matches("[0-9a-f:]+") || host.contains(":::")) return false;
        try {
            byte[] address = java.net.InetAddress.getByName(host).getAddress();
            if (address.length != 16) return false;
            boolean loopback = true;
            for (int i = 0; i < 15; i++) loopback &= address[i] == 0;
            if (loopback && address[15] == 1) return true;
            int first = address[0] & 0xff;
            int second = address[1] & 0xff;
            return (first & 0xfe) == 0xfc || (first == 0xfe && (second & 0xc0) == 0x80);
        } catch (UnknownHostException error) {
            return false;
        }
    }

    static RequestBody createTranscriptionBody(String model, String fileName, String contentType, String audioBase64) {
        if (!"whisper-1".equals(model) || !"recording.wav".equals(fileName) ||
            !("audio/wav".equalsIgnoreCase(contentType) || "audio/x-wav".equalsIgnoreCase(contentType)) ||
            audioBase64 == null || audioBase64.length() == 0 || audioBase64.length() > 11_184_812) {
            return null;
        }
        try {
            ByteString decoded = ByteString.decodeBase64(audioBase64);
            if (decoded == null) return null;
            byte[] audio = decoded.toByteArray();
            if (audio.length == 0 || audio.length > 8 * 1024 * 1024) return null;
            RequestBody file = RequestBody.create(audio, MediaType.parse(contentType));
            return new MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("model", model)
                .addFormDataPart("file", fileName, file)
                .build();
        } catch (IllegalArgumentException error) {
            return null;
        }
    }

    static boolean supportsProviderPath(URI uri) {
        String raw = uri.getRawPath();
        if (raw == null || raw.contains("\\") || raw.matches("(?i).*%(?:25|2f|5c).*")) return false;
        for (String part : uri.getPath().split("/", -1)) {
            if (".".equals(part) || "..".equals(part)) return false;
        }
        return raw.endsWith("/models") || raw.endsWith("/chat/completions") || raw.endsWith("/audio/transcriptions");
    }

    static RequestBody createChunkedRequestBody(long expectedBytes, BlockingQueue<BodyChunk> chunks, AtomicBoolean bodyWritten) {
        return new RequestBody() {
            @Override public MediaType contentType() {
                return MediaType.parse("application/json; charset=utf-8");
            }

            @Override public long contentLength() { return expectedBytes; }

            @Override public boolean isOneShot() { return true; }

            @Override public void writeTo(okio.BufferedSink sink) throws IOException {
                long written = 0;
                try {
                    while (true) {
                        BodyChunk chunk = chunks.take();
                        if (chunk.error != null) throw chunk.error;
                        if (chunk.end) break;
                        if (chunk.bytes == null || chunk.bytes.length == 0 || written + chunk.bytes.length > expectedBytes) {
                            throw new IOException("Invalid provider request body chunk");
                        }
                        sink.write(chunk.bytes);
                        written += chunk.bytes.length;
                    }
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IOException("Provider request body interrupted", error);
                }
                if (written != expectedBytes) throw new IOException("Incomplete provider request body");
                bodyWritten.set(true);
            }
        };
    }

    static void stopChunkedBody(BlockingQueue<BodyChunk> chunks) {
        if (chunks != null) {
            chunks.clear();
            chunks.offer(BodyChunk.error(new IOException("Provider returned an HTTP error before upload completed")));
        }
    }

    // OkHttp rejects some header values accepted by Fetch Headers. Reject the call instead of crashing the native bridge.
    static Call createProviderCall(OkHttpClient client, String url, String method, String authorization, String accept, String body) {
        return createProviderCall(client, url, method, authorization, accept, body, null);
    }

    static Call createProviderCall(OkHttpClient client, String url, String method, String authorization, String accept,
        String body, RequestBody multipartBody) {
        return createProviderCall(client, url, method, authorization, accept, body, multipartBody, null);
    }

    static Call createProviderCall(OkHttpClient client, String url, String method, String authorization, String accept,
        String body, RequestBody multipartBody, RequestBody streamedBody) {
        try {
            Request.Builder builder = new Request.Builder().url(url).header("Accept", accept == null ? "*/*" : accept);
            if (authorization != null) builder.header("Authorization", authorization);
            if ("POST".equals(method)) {
                if (multipartBody != null) {
                    builder.post(multipartBody);
                } else if (streamedBody != null) {
                    builder.post(streamedBody);
                } else if (body != null) {
                    builder.post(RequestBody.create(body, MediaType.parse("application/json; charset=utf-8")));
                } else {
                    return null;
                }
            } else {
                builder.get();
            }
            return client.newCall(builder.build());
        } catch (IllegalArgumentException error) {
            return null;
        }
    }

    @PluginMethod
    public void writeBodyChunk(PluginCall call) {
        String id = call.getString("id");
        String encoded = call.getString("data");
        RequestState state = id == null ? null : requests.get(id);
        if (state == null) {
            call.reject("Provider request is closed", "PROVIDER_CLOSED");
            return;
        }
        if (state.bodyChunks == null || encoded == null || encoded.isEmpty()) {
            call.reject("Unsupported provider request body chunk", "PROVIDER_URL");
            return;
        }
        byte[] bytes;
        try {
            bytes = Base64.decode(encoded, Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            call.reject("Invalid provider request body chunk", "PROVIDER_URL");
            return;
        }
        if (bytes.length == 0 || bytes.length > MAX_BODY_CHUNK_BYTES) {
            call.reject("Invalid provider request body chunk", "PROVIDER_URL");
            return;
        }
        synchronized (state) {
            if (state.failure != null) {
                rejectNetwork(call, state.failure);
                return;
            }
            if (state.earlyHttpResponse) {
                JSObject result = new JSObject();
                result.put("continueUpload", false);
                call.resolve(result);
                return;
            }
            if (state.bodyFinishRequested || state.queuedBodyBytes + bytes.length > state.expectedBodyBytes) {
                call.reject("Unexpected provider request body chunk", "PROVIDER_URL");
                return;
            }
            state.queuedBodyBytes += bytes.length;
        }
        io.execute(() -> {
            try {
                if (!state.bodyChunks.offer(BodyChunk.data(bytes), 30, TimeUnit.SECONDS)) {
                    call.reject("Provider request body stalled", "PROVIDER_TIMEOUT");
                    state.fail(new IOException("Provider request body stalled"));
                    return;
                }
                if (state.earlyHttpResponse) {
                    JSObject result = new JSObject();
                    result.put("continueUpload", false);
                    call.resolve(result);
                } else {
                    call.resolve();
                }
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                state.fail(new IOException("Provider request body interrupted", error));
                call.reject("Provider request body interrupted", "PROVIDER_NETWORK");
            }
        });
    }

    @PluginMethod
    public void finishBody(PluginCall call) {
        String id = call.getString("id");
        RequestState state = id == null ? null : requests.get(id);
        if (state == null || state.bodyChunks == null) {
            call.reject("Unsupported provider request body", "PROVIDER_URL");
            return;
        }
        synchronized (state) {
            if (state.failure != null) {
                rejectNetwork(call, state.failure);
                return;
            }
            if (state.earlyHttpResponse) {
                JSObject result = new JSObject();
                result.put("continueUpload", false);
                call.resolve(result);
                return;
            }
            if (state.bodyFinishRequested || state.queuedBodyBytes != state.expectedBodyBytes) {
                call.reject("Incomplete provider request body", "PROVIDER_URL");
                return;
            }
            state.bodyFinishRequested = true;
        }
        io.execute(() -> {
            try {
                if (!state.bodyChunks.offer(BodyChunk.end(), 30, TimeUnit.SECONDS)) {
                    state.fail(new IOException("Provider request body stalled"));
                    call.reject("Provider request body stalled", "PROVIDER_TIMEOUT");
                    return;
                }
                call.resolve();
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                state.fail(new IOException("Provider request body interrupted", error));
                call.reject("Provider request body interrupted", "PROVIDER_NETWORK");
            }
        });
    }

    @PluginMethod
    public void awaitResponse(PluginCall call) {
        String id = call.getString("id");
        RequestState state = id == null ? null : requests.get(id);
        if (state == null || state.bodyChunks == null) {
            call.reject("Provider request is closed", "PROVIDER_CLOSED");
            return;
        }
        io.execute(() -> {
            try {
                state.responseReady.await();
                Response response = state.response;
                if (response == null && state.failure != null) {
                    rejectNetwork(call, state.failure);
                    return;
                }
                if (response == null) {
                    call.reject("Provider request closed", "PROVIDER_CLOSED");
                    return;
                }
                JSObject result = new JSObject();
                result.put("status", response.code());
                result.put("contentType", response.header("Content-Type"));
                call.resolve(result);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                call.reject("Provider request interrupted", "PROVIDER_NETWORK");
            }
        });
    }

    @PluginMethod
    public void read(PluginCall call) {
        String id = call.getString("id");
        RequestState state = id == null ? null : requests.get(id);
        if (state == null) {
            call.reject("Provider request is closed", "PROVIDER_CLOSED");
            return;
        }
        io.execute(() -> {
            try {
                BufferedSource source = state.source;
                if (source == null) {
                    closeRequest(id, state);
                    call.resolve(new JSObject());
                    return;
                }
                byte[] buffer = new byte[MAX_READ_BYTES];
                int count = source.read(buffer);
                if (count == -1 || !isActive(id, state)) {
                    closeRequest(id, state);
                    call.resolve(new JSObject());
                    return;
                }
                JSObject result = new JSObject();
                result.put("data", Base64.encodeToString(
                    java.util.Arrays.copyOf(buffer, count),
                    Base64.NO_WRAP
                ));
                call.resolve(result);
            } catch (IOException error) {
                closeRequest(id, state);
                rejectNetwork(call, error);
            }
        });
    }

    @PluginMethod
    public void close(PluginCall call) {
        String id = call.getString("id");
        RequestState state = id == null ? null : requests.get(id);
        if (state != null) closeRequest(id, state);
        call.resolve(new JSObject());
    }

    private boolean isActive(String id, RequestState state) {
        return !state.call.isCanceled() && requests.get(id) == state;
    }

    private void closeRequest(String id, RequestState state) {
        if (requests.remove(id, state)) state.close();
    }

    static String networkErrorCode(IOException error) {
        return error instanceof UnknownHostException ? "PROVIDER_DNS"
            : error instanceof SocketTimeoutException ? "PROVIDER_TIMEOUT"
            : error instanceof SSLException ? "PROVIDER_TLS"
            : error instanceof ConnectException ? "PROVIDER_CONNECT"
            : "PROVIDER_NETWORK";
    }

    private void rejectNetwork(PluginCall call, IOException error) {
        call.reject("Provider request failed", networkErrorCode(error));
    }

    @Override
    protected void handleOnDestroy() {
        for (java.util.Map.Entry<String, RequestState> entry : requests.entrySet()) {
            closeRequest(entry.getKey(), entry.getValue());
        }
        io.shutdownNow();
        super.handleOnDestroy();
    }
}
