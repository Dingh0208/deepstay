package xyz.infralyx.deepstay;

import static org.junit.Assert.*;

import java.net.URI;
import okhttp3.Call;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import org.junit.Test;

public class ProviderHttpPluginTest {
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
        for (String path : new String[] { "/models", "/api/v3/models", "/proxy/chat/completions", "/v1beta/openai/chat/completions", "/proxy%20prefix/v2/models", "/%E4%B8%AD%E6%96%87/v1/models" }) {
            assertTrue(path, ProviderHttpPlugin.supportsProviderPath(URI.create("https://relay.example.test" + path)));
        }
        for (String path : new String[] { "/proxy%2fprivate/models", "/proxy%5cprivate/models", "/proxy/%2e%2e/models", "/proxy/%252e%252e/models", "/proxy/../models", "/other" }) {
            assertFalse(path, ProviderHttpPlugin.supportsProviderPath(URI.create("https://relay.example.test" + path)));
        }
    }
}
