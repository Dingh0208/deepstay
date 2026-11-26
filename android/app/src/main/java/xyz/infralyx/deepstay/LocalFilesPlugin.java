package xyz.infralyx.deepstay;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import android.widget.TextView;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.MalformedURLException;
import java.net.URL;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@CapacitorPlugin(name = "LocalFiles")
public class LocalFilesPlugin extends Plugin {
    /** 历史导出包体积上限：超过该值直接拒绝，避免缓存目录被占满。 */
    private static final long MAX_ARCHIVE_BYTES = 200L * 1024 * 1024;
    /** 进度事件节流阈值，避免每个读取块都跨桥。 */
    private static final long PROGRESS_STEP_BYTES = 256L * 1024;
    private static final int MAX_REDIRECTS = 5;
    private static final String IMPORT_DIR = "import";
    private static final String ARCHIVE_PREFIX = "archive-";
    /** DeepSeek 导出桶按浏览器 UA 分发，缺省 UA 可能被拒绝。 */
    private static final String ARCHIVE_USER_AGENT =
        "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

    /** 下载失败的原因码，与 JS 侧 i18n 文案一一对应。 */
    private static final class ArchiveFailure extends Exception {
        final String code;

        ArchiveFailure(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    private static final class ArchiveDownload {
        final String id;
        final File target;
        volatile HttpURLConnection connection;
        volatile boolean cancelled;

        ArchiveDownload(String id, File target) {
            this.id = id;
            this.target = target;
        }

        void cancel() {
            cancelled = true;
            HttpURLConnection current = connection;
            if (current != null) {
                current.disconnect();
            }
        }
    }

    private final Map<String, ArchiveDownload> archiveDownloads = new ConcurrentHashMap<>();
    @PluginMethod
    public void getFontScale(PluginCall call) {
        call.resolve(new JSObject().put("scale", getContext().getResources().getConfiguration().fontScale));
    }

    @PluginMethod
    public void getSystemFontFamilyName(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            String familyName = "sans-serif";
            if (Build.VERSION.SDK_INT >= 34) {
                // The Activity theme may use a different typeface from Typeface.DEFAULT.
                Typeface typeface = new TextView(getActivity()).getTypeface();
                String systemFamilyName = typeface == null ? null : typeface.getSystemFontFamilyName();
                if (systemFamilyName != null && !systemFamilyName.isEmpty()) {
                    familyName = systemFamilyName;
                }
            }
            call.resolve(new JSObject().put("familyName", familyName));
        });
    }

    @PluginMethod
    public void shareDiagnostics(PluginCall call) {
        String text = call.getString("text");
        if (text == null || text.length() > 65536) {
            call.reject("Invalid diagnostic data");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                Intent send = new Intent(Intent.ACTION_SEND)
                    .setType("text/plain")
                    .putExtra(Intent.EXTRA_TEXT, text);
                getActivity().startActivity(Intent.createChooser(send, null));
                call.resolve();
            } catch (RuntimeException error) {
                call.reject("Unable to share diagnostics", error);
            }
        });
    }

    private OutputStream exportStream;
    private String exportId;

    @PluginMethod
    public void beginSave(PluginCall call) {
        if (call.getString("name") == null || exportStream != null) {
            call.reject("Missing name or export already active");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("application/zip")
            .putExtra(Intent.EXTRA_TITLE, call.getString("name"));
        startActivityForResult(call, intent, "beginSaveResult");
    }

    @ActivityCallback
    private void beginSaveResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve(new JSObject().put("cancelled", true));
            return;
        }
        execute(() -> {
            try {
                exportStream = getContext().getContentResolver().openOutputStream(result.getData().getData(), "wt");
                if (exportStream == null) throw new java.io.IOException("Cannot open destination");
                exportId = java.util.UUID.randomUUID().toString();
                call.resolve(new JSObject().put("id", exportId).put("cancelled", false));
            } catch (Exception error) {
                closeExport();
                call.reject("Unable to open export file", error);
            }
        });
    }

    @PluginMethod
    public void appendSave(PluginCall call) {
        String data = call.getString("data");
        if (data == null || data.length() > 350000) {
            call.reject("Invalid export chunk");
            return;
        }
        execute(() -> {
            try {
                if (exportStream == null || !exportId.equals(call.getString("id"))) {
                    throw new java.io.IOException("Export is not active");
                }
                exportStream.write(Base64.decode(data, Base64.NO_WRAP));
                call.resolve();
            } catch (Exception error) {
                closeExport();
                call.reject("Unable to write export file", error);
            }
        });
    }

    @PluginMethod
    public void finishSave(PluginCall call) {
        execute(() -> {
            if (exportStream == null || !exportId.equals(call.getString("id"))) {
                call.reject("Export is not active");
                return;
            }
            try {
                exportStream.close();
                exportStream = null;
                exportId = null;
                call.resolve();
            } catch (Exception error) {
                closeExport();
                call.reject("Unable to finish export file", error);
            }
        });
    }

    private void closeExport() {
        if (exportStream != null) {
            try { exportStream.close(); } catch (Exception ignored) { }
        }
        exportStream = null;
        exportId = null;
    }

    @Override
    protected void handleOnDestroy() {
        for (ArchiveDownload download : archiveDownloads.values()) {
            download.cancel();
        }
        archiveDownloads.clear();
        closeExport();
        super.handleOnDestroy();
    }

    // ---------- 历史导出包下载 ----------

    /** 下载远端导出包到缓存目录；进度通过 downloadProgress 事件回报，成功后由 JS 侧读取并释放。 */
    @PluginMethod
    public void downloadArchive(PluginCall call) {
        String id = call.getString("id");
        String raw = call.getString("url");
        if (id == null || !id.matches("[A-Za-z0-9-]{1,64}") || raw == null || raw.isEmpty()) {
            call.reject("Invalid archive request", "ARCHIVE_URL_INVALID");
            return;
        }
        URL url;
        try {
            url = new URL(raw.trim());
        } catch (MalformedURLException error) {
            call.reject("Invalid archive URL", "ARCHIVE_URL_INVALID");
            return;
        }
        String invalid = validateArchiveUrl(url);
        if (invalid != null) {
            call.reject("Unsupported archive URL", invalid);
            return;
        }
        File directory = archiveDirectory();
        if (directory == null) {
            call.reject("Cannot prepare the download directory", "ARCHIVE_NETWORK");
            return;
        }
        File target = new File(directory, ARCHIVE_PREFIX + id + ".zip");
        ArchiveDownload download = new ArchiveDownload(id, target);
        if (archiveDownloads.putIfAbsent(id, download) != null) {
            call.reject("An archive download is already active", "ARCHIVE_BUSY");
            return;
        }
        new Thread(() -> runArchiveDownload(call, download, url), "deepstay-archive-download").start();
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        String id = call.getString("id");
        ArchiveDownload download = id == null ? null : archiveDownloads.get(id);
        if (download != null) {
            download.cancel();
        }
        call.resolve();
    }

    /** 只允许删除下载目录内的文件，避免成为任意路径删除入口。 */
    @PluginMethod
    public void releaseArchive(PluginCall call) {
        String path = call.getString("path");
        File directory = archiveDirectory();
        if (path == null || directory == null || !isInsideDirectory(new File(path), directory)) {
            call.reject("Archive path is not owned by this plugin", "ARCHIVE_URL_INVALID");
            return;
        }
        new File(path).delete();
        call.resolve();
    }

    private void runArchiveDownload(PluginCall call, ArchiveDownload download, URL start) {
        File partial = new File(download.target.getPath() + ".part");
        HttpURLConnection connection = null;
        boolean finished = false;
        try {
            cleanupStaleArchives();
            download.target.delete();
            partial.delete();
            URL url = start;
            for (int hop = 0; ; hop++) {
                connection = openArchiveConnection(url, download);
                int status = connection.getResponseCode();
                if (status == 200) {
                    break;
                }
                String location = connection.getHeaderField("Location");
                connection.disconnect();
                connection = null;
                checkCancelled(download);
                if (status == 403) {
                    throw new ArchiveFailure("ARCHIVE_EXPIRED", "Archive link was rejected with HTTP 403");
                }
                if (status < 300 || status > 399 || location == null) {
                    throw new ArchiveFailure("ARCHIVE_NETWORK", "Archive download failed with HTTP " + status);
                }
                if (hop >= MAX_REDIRECTS) {
                    throw new ArchiveFailure("ARCHIVE_NETWORK", "Too many archive download redirects");
                }
                url = new URL(url, location);
                String invalid = validateArchiveUrl(url);
                if (invalid != null) {
                    throw new ArchiveFailure(invalid, "Archive redirect is not allowed");
                }
            }
            int declared = connection.getContentLength();
            long total = declared > 0 ? declared : -1;
            if (total > MAX_ARCHIVE_BYTES) {
                throw new ArchiveFailure("ARCHIVE_TOO_LARGE", "Archive exceeds the download limit");
            }
            long received = copyArchiveBody(download, connection, partial, total);
            checkCancelled(download);
            if (received == 0) {
                throw new ArchiveFailure("ARCHIVE_NETWORK", "Archive download is empty");
            }
            if (!partial.renameTo(download.target)) {
                throw new ArchiveFailure("ARCHIVE_NETWORK", "Cannot finish the archive download");
            }
            finished = true;
            notifyArchiveProgress(download.id, received, total > 0 ? total : received);
            call.resolve(new JSObject().put("path", download.target.getAbsolutePath()).put("bytes", received));
        } catch (ArchiveFailure error) {
            call.reject(error.getMessage(), error.code);
        } catch (IOException error) {
            call.reject("Archive download failed", download.cancelled ? "ARCHIVE_CANCELLED" : networkArchiveCode(error));
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
            partial.delete();
            if (!finished) {
                download.target.delete();
            }
            archiveDownloads.remove(download.id, download);
        }
    }

    /** 边读边落盘，累计超限立即中止；进度按固定步长节流上报。 */
    private long copyArchiveBody(ArchiveDownload download, HttpURLConnection connection, File partial, long total)
        throws IOException, ArchiveFailure {
        byte[] buffer = new byte[64 * 1024];
        long received = 0;
        long reported = 0;
        try (InputStream input = connection.getInputStream(); OutputStream output = new FileOutputStream(partial)) {
            while (true) {
                checkCancelled(download);
                int read = input.read(buffer);
                if (read < 0) {
                    break;
                }
                received += read;
                if (received > MAX_ARCHIVE_BYTES) {
                    throw new ArchiveFailure("ARCHIVE_TOO_LARGE", "Archive exceeds the download limit");
                }
                output.write(buffer, 0, read);
                if (received - reported >= PROGRESS_STEP_BYTES) {
                    reported = received;
                    notifyArchiveProgress(download.id, received, total);
                }
            }
        }
        return received;
    }

    private HttpURLConnection openArchiveConnection(URL url, ArchiveDownload download) throws IOException {
        checkCancelled(download);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        download.connection = connection;
        connection.setConnectTimeout(20000);
        connection.setReadTimeout(60000);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setRequestProperty("User-Agent", ARCHIVE_USER_AGENT);
        connection.setRequestProperty("Accept", "application/zip,application/octet-stream,*/*");
        // 禁止压缩协商，保证 Content-Length 与实际字节一致，进度不会跑偏。
        connection.setRequestProperty("Accept-Encoding", "identity");
        return connection;
    }

    private void checkCancelled(ArchiveDownload download) throws IOException {
        if (download.cancelled) {
            throw new IOException("Archive download cancelled");
        }
    }

    /** 返回 null 表示可下载；否则返回失败码。 */
    private String validateArchiveUrl(URL url) {
        if (!"https".equalsIgnoreCase(url.getProtocol()) || url.getUserInfo() != null) {
            return "ARCHIVE_URL_INVALID";
        }
        String host = url.getHost();
        if (host == null || host.isEmpty()) {
            return "ARCHIVE_URL_INVALID";
        }
        return isBlockedHost(host) ? "ARCHIVE_URL_BLOCKED" : null;
    }

    /** 同时覆盖字面量与域名解析结果，避免链接把请求指向内网。 */
    private boolean isBlockedHost(String host) {
        String normalized = host.toLowerCase(Locale.ROOT);
        if (normalized.equals("localhost") || normalized.endsWith(".localhost") || normalized.endsWith(".local")) {
            return true;
        }
        try {
            for (InetAddress address : InetAddress.getAllByName(normalized)) {
                if (address.isAnyLocalAddress() || address.isLoopbackAddress() ||
                    address.isLinkLocalAddress() || address.isSiteLocalAddress()) {
                    return true;
                }
            }
        } catch (IOException error) {
            // 解析失败交给连接阶段报 ARCHIVE_DNS，此处不判定为私网。
            return false;
        }
        return false;
    }

    private File archiveDirectory() {
        File directory = new File(getContext().getCacheDir(), IMPORT_DIR);
        if (!directory.isDirectory() && !directory.mkdirs()) {
            return null;
        }
        return directory;
    }

    private boolean isInsideDirectory(File file, File directory) {
        try {
            String base = directory.getCanonicalPath() + File.separator;
            return file.getCanonicalPath().startsWith(base);
        } catch (IOException error) {
            return false;
        }
    }

    /** 清理中断遗留的临时文件，一小时内修改的保留，可能仍在下载。 */
    private void cleanupStaleArchives() {
        File directory = archiveDirectory();
        File[] files = directory == null ? null : directory.listFiles();
        if (files == null) {
            return;
        }
        long deadline = System.currentTimeMillis() - 60L * 60 * 1000;
        for (File file : files) {
            if (file.isFile() && file.lastModified() < deadline && !isArchiveActive(file)) {
                file.delete();
            }
        }
    }

    private boolean isArchiveActive(File file) {
        for (ArchiveDownload download : archiveDownloads.values()) {
            if (download.target.equals(file)) {
                return true;
            }
        }
        return false;
    }

    private void notifyArchiveProgress(String id, long received, long total) {
        Long known = total > 0 ? Long.valueOf(total) : null;
        JSObject event = new JSObject().put("id", id).put("received", received).put("total", known);
        notifyListeners("downloadProgress", event);
    }

    private String networkArchiveCode(IOException error) {
        if (error instanceof java.net.UnknownHostException) {
            return "ARCHIVE_DNS";
        }
        if (error instanceof java.net.SocketTimeoutException) {
            return "ARCHIVE_TIMEOUT";
        }
        if (error instanceof javax.net.ssl.SSLException) {
            return "ARCHIVE_TLS";
        }
        return "ARCHIVE_NETWORK";
    }

    @PluginMethod
    public void save(PluginCall call) {
        if (call.getString("data") == null || call.getString("name") == null) {
            call.reject("Missing file data or name");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mimeType", "application/octet-stream"));
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("name"));
        startActivityForResult(call, intent, "saveResult");
    }

    @ActivityCallback
    private void saveResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve(new JSObject().put("cancelled", true));
            return;
        }
        execute(() -> {
            try (OutputStream stream = getContext().getContentResolver().openOutputStream(result.getData().getData())) {
                if (stream == null) throw new java.io.IOException("Cannot open destination file");
                stream.write(Base64.decode(call.getString("data"), Base64.DEFAULT));
                call.resolve(new JSObject().put("cancelled", false));
            } catch (Exception error) {
                call.reject("Unable to save file", error);
            }
        });
    }
}
