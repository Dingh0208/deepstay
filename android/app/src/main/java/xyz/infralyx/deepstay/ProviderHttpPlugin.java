package xyz.infralyx.deepstay;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.net.URI;
import java.net.UnknownHostException;
import java.net.SocketTimeoutException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.SSLException;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.BufferedSource;

@CapacitorPlugin(name = "ProviderHttp")
public class ProviderHttpPlugin extends Plugin {
    private static final int MAX_CONNECTIONS = 4;
    private static final int MAX_READ_BYTES = 16384;

    private final OkHttpClient client = new OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .connectTimeout(20, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(0, java.util.concurrent.TimeUnit.MILLISECONDS)
        .build();
    private final ExecutorService io = Executors.newCachedThreadPool();
    private final ConcurrentHashMap<String, RequestState> requests = new ConcurrentHashMap<>();

    private static final class RequestState {
        final Call call;
        volatile Response response;
        volatile BufferedSource source;

        RequestState(Call call) {
            this.call = call;
        }

        void close() {
            call.cancel();
            Response current = response;
            if (current != null) current.close();
        }
    }

    @PluginMethod
    public void open(PluginCall call) {
        String id = call.getString("id");
        String url = call.getString("url");
        String method = call.getString("method");
        String authorization = call.getString("authorization");
        String accept = call.getString("accept");
        String body = call.getString("body");

        URI uri;
        try {
            uri = URI.create(url == null ? "" : url);
        } catch (IllegalArgumentException error) {
            call.reject("Invalid provider URL", "PROVIDER_URL");
            return;
        }
        String path = uri.getRawPath();
        boolean models = path != null && path.endsWith("/v1/models") && "GET".equals(method);
        boolean completions = path != null && path.endsWith("/v1/chat/completions") && "POST".equals(method);
        if (id == null || !id.matches("[A-Za-z0-9-]{1,64}") ||
            !"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null ||
            uri.getUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null ||
            path == null || path.contains("%") || path.contains("\\") ||
            !(models || completions) || (completions && body == null)) {
            call.reject("Unsupported provider request", "PROVIDER_URL");
            return;
        }
        if (requests.size() >= MAX_CONNECTIONS) {
            call.reject("Too many provider requests", "PROVIDER_BUSY");
            return;
        }

        Request.Builder builder = new Request.Builder().url(url).header("Accept", accept == null ? "*/*" : accept);
        if (authorization != null) builder.header("Authorization", authorization);
        if (completions) {
            RequestBody requestBody = RequestBody.create(
                body,
                MediaType.parse("application/json; charset=utf-8")
            );
            builder.post(requestBody);
        } else {
            builder.get();
        }
        Call networkCall = client.newCall(builder.build());
        RequestState state = new RequestState(networkCall);
        if (requests.putIfAbsent(id, state) != null) {
            call.reject("Duplicate provider request", "PROVIDER_URL");
            return;
        }
        networkCall.enqueue(new Callback() {
            @Override
            public void onFailure(Call ignored, IOException error) {
                requests.remove(id, state);
                rejectNetwork(call, error);
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
                JSObject result = new JSObject();
                result.put("status", response.code());
                result.put("contentType", response.header("Content-Type"));
                call.resolve(result);
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

    private void rejectNetwork(PluginCall call, IOException error) {
        String code = error instanceof UnknownHostException ? "PROVIDER_DNS"
            : error instanceof SocketTimeoutException ? "PROVIDER_TIMEOUT"
            : error instanceof SSLException ? "PROVIDER_TLS"
            : "PROVIDER_NETWORK";
        call.reject("Provider request failed", code);
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
