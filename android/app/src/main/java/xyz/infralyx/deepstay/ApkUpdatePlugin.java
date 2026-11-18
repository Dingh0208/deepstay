package xyz.infralyx.deepstay;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;

@CapacitorPlugin(name = "ApkUpdate")
public class ApkUpdatePlugin extends Plugin {
    private static final long MAX_APK_BYTES = 100L * 1024L * 1024L;
    private static final String RELEASE_PREFIX = "https://github.com/Dingh0208/deepstay/releases/download/";
    private final Object downloadLock = new Object();
    private volatile boolean cancelled;
    private volatile HttpURLConnection activeConnection;
    private boolean downloading;

    private File updateFile() {
        return new File(new File(getContext().getCacheDir(), "updates"), "deepstay.apk");
    }

    @PluginMethod
    public void downloadApk(PluginCall call) {
        String url = call.getString("url");
        String expectedSha256 = call.getString("sha256");
        if (!isAllowedApkUrl(url) ||
            expectedSha256 == null || !expectedSha256.matches("(?i)[a-f0-9]{64}")) {
            call.reject("Invalid APK release URL or checksum");
            return;
        }

        synchronized (downloadLock) {
            if (downloading) {
                call.reject("An update is already downloading");
                return;
            }
            downloading = true;
            cancelled = false;
        }
        // Keep Capacitor's shared plugin thread free so cancelDownload can interrupt network I/O.
        new Thread(() -> {
            File output = updateFile();
            File partial = new File(output.getPath() + ".part");
            HttpURLConnection connection = null;
            try {
                File directory = output.getParentFile();
                if (!directory.exists() && !directory.mkdirs()) {
                    throw new IOException("Cannot create update directory");
                }
                output.delete();
                partial.delete();
                connection = openDownload(new URL(url));
                long contentLength = connection.getContentLength();
                if (contentLength > MAX_APK_BYTES) {
                    throw new IOException("APK exceeds the download size limit");
                }

                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long received = 0;
                long lastProgressAt = 0;
                byte[] buffer = new byte[32768];
                try (InputStream input = connection.getInputStream(); FileOutputStream file = new FileOutputStream(partial)) {
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        checkCancelled();
                        received += count;
                        if (received > MAX_APK_BYTES) {
                            throw new IOException("APK exceeds the download size limit");
                        }
                        digest.update(buffer, 0, count);
                        file.write(buffer, 0, count);
                        long now = android.os.SystemClock.elapsedRealtime();
                        if (now - lastProgressAt >= 100) {
                            sendProgress(received, contentLength);
                            lastProgressAt = now;
                        }
                    }
                }
                checkCancelled();
                String actualSha256 = toHex(digest.digest());
                if (!actualSha256.equalsIgnoreCase(expectedSha256)) {
                    throw new IOException("APK checksum does not match the release manifest");
                }
                verifyArchive(partial);
                checkCancelled();
                if (!partial.renameTo(output)) throw new IOException("Cannot finish the verified download");
                sendProgress(received, received);
                JSObject result = new JSObject();
                result.put("bytes", received);
                call.resolve(result);
            } catch (Exception error) {
                output.delete();
                call.reject(cancelled ? "Update download cancelled" : "Unable to download or verify the APK", error);
            } finally {
                partial.delete();
                if (connection != null) connection.disconnect();
                synchronized (downloadLock) {
                    if (activeConnection != null) activeConnection.disconnect();
                    activeConnection = null;
                    downloading = false;
                }
            }
        }, "deepstay-apk-download").start();
    }

    private boolean isAllowedApkUrl(String value) {
        if (value == null) return false;
        try {
            URL url = new URL(value).toURI().normalize().toURL();
            if (!isHttps(url) || !url.getPath().endsWith(".apk") || url.getPath().contains("%")) return false;
            if (url.toString().startsWith(RELEASE_PREFIX)) return true;
            if (BuildConfig.DEEPSTAY_UPDATE_MANIFEST_URL.isEmpty()) return false;
            URL manifest = new URL(BuildConfig.DEEPSTAY_UPDATE_MANIFEST_URL).toURI().normalize().toURL();
            int apkPort = url.getPort() == -1 ? url.getDefaultPort() : url.getPort();
            int manifestPort = manifest.getPort() == -1 ? manifest.getDefaultPort() : manifest.getPort();
            if (!isHttps(manifest) || !url.getHost().equalsIgnoreCase(manifest.getHost()) ||
                apkPort != manifestPort) return false;
            String directory = manifest.getPath().substring(0, manifest.getPath().lastIndexOf('/') + 1);
            String file = url.getPath().substring(url.getPath().lastIndexOf('/') + 1);
            return url.getPath().equals(directory + file);
        } catch (Exception error) {
            return false;
        }
    }

    private boolean isHttps(URL url) {
        return "https".equalsIgnoreCase(url.getProtocol()) && url.getUserInfo() == null;
    }

    private HttpURLConnection openDownload(URL url) throws IOException {
        for (int redirects = 0; redirects <= 5; redirects++) {
            checkCancelled();
            if (!isHttps(url)) throw new IOException("Update downloads require HTTPS");
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            activeConnection = connection;
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(30000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/vnd.android.package-archive");
            checkCancelled();
            int status = connection.getResponseCode();
            if (status == HttpURLConnection.HTTP_OK) return connection;
            String location = connection.getHeaderField("Location");
            connection.disconnect();
            if (status < 300 || status > 399 || location == null) {
                throw new IOException("Download failed with HTTP " + status);
            }
            url = new URL(url, location);
        }
        throw new IOException("Too many update download redirects");
    }

    private void sendProgress(long received, long total) {
        JSObject progress = new JSObject();
        progress.put("receivedBytes", received);
        progress.put("totalBytes", total);
        execute(() -> notifyListeners("downloadProgress", progress));
    }

    private void checkCancelled() throws IOException {
        if (cancelled) throw new IOException("Update download cancelled");
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        cancelDownload();
        call.resolve(new JSObject());
    }

    private void cancelDownload() {
        synchronized (downloadLock) {
            cancelled = true;
            if (activeConnection != null) activeConnection.disconnect();
        }
    }

    @Override
    protected void handleOnDestroy() {
        cancelDownload();
    }

    @SuppressWarnings("deprecation")
    private void verifyArchive(File apk) throws Exception {
        PackageManager manager = getContext().getPackageManager();
        PackageInfo current = manager.getPackageInfo(getContext().getPackageName(), PackageManager.GET_SIGNATURES);
        PackageInfo archive = manager.getPackageArchiveInfo(apk.getAbsolutePath(), PackageManager.GET_SIGNATURES);
        if (archive == null || !current.packageName.equals(archive.packageName) ||
            archive.signatures == null || archive.signatures.length == 0 || current.signatures == null ||
            !new HashSet<Signature>(Arrays.asList(current.signatures)).equals(new HashSet<Signature>(Arrays.asList(archive.signatures)))) {
            throw new IOException("Update package or signing certificate does not match this app");
        }
        long currentVersion = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? current.getLongVersionCode() : current.versionCode;
        long archiveVersion = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? archive.getLongVersionCode() : archive.versionCode;
        if (archiveVersion < currentVersion) throw new IOException("Update would downgrade this app");
    }

    private String toHex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value));
        return result.toString();
    }

    @PluginMethod
    public void installApk(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                !getContext().getPackageManager().canRequestPackageInstalls()) {
                Intent permission = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName()));
                startActivityForResult(call, permission, "installPermissionResult");
                return;
            }
            launchInstaller(call);
        } catch (Exception error) {
            call.reject("Unable to open the Android install permission settings", error);
        }
    }

    @ActivityCallback
    private void installPermissionResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !getContext().getPackageManager().canRequestPackageInstalls()) {
            JSObject response = new JSObject();
            response.put("permissionRequired", true);
            call.resolve(response);
            return;
        }
        launchInstaller(call);
    }

    private void launchInstaller(PluginCall call) {
        File apk = updateFile();
        if (!apk.isFile() || apk.length() == 0) {
            call.reject("Download the update before installing it");
            return;
        }
        try {
            verifyArchive(apk);
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
            Intent installer = new Intent(Intent.ACTION_VIEW);
            installer.setDataAndType(uri, "application/vnd.android.package-archive");
            installer.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(installer);
            call.resolve(new JSObject());
        } catch (Exception error) {
            call.reject("Unable to open the Android package installer", error);
        }
    }
}
