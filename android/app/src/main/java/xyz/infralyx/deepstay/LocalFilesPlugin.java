package xyz.infralyx.deepstay;

import android.app.Activity;
import android.content.Intent;
import android.util.Base64;
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
