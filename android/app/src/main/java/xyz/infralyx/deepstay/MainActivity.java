package xyz.infralyx.deepstay;

import android.os.Build;
import android.os.Bundle;
import android.view.Display;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onResume() {
        super.onResume();
        requestHighestRefreshRate();
    }

    @SuppressWarnings("deprecation")
    private void requestHighestRefreshRate() {
        Display display = getWindowManager().getDefaultDisplay();
        Display.Mode current = display.getMode();
        Display.Mode best = current;
        for (Display.Mode mode : display.getSupportedModes()) {
            if (mode.getPhysicalWidth() == current.getPhysicalWidth()
                && mode.getPhysicalHeight() == current.getPhysicalHeight()
                && mode.getRefreshRate() > best.getRefreshRate()) {
                best = mode;
            }
        }
        WindowManager.LayoutParams attributes = getWindow().getAttributes();
        if (attributes.preferredDisplayModeId != best.getModeId()) {
            attributes.preferredDisplayModeId = best.getModeId();
            getWindow().setAttributes(attributes);
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LocalFilesPlugin.class);
        registerPlugin(ApkUpdatePlugin.class);
        registerPlugin(ProviderHttpPlugin.class);
        registerPlugin(CallAudioPlugin.class);
        super.onCreate(savedInstanceState);
        WebView webView = bridge.getWebView();
        WebSettings settings = webView.getSettings();
        // Chat text applies the system or app preference through the CSS scale.
        settings.setTextZoom(100);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            // Capacitor 7's edge-to-edge listener omits IME and consumes its insets.
            // Replace it, keeping one margin owner and using max(IME, navigation bar).
            ViewCompat.setOnApplyWindowInsetsListener(webView, (view, windowInsets) -> {
                Insets insets = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() |
                    WindowInsetsCompat.Type.displayCutout() |
                    WindowInsetsCompat.Type.ime()
                );
                ViewGroup.MarginLayoutParams margins = (ViewGroup.MarginLayoutParams) view.getLayoutParams();
                if (margins.leftMargin != insets.left || margins.topMargin != insets.top ||
                    margins.rightMargin != insets.right || margins.bottomMargin != insets.bottom) {
                    margins.setMargins(insets.left, insets.top, insets.right, insets.bottom);
                    view.setLayoutParams(margins);
                }
                return WindowInsetsCompat.CONSUMED;
            });
            ViewCompat.requestApplyInsets(webView);
        }
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                bridge.getWebView().evaluateJavascript(
                    "(() => { if (!document.querySelector('[role=dialog]')) return false; document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); return true; })()",
                    handled -> {
                        if ("true".equals(handled)) return;
                        if (bridge.getWebView().canGoBack()) bridge.getWebView().goBack();
                        else moveTaskToBack(true);
                    }
                );
            }
        });
    }
}
