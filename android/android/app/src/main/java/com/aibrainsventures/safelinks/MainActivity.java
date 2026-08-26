package com.aibrainsventures.safelinks;

import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

/**
 * One app, one login system - a person signs in once and lands on
 * their own dashboard based on their account role, same as the
 * website. On top of that, this Activity also handles which of two
 * entry points to load: the site root (Reseller/Admin) or /install
 * (the router-pairing wizard) - see PickerActivity for why that
 * choice needs a native screen at all (short version: there's no
 * address bar in a Capacitor WebView, and the web app's own /install
 * link is plain text, not a tappable link - confirmed against
 * frontend/src/App.jsx's Landing component).
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Capacitor plugins must be registered before super.onCreate(),
        // which is where the Bridge (and its WebView) actually gets
        // built.
        registerPlugin(RouterLanPairingPlugin.class);

        super.onCreate(savedInstanceState);

        // The web app opens "view receipt" / "view attachment" links (payment
        // proofs, support-ticket attachments) with target="_blank" — a plain
        // Android WebView silently does nothing with those unless something
        // handles onCreateWindow, AND setSupportMultipleWindows(true) is
        // set (Capacitor's own Bridge does not enable this by default —
        // without it, onCreateWindow never fires at all, regardless of
        // what WebChromeClient is installed). ExternalLinkWebChromeClient
        // adds the onCreateWindow handling (opens the link in the device's
        // own browser/PDF/image viewer) while extending Capacitor's own
        // BridgeWebChromeClient, so everything Capacitor already handles by
        // default — the mic permission prompt for voice notes, the native
        // file picker for attachments, JS alerts/confirms — keeps working
        // unchanged.
        this.bridge.getWebView().getSettings().setSupportMultipleWindows(true);
        this.bridge.getWebView().setWebChromeClient(new ExternalLinkWebChromeClient(this.bridge));

        // Capacitor's BridgeActivity does NOT handle the hardware/gesture
        // back button at all — without this, pressing back at ANY point
        // (mid-way through the Captive Portal's plan -> pay -> confirm
        // flow, a half-filled signup form, a support ticket reply box)
        // would immediately exit the whole app instead of stepping back
        // within it, which is what every other back button everywhere
        // else on the phone does. This makes back navigate the WebView's
        // own history first, and only actually exits the app once
        // there's no WebView history left to go back to.
        getOnBackPressedDispatcher().addCallback(
            this,
            new OnBackPressedCallback(true) {
                @Override
                public void handleOnBackPressed() {
                    if (bridge.getWebView().canGoBack()) {
                        bridge.getWebView().goBack();
                    } else {
                        setEnabled(false);
                        getOnBackPressedDispatcher().onBackPressed();
                    }
                }
            }
        );

        applyModeFromIntent(getIntent());
        addSwitchModeButton();
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        applyModeFromIntent(intent);
    }

    /**
     * Capacitor's own Bridge auto-loads capacitor.config.json's
     * server.url (the site root) during super.onCreate() above. If the
     * chosen mode is "installer", override that with a load of
     * /install right away — this causes one extra, essentially
     * instant, superseded request to root before the real page loads,
     * which is an accepted tradeoff for not needing to fork Capacitor's
     * own bridge-initialization code just to change the first URL.
     * If the mode is reseller_admin (or unset), Capacitor's own default
     * load already matches, so there's nothing to override.
     */
    private void applyModeFromIntent(Intent intent) {
        String mode = intent.getStringExtra(PickerActivity.EXTRA_MODE);
        if (PickerActivity.MODE_INSTALLER.equals(mode)) {
            String base = bridge.getServerUrl();
            if (base != null) {
                String url = base.endsWith("/") ? base + "install" : base + "/install";
                bridge.getWebView().loadUrl(url);
            }
        }
        // MODE_RESELLER_ADMIN (or no mode extra at all, e.g. Capacitor's
        // own splash-screen relaunch path): nothing to do, Capacitor's
        // default root load already matches.
    }

    /**
     * MainActivity runs under AppTheme.NoActionBarLaunch (parent
     * Theme.SplashScreen - see AndroidManifest.xml) for its entire
     * lifetime, not just during the splash screen, so there's no
     * ActionBar/Toolbar to host a standard Options Menu overflow
     * button - one would exist in code but be unreachable by any
     * visible UI on a modern phone. A small floating button added
     * directly to the activity's root content view sidesteps that
     * without touching Capacitor's own layout/WebView setup at all.
     */
    private void addSwitchModeButton() {
        Button button = new Button(this);
        button.setText(getString(R.string.menu_switch_mode));
        button.setTextColor(Color.WHITE);
        button.setTextSize(12f);
        button.setAllCaps(false);
        button.setPadding(dp(14), dp(6), dp(14), dp(6));

        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.parseColor("#CC000000"));
        background.setCornerRadius(dp(16));
        button.setBackground(background);

        button.setOnClickListener(v -> {
            Intent intent = new Intent(this, PickerActivity.class);
            intent.putExtra(PickerActivity.EXTRA_FORCE_SHOW, true);
            startActivity(intent);
        });

        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.gravity = Gravity.TOP | Gravity.END;
        params.topMargin = dp(40);
        params.setMarginEnd(dp(16));

        ((ViewGroup) findViewById(android.R.id.content)).addView(button, params);
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics());
    }
}
