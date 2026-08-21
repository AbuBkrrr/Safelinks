package com.aibrainsventures.safelinks;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Message;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;

/**
 * Adds target="_blank" / window.open() support on top of Capacitor's own
 * BridgeWebChromeClient (which this extends, so the mic-permission prompt
 * for voice notes and the native file picker for attachments both keep
 * working exactly as Capacitor already implements them — see
 * BridgeWebChromeClient in the Capacitor library itself).
 *
 * Without this override, a stock Android WebView does nothing at all when
 * a page opens a link in a new tab/window — which is how every
 * "view receipt" / "view attachment" link in SAFE_Links opens an uploaded
 * payment proof or support attachment. Rather than try to render a PDF or
 * image inside this app's own WebView (no zoom/pan chrome, no save
 * option), this hands the URL off to the device's own browser or
 * PDF/image viewer via a normal Intent, which is what most WebView-based
 * apps do for "leave the app" style links.
 */
public class ExternalLinkWebChromeClient extends BridgeWebChromeClient {

    private final Bridge bridge;

    public ExternalLinkWebChromeClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    @Override
    public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
        // Standard Android pattern for target="_blank": a throwaway WebView
        // is handed to the WebViewTransport so the WebView engine has
        // somewhere to put the new page; the FIRST navigation request it
        // gets is the actual target URL, which we intercept immediately
        // and hand off to a real Intent instead of ever letting this
        // temporary WebView load anything.
        WebView tempWebView = new WebView(view.getContext());
        tempWebView.setWebViewClient(
            new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView v, String url) {
                    openExternally(url);
                    return true;
                }
            }
        );

        WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
        transport.setWebView(tempWebView);
        resultMsg.sendToTarget();
        return true;
    }

    private void openExternally(String url) {
        try {
            bridge.getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(bridge.getContext(), "No app found to open that link", Toast.LENGTH_SHORT).show();
        }
    }
}
