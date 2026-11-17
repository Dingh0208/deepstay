package xyz.infralyx.deepstay;

import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LocalFilesPlugin.class);
        super.onCreate(savedInstanceState);
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
