package com.aibrainsventures.safelinks;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.widget.Button;

import androidx.appcompat.app.AppCompatActivity;

/**
 * Shown once, on first launch: "I'm a Reseller / Admin" vs "I'm
 * pairing a router". The web app itself only ever had two real
 * identities (see frontend/src/App.jsx) - Reseller and Super Admin
 * already share one login screen, and the router-pairing wizard is a
 * separate public route (/install) with no in-app link a Capacitor
 * WebView can actually tap (there's no address bar to type a URL
 * into - see this project's top-level README for how that was
 * confirmed). This screen is what makes /install reachable at all
 * from a cold app launch.
 *
 * The choice is remembered in SharedPreferences and MainActivity
 * reads it via the Intent extra below; the small "Switch mode" button
 * MainActivity adds on top of the WebView (see its addSwitchModeButton)
 * re-launches this screen with EXTRA_FORCE_SHOW=true, without clearing
 * the choice already stored - so tapping Back from a forced picker
 * just returns to whatever was already loaded, rather than the app
 * exiting or losing the session.
 */
public class PickerActivity extends AppCompatActivity {

    static final String PREFS_NAME = "safelinks_prefs";
    static final String KEY_MODE = "mode";
    static final String MODE_RESELLER_ADMIN = "reseller_admin";
    static final String MODE_INSTALLER = "installer";
    static final String EXTRA_MODE = "com.aibrainsventures.safelinks.MODE";
    static final String EXTRA_FORCE_SHOW = "com.aibrainsventures.safelinks.FORCE_SHOW";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        boolean forceShow = getIntent().getBooleanExtra(EXTRA_FORCE_SHOW, false);
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String savedMode = prefs.getString(KEY_MODE, null);

        if (savedMode != null && !forceShow) {
            // Normal cold launch with a mode already chosen - skip
            // straight to MainActivity, no picker flash. "Switch mode"
            // (MainActivity's overflow menu) sets forceShow=true
            // specifically to bypass this and show the picker for real.
            launchMain(savedMode);
            return;
        }

        setContentView(R.layout.activity_picker);

        Button resellerAdminButton = findViewById(R.id.buttonResellerAdmin);
        Button installerButton = findViewById(R.id.buttonInstaller);

        resellerAdminButton.setOnClickListener(v -> choose(prefs, MODE_RESELLER_ADMIN));
        installerButton.setOnClickListener(v -> choose(prefs, MODE_INSTALLER));
    }

    private void choose(SharedPreferences prefs, String mode) {
        prefs.edit().putString(KEY_MODE, mode).apply();
        launchMain(mode);
    }

    private void launchMain(String mode) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.putExtra(EXTRA_MODE, mode);
        startActivity(intent);
        finish();
    }
}
