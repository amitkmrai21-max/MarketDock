package com.marketdock.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.net.URISyntaxException;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (bridge == null) return; // device without a WebView — nothing to hook
        // Handle Android "intent://" links (e.g. "Chart on TradingView"): open
        // the target app when it's installed, otherwise its
        // S.browser_fallback_url in the browser — the same thing Chrome does.
        // Capacitor on its own would hand the raw intent:// URL to
        // ACTION_VIEW, which nothing resolves, so the tap would do nothing.
        bridge.setWebViewClient(
            new BridgeWebViewClient(bridge) {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    Uri url = request.getUrl();
                    if ("intent".equals(url.getScheme())) {
                        openIntentUrl(url.toString());
                        return true;
                    }
                    return super.shouldOverrideUrlLoading(view, request);
                }
            }
        );
    }

    private void openIntentUrl(String intentUrl) {
        Intent intent;
        try {
            intent = Intent.parseUri(intentUrl, Intent.URI_INTENT_SCHEME);
        } catch (URISyntaxException e) {
            return;
        }
        String fallbackUrl = intent.getStringExtra("browser_fallback_url");
        // Only let a web link open an ordinary browsable app screen.
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        intent.setComponent(null);
        intent.setSelector(null);
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException | SecurityException e) {
            if (fallbackUrl == null) return;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(fallbackUrl)));
            } catch (ActivityNotFoundException ignored) {
                // No browser at all — nothing more to try.
            }
        }
    }
}
