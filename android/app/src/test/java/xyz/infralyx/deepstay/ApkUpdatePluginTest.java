package xyz.infralyx.deepstay;

import static org.junit.Assert.*;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class ApkUpdatePluginTest {
    @Rule public TemporaryFolder files = new TemporaryFolder();

    @Test
    public void installedAndOlderPackagesCannotBeOfferedAsUpdates() {
        IOException same = assertThrows(IOException.class,
            () -> ApkUpdatePlugin.verifyReleaseVersion(14, 14, "0.1.13", "0.1.13", 14L));
        assertEquals("Update is already installed", same.getMessage());
        assertThrows(IOException.class,
            () -> ApkUpdatePlugin.verifyReleaseVersion(14, 13, "0.1.12", "0.1.12", 13L));
    }

    @Test
    public void newerButStaleArchiveMustMatchTheSelectedRelease() throws Exception {
        // Both archives are upgrades from code 12; a stale CDN response must still be rejected.
        assertThrows(IOException.class,
            () -> ApkUpdatePlugin.verifyReleaseVersion(12, 14, "0.1.13", "0.1.14", 15L));
        assertThrows(IOException.class,
            () -> ApkUpdatePlugin.verifyReleaseVersion(12, 14, "0.1.14", "0.1.14", 15L));
        ApkUpdatePlugin.verifyReleaseVersion(14, 15, "0.1.14", "0.1.14", 15L);
    }

    @Test
    public void legacyManifestsStillBindToTheirVersionName() throws Exception {
        ApkUpdatePlugin.verifyReleaseVersion(14, 15, "0.1.14", "0.1.14", null);
        assertThrows(IOException.class,
            () -> ApkUpdatePlugin.verifyReleaseVersion(12, 14, "0.1.13", "0.1.14", null));
        assertThrows(IOException.class,
            () -> ApkUpdatePlugin.verifyReleaseVersion(14, 15, "0.1.14", null, null));
    }

    @Test
    public void installationRechecksTheFileRatherThanTrustingDownloadMetadata() throws Exception {
        File apk = files.newFile("verified.apk");
        String sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        ApkUpdatePlugin.verifyChecksum(apk, sha256.toUpperCase(java.util.Locale.ROOT));
        try (FileOutputStream output = new FileOutputStream(apk)) {
            output.write("replaced cached APK".getBytes(StandardCharsets.UTF_8));
        }
        assertThrows(IOException.class, () -> ApkUpdatePlugin.verifyChecksum(apk, sha256));
        assertTrue(apk.delete());
        assertThrows(IOException.class, () -> ApkUpdatePlugin.verifyChecksum(apk, sha256));
    }
}
