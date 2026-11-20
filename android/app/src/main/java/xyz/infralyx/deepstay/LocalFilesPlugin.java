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
import java.io.OutputStream;

@CapacitorPlugin(name = "LocalFiles")
public class LocalFilesPlugin extends Plugin {
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
