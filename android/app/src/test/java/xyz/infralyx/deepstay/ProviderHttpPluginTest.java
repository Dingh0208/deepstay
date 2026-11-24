package xyz.infralyx.deepstay;

import static org.junit.Assert.*;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import okhttp3.Call;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okio.Buffer;
import org.junit.Test;

public class ProviderHttpPluginTest {
    @Test
    public void cleartextIsLimitedToLoopbackAndPrivateNetworkHosts() {
        for (String host : new String[] {
            "localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.254",
            "192.168.1.50", "169.254.10.2", "[::1]", "fd12:3456::1", "fe80::1",
        }) {
            assertTrue(host, ProviderHttpPlugin.isPrivateNetworkHost(host));
        }
        for (String host : new String[] {
            "example.test", "8.8.8.8", "172.15.255.255", "172.32.0.1", "192.169.1.1", "256.1.1.1",
        }) {
            assertFalse(host, ProviderHttpPlugin.isPrivateNetworkHost(host));
        }
        assertTrue(ProviderHttpPlugin.supportsProviderScheme("https", "example.test"));
        assertTrue(ProviderHttpPlugin.supportsProviderScheme("http", "192.168.1.30"));
        assertFalse(ProviderHttpPlugin.supportsProviderScheme("http", "example.test"));
    }

    @Test
    public void connectionRefusalIsDistinctFromCertificateAndDnsFailures() {
        assertEquals("PROVIDER_CONNECT", ProviderHttpPlugin.networkErrorCode(new java.net.ConnectException("fixture refused")));
        assertEquals("PROVIDER_DNS", ProviderHttpPlugin.networkErrorCode(new java.net.UnknownHostException("fixture host")));
        assertEquals("PROVIDER_TIMEOUT", ProviderHttpPlugin.networkErrorCode(new java.net.SocketTimeoutException("fixture timeout")));
        assertEquals("PROVIDER_TLS", ProviderHttpPlugin.networkErrorCode(new javax.net.ssl.SSLException("fixture certificate")));
        assertEquals("PROVIDER_NETWORK", ProviderHttpPlugin.networkErrorCode(new java.io.IOException("fixture network")));
    }

    @Test
    public void malformedHeaderRejectsWithoutEscapingTheNativeBridge() {
        OkHttpClient client = new OkHttpClient();
        String url = "https://relay.example.test/api/v3/models";
        String pastedKey = "Bearer fixture\u00a0key";
        assertThrows(IllegalArgumentException.class, () -> new Request.Builder().url(url).header("Authorization", pastedKey));
        assertNull(ProviderHttpPlugin.createProviderCall(client, url, "GET", pastedKey, "application/json", null));
        Call valid = ProviderHttpPlugin.createProviderCall(client, url, "GET", "Bearer fixture-key", "application/json", null);
        assertNotNull(valid);
        assertEquals(url, valid.request().url().toString());
        Call chat = ProviderHttpPlugin.createProviderCall(client, "https://relay.example.test/v1beta/openai/chat/completions", "POST", "Bearer fixture-key", "text/event-stream", "{}");
        assertNotNull(chat);
        assertEquals("POST", chat.request().method());
        Call encoded = ProviderHttpPlugin.createProviderCall(client, "https://relay.example.test/proxy%20prefix/v2/models", "GET", "Bearer fixture-key", "application/json", null);
        assertNotNull(encoded);
        assertEquals("/proxy%20prefix/v2/models", encoded.request().url().encodedPath());
    }

    @Test
    public void nativeRoutesMatchCustomBasesAndRejectEncodedSeparators() {
        for (String path : new String[] { "/models", "/api/v3/models", "/proxy/chat/completions", "/v1beta/openai/chat/completions", "/v1/audio/transcriptions", "/proxy%20prefix/v2/models", "/%E4%B8%AD%E6%96%87/v1/models" }) {
            assertTrue(path, ProviderHttpPlugin.supportsProviderPath(URI.create("https://relay.example.test" + path)));
        }
        for (String path : new String[] { "/proxy%2fprivate/models", "/proxy%5cprivate/models", "/proxy/%2e%2e/models", "/proxy/%252e%252e/models", "/proxy/../models", "/other" }) {
            assertFalse(path, ProviderHttpPlugin.supportsProviderPath(URI.create("https://relay.example.test" + path)));
        }
    }

    @Test
    public void streamedRequestBodyWritesExactUtf8BytesFromBoundedChunks() throws Exception {
        String expected = "a".repeat(24 * 1024 - 1) + "😀" + "食".repeat(45_000);
        byte[] utf8 = expected.getBytes(StandardCharsets.UTF_8);
        BlockingQueue<ProviderHttpPlugin.BodyChunk> chunks = new ArrayBlockingQueue<>(2);
        AtomicBoolean bodyWritten = new AtomicBoolean(false);
        RequestBody body = ProviderHttpPlugin.createChunkedRequestBody(utf8.length, chunks, bodyWritten);
        assertEquals(utf8.length, body.contentLength());
        assertTrue(body.isOneShot());

        AtomicReference<Throwable> producerFailure = new AtomicReference<>();
        Thread writer = new Thread(() -> {
            try {
                for (int offset = 0; offset < utf8.length;) {
                    int end = Math.min(offset + 24 * 1024, utf8.length);
                    chunks.put(ProviderHttpPlugin.BodyChunk.data(java.util.Arrays.copyOfRange(utf8, offset, end)));
                    offset = end;
                }
                chunks.put(ProviderHttpPlugin.BodyChunk.end());
            } catch (InterruptedException error) {
                producerFailure.set(error);
                Thread.currentThread().interrupt();
            }
        });
        writer.start();
        Buffer output = new Buffer();
        body.writeTo(output);
        writer.join(2_000);
        assertFalse("request body producer should exit", writer.isAlive());
        assertNull(producerFailure.get());
        assertTrue(bodyWritten.get());
        assertArrayEquals(utf8, output.readByteArray());
    }

    @Test
    public void streamedRequestBodyStopsWhenEarlyHttpResponseArrives() throws Exception {
        BlockingQueue<ProviderHttpPlugin.BodyChunk> chunks = new ArrayBlockingQueue<>(2);
        AtomicBoolean bodyWritten = new AtomicBoolean(false);
        RequestBody body = ProviderHttpPlugin.createChunkedRequestBody(10, chunks, bodyWritten);
        Call call = new OkHttpClient().newCall(new Request.Builder().url("https://relay.example.test/v1/chat/completions").build());
        ProviderHttpPlugin.RequestState state = new ProviderHttpPlugin.RequestState(call, 10, chunks, bodyWritten);
        CountDownLatch started = new CountDownLatch(1);
        AtomicReference<java.io.IOException> failure = new AtomicReference<>();
        Thread writer = new Thread(() -> {
            started.countDown();
            try {
                body.writeTo(new Buffer());
            } catch (java.io.IOException error) {
                failure.set(error);
            }
        });
        writer.start();
        assertTrue(started.await(2, TimeUnit.SECONDS));
        state.bodyFinishRequested = true; // finishBody started, but its end marker has not been queued yet.
        assertTrue(state.stopForEarlyHttpResponse());
        writer.join(2_000);
        assertFalse("closed request body writer should exit", writer.isAlive());
        assertEquals("Provider returned an HTTP error before upload completed", failure.get().getMessage());
        assertTrue(state.earlyHttpResponse);
        assertFalse(bodyWritten.get());
        assertTrue(chunks.isEmpty());
    }

    @Test
    public void streamedRequestBodyRejectsIncompleteByteCount() throws Exception {
        BlockingQueue<ProviderHttpPlugin.BodyChunk> chunks = new ArrayBlockingQueue<>(2);
        chunks.add(ProviderHttpPlugin.BodyChunk.data(new byte[] { 1, 2 }));
        chunks.add(ProviderHttpPlugin.BodyChunk.end());
        RequestBody body = ProviderHttpPlugin.createChunkedRequestBody(3, chunks, new AtomicBoolean(false));
        assertThrows(java.io.IOException.class, () -> body.writeTo(new Buffer()));
    }

    @Test
    public void transcriptionMultipartIsBoundToWhisperWavAndEightMiB() throws Exception {
        byte[] sample = new byte[] { 'R', 'I', 'F', 'F', 0, 0, 0, 0, 'W', 'A', 'V', 'E' };
        String encoded = java.util.Base64.getEncoder().encodeToString(sample);
        RequestBody body = ProviderHttpPlugin.createTranscriptionBody("whisper-1", "recording.wav", "audio/wav", encoded);
        assertNotNull(body);
        Call call = ProviderHttpPlugin.createProviderCall(new OkHttpClient(),
            "http://192.168.1.20:11434/v1/audio/transcriptions", "POST", "Bearer fixture-key", "application/json", null, body);
        assertNotNull(call);
        assertTrue(call.request().body().contentType().toString().startsWith("multipart/form-data; boundary="));
        Buffer encodedBody = new Buffer();
        call.request().body().writeTo(encodedBody);
        String text = encodedBody.readUtf8();
        assertTrue(text.contains("name=\"model\""));
        assertTrue(text.contains("whisper-1"));
        assertTrue(text.contains("name=\"file\"; filename=\"recording.wav\""));

        assertNull(ProviderHttpPlugin.createTranscriptionBody("other-model", "recording.wav", "audio/wav", encoded));
        assertNull(ProviderHttpPlugin.createTranscriptionBody("whisper-1", "../secret.wav", "audio/wav", encoded));
        assertNull(ProviderHttpPlugin.createTranscriptionBody("whisper-1", "recording.wav", "application/octet-stream", encoded));
        assertNull(ProviderHttpPlugin.createTranscriptionBody("whisper-1", "recording.wav", "audio/wav", "A".repeat(11_184_813)));
    }
}
