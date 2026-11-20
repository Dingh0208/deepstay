package xyz.infralyx.deepstay;

import android.content.Intent;
import android.content.SharedPreferences;
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
import java.io.FileInputStream;
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
    private boolean installing;

    @PluginMethod
    public void getInstallStatus(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(
                getContext().getPackageName(), 0);
            SharedPreferences preferences = getContext().getSharedPreferences(
                "deepstay_app_updates", android.content.Context.MODE_PRIVATE);
            long lastUpdateTime = info.lastUpdateTime;
            long firstInstallTime = info.firstInstallTime;
            long seenUpdateTime = preferences.getLong("seen_update_time", 0L);
            boolean updated = lastUpdateTime > firstInstallTime &&
                lastUpdateTime > seenUpdateTime;
            preferences.edit().putLong("seen_update_time", lastUpdateTime).apply();
            JSObject result = new JSObject();
            result.put("updated", updated);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Unable to read application install status", error);
        }
    }

    private SharedPreferences updatePreferences() {
        return getContext().getSharedPreferences("deepstay_app_updates", android.content.Context.MODE_PRIVATE);
    }

    private File updateFile(String sha256) {
        return new File(new File(getContext().getCacheDir(), "updates"), "deepstay-" + sha256.toLowerCase(Locale.ROOT) + ".apk");
    }

    private boolean isChecksum(String value) {
        return value != null && value.matches("(?i)[a-f0-9]{64}");
    }

    private Long expectedVersionCode(PluginCall call) throws IOException {
        Object value = call.getData().opt("expectedVersionCode");
        if (value == null || value == org.json.JSONObject.NULL) return null;
        if (!(value instanceof Number)) throw new IOException("Invalid target version code");
        double number = ((Number) value).doubleValue();
        if (Double.isNaN(number) || Double.isInfinite(number) || number < 1 || number > 9007199254740991L || number != Math.floor(number)) {
            throw new IOException("Invalid target version code");
        }
        return ((Number) value).longValue();
    }

    @PluginMethod
    public void downloadApk(PluginCall call) {
        String url = call.getString("url");
        String expectedSha256 = call.getString("sha256");
        String expectedVersion = call.getString("expectedVersion");
        final Long expectedCode;
        try {
            expectedCode = expectedVersionCode(call);
        } catch (IOException error) {
            call.reject(error.getMessage(), error);
            return;
        }
        if (!isAllowedApkUrl(url) || !isChecksum(expectedSha256) ||
            expectedVersion == null || expectedVersion.trim().isEmpty()) {
            call.reject("Invalid APK release URL, checksum or target version");
            return;
        }

        synchronized (downloadLock) {
            if (downloading || installing) {
                call.reject("An update download or installation is already in progress");
                return;
            }
            downloading = true;
            cancelled = false;
        }
        // Keep Capacitor's shared plugin thread free so cancelDownload can interrupt network I/O.
        new Thread(() -> {
            File output = updateFile(expectedSha256);
            File partial = new File(output.getPath() + ".part");
            HttpURLConnection connection = null;
            try {
                File directory = output.getParentFile();
                if (!directory.exists() && !directory.mkdirs()) {
                    throw new IOException("Cannot create update directory");
                }
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
                PackageInfo archive = verifyArchive(partial, expectedVersion, expectedCode);
                checkCancelled();
                if (output.exists()) {
                    // A hash identifies immutable bytes; keep an existing URI's file in place.
                    try {
                        verifyChecksum(output, expectedSha256);
                    } catch (IOException error) {
                        if (!output.delete()) throw error;
                    }
                }
                if (!output.exists() && !partial.renameTo(output)) {
                    throw new IOException("Cannot finish the verified download");
                }
                if (!updatePreferences().edit().putString("pending_sha256", expectedSha256.toLowerCase(Locale.ROOT))
                    .putString("pending_version", archive.versionName).putLong("pending_version_code", versionCode(archive)).commit()) {
                    throw new IOException("Cannot save verified update metadata");
                }
                sendProgress(received, received);
                JSObject result = new JSObject();
                result.put("bytes", received);
                call.resolve(result);
            } catch (Exception error) {
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
            connection.setUseCaches(false);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/vnd.android.package-archive");
            connection.setRequestProperty("Cache-Control", "no-cache");
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

    private void finishInstallation() {
        synchronized (downloadLock) {
            installing = false;
        }
    }

    @PluginMethod
    public void getPendingApk(PluginCall call) {
        synchronized (downloadLock) {
            JSObject result = new JSObject();
            result.put("ready", false);
            if (!downloading) {
                // Legacy downloads have no release identity and must not be offered for installation.
                File legacy = new File(new File(getContext().getCacheDir(), "updates"), "deepstay.apk");
                legacy.delete();
                new File(legacy.getPath() + ".part").delete();
                SharedPreferences preferences = updatePreferences();
                String sha256 = preferences.getString("pending_sha256", null);
                if (!isChecksum(sha256)) {
                    call.resolve(result);
                    return;
                }
                File apk = updateFile(sha256);
                new File(apk.getPath() + ".part").delete();
                try {
                    verifyChecksum(apk, sha256);
                    PackageInfo archive = verifyArchive(apk, preferences.getString("pending_version", null),
                        preferences.getLong("pending_version_code", 0L));
                    result.put("ready", true);
                    result.put("version", archive.versionName);
                    result.put("versionCode", versionCode(archive));
                    result.put("sha256", sha256);
                    result.put("bytes", apk.length());
                } catch (Exception error) {
                    apk.delete();
                    preferences.edit().remove("pending_sha256").remove("pending_version").remove("pending_version_code").apply();
                }
            }
            call.resolve(result);
        }
    }

    @SuppressWarnings("deprecation")
    private PackageInfo verifyArchive(File apk, String expectedVersion, Long expectedCode) throws Exception {
        PackageManager manager = getContext().getPackageManager();
        PackageInfo current = manager.getPackageInfo(getContext().getPackageName(), PackageManager.GET_SIGNATURES);
        PackageInfo archive = manager.getPackageArchiveInfo(apk.getAbsolutePath(), PackageManager.GET_SIGNATURES);
        if (archive == null || !current.packageName.equals(archive.packageName) ||
            archive.signatures == null || archive.signatures.length == 0 || current.signatures == null ||
            !new HashSet<Signature>(Arrays.asList(current.signatures)).equals(new HashSet<Signature>(Arrays.asList(archive.signatures)))) {
            throw new IOException("Update package or signing certificate does not match this app");
        }
        verifyReleaseVersion(versionCode(current), versionCode(archive), archive.versionName, expectedVersion, expectedCode);
        return archive;
    }

    @SuppressWarnings("deprecation")
    private long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
    }

    static void verifyReleaseVersion(long currentCode, long archiveCode, String archiveVersion,
        String expectedVersion, Long expectedCode) throws IOException {
        if (archiveCode < currentCode) throw new IOException("Update would downgrade this app");
        if (archiveCode == currentCode) throw new IOException("Update is already installed");
        if (expectedVersion == null || !expectedVersion.equals(archiveVersion) ||
            (expectedCode != null && expectedCode != archiveCode)) {
            throw new IOException("APK version does not match the selected release");
        }
    }

    static void verifyChecksum(File apk, String expectedSha256) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[32768];
        try (InputStream input = new FileInputStream(apk)) {
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        if (!toHex(digest.digest()).equalsIgnoreCase(expectedSha256)) {
            throw new IOException("APK checksum does not match the selected release");
        }
    }

    private static String toHex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value));
        return result.toString();
    }

    @PluginMethod
    public void installApk(PluginCall call) {
        synchronized (downloadLock) {
            if (downloading || installing) {
                call.reject("An update download or installation is already in progress");
                return;
            }
            installing = true;
        }
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
            finishInstallation();
            call.reject("Unable to open the Android install permission settings", error);
        }
    }

    @ActivityCallback
    private void installPermissionResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            finishInstallation();
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !getContext().getPackageManager().canRequestPackageInstalls()) {
            JSObject response = new JSObject();
            response.put("permissionRequired", true);
            finishInstallation();
            call.resolve(response);
            return;
        }
        launchInstaller(call);
    }

    private void launchInstaller(PluginCall call) {
        try {
            String sha256 = call.getString("sha256");
            String expectedVersion = call.getString("expectedVersion");
            Long expectedCode = expectedVersionCode(call);
            if (!isChecksum(sha256) || expectedVersion == null || expectedVersion.trim().isEmpty()) {
                throw new IOException("Select a verified update before installing it");
            }
            synchronized (downloadLock) {
                if (downloading) throw new IOException("Wait for the update download to finish");
            }
            File apk = updateFile(sha256);
            verifyChecksum(apk, sha256);
            verifyArchive(apk, expectedVersion, expectedCode);
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
            Intent installer = new Intent(Intent.ACTION_VIEW);
            installer.setDataAndType(uri, "application/vnd.android.package-archive");
            installer.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(installer);
            call.resolve(new JSObject());
        } catch (Exception error) {
            call.reject("Unable to open the Android package installer", error);
        } finally {
            finishInstallation();
        }
    }
}
