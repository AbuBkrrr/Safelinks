package com.aibrainsventures.safelinks;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Exposed to the web app as Capacitor.Plugins.RouterLanPairing -
 * Capacitor's idiomatic replacement for a raw addJavascriptInterface
 * bridge (which Capacitor already uses internally for its own bridge,
 * so a second one would conflict; plugins are the supported way to
 * add native capability alongside it). See RouterLanBridge.kt in the
 * standalone Kotlin app for the original, fuller design writeup - the
 * protocol and security model are identical here:
 *
 *   1. probe({ adminUser, adminPass }) -> Promise<{ ok, fingerprint,
 *      gatewayIp } | { ok: false, error }>
 *      Confirms there's a RouterOS device at the LAN gateway and
 *      captures its cert fingerprint. Changes nothing on the router.
 *
 *   2. pairWithConfirmedFingerprint({ pairingCode, adminUser,
 *      adminPass, confirmedFingerprint }) -> Promise<{ ok, routerId }
 *      | { ok: false, error }>
 *      Only proceeds if the router's cert still matches
 *      confirmedFingerprint at connection time.
 *
 * Router admin credentials are passed in per-call from the web app's
 * own form fields and held only in this plugin instance's memory for
 * the duration of a pairing session - never written to disk, never
 * defaulted to a blank/factory password.
 */
@CapacitorPlugin(name = "RouterLanPairing")
public class RouterLanPairingPlugin extends Plugin {

    private static final Pattern PAIRING_CODE_RE = Pattern.compile("^[A-Z0-9]{4,10}$");
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    // Keyed to one active session at a time, matching the standalone
    // app's design - a probe result can't accidentally be reused
    // against a different router than the one it was captured from.
    private RouterOsClient activeClient;
    private String activeGatewayIp;

    @PluginMethod
    public void probe(PluginCall call) {
        String adminUser = call.getString("adminUser", "");
        String adminPass = call.getString("adminPass", "");

        executor.execute(() -> {
            GatewayLocator.Result gateway = GatewayLocator.locate(getContext());
            if (gateway == null) {
                call.reject("Could not determine the LAN gateway. Are you connected to WiFi?");
                return;
            }
            if (!gateway.isWifi) {
                call.reject("Not connected to WiFi - automatic pairing needs to be on the same network as the router.");
                return;
            }

            RouterOsClient client = new RouterOsClient(gateway.gatewayIp);
            RouterOsClient.RouterOsResult result = client.probe(adminUser, adminPass);

            if (result instanceof RouterOsClient.Success) {
                activeClient = client;
                activeGatewayIp = gateway.gatewayIp;
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("gatewayIp", gateway.gatewayIp);
                ret.put("fingerprint", client.getPinnedFingerprint());
                call.resolve(ret);
            } else if (result instanceof RouterOsClient.HttpError) {
                RouterOsClient.HttpError e = (RouterOsClient.HttpError) result;
                call.reject("Router rejected the request (HTTP " + e.code + "). Check the admin username/password.");
            } else if (result instanceof RouterOsClient.NetworkError) {
                RouterOsClient.NetworkError e = (RouterOsClient.NetworkError) result;
                call.reject("Couldn't reach " + gateway.gatewayIp + ": " + e.message + ". Is the REST API (www-ssl) enabled on this router?");
            } else {
                call.reject("Unexpected certificate state during probe.");
            }
        });
    }

    @PluginMethod
    public void pairWithConfirmedFingerprint(PluginCall call) {
        String pairingCode = call.getString("pairingCode", "");
        String adminUser = call.getString("adminUser", "");
        String adminPass = call.getString("adminPass", "");
        String confirmedFingerprint = call.getString("confirmedFingerprint", "");

        executor.execute(() -> {
            RouterOsClient client = activeClient;
            String gatewayIp = activeGatewayIp;
            if (client == null || gatewayIp == null) {
                call.reject("No active probe session - call probe() first.");
                return;
            }
            if (client.getPinnedFingerprint() == null || !client.getPinnedFingerprint().equals(confirmedFingerprint)) {
                call.reject("Fingerprint you confirmed doesn't match what was probed - aborting rather than risk pairing the wrong device.");
                return;
            }
            if (!PAIRING_CODE_RE.matcher(pairingCode).matches()) {
                call.reject("Pairing code has an unexpected format.");
                return;
            }

            String apiBaseUrl = getBridge().getServerUrl();
            if (apiBaseUrl == null) {
                call.reject("Could not determine the app's server URL - is capacitor.config.json's server.url set?");
                return;
            }

            String installScript = RouterOsScripts.buildInstallCheckinScript(apiBaseUrl);
            RouterOsClient.RouterOsResult installResult = client.execute(installScript, adminUser, adminPass, confirmedFingerprint);
            if (!(installResult instanceof RouterOsClient.Success)) {
                call.reject("Could not install the check-in script: " + describe(installResult));
                return;
            }

            String registerScript;
            try {
                registerScript = RouterOsScripts.buildRegisterScript(pairingCode, apiBaseUrl);
            } catch (RouterOsScripts.InvalidPairingCodeException e) {
                call.reject(e.getMessage());
                return;
            }

            RouterOsClient.RouterOsResult registerResult = client.execute(registerScript, adminUser, adminPass, confirmedFingerprint);
            if (registerResult instanceof RouterOsClient.Success) {
                String body = ((RouterOsClient.Success) registerResult).body;
                String routerId = extractRouterId(body);
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("routerId", routerId);
                call.resolve(ret);
                // One-shot: clear session state so a stray extra call
                // can't silently reuse stale credentials/session state.
                activeClient = null;
                activeGatewayIp = null;
            } else {
                call.reject("Registration failed: " + describe(registerResult));
            }
        });
    }

    private static String extractRouterId(String body) {
        Pattern p = Pattern.compile("ROUTER_ID=(\\S+)");
        Matcher m = p.matcher(body);
        return m.find() ? m.group(1) : null;
    }

    private static String describe(RouterOsClient.RouterOsResult result) {
        if (result instanceof RouterOsClient.Success) return "ok";
        if (result instanceof RouterOsClient.HttpError) {
            RouterOsClient.HttpError e = (RouterOsClient.HttpError) result;
            String snippet = e.body.length() > 200 ? e.body.substring(0, 200) : e.body;
            return "HTTP " + e.code + ": " + snippet;
        }
        if (result instanceof RouterOsClient.NetworkError) return ((RouterOsClient.NetworkError) result).message;
        if (result instanceof RouterOsClient.CertMismatch) return "router's certificate changed since it was confirmed - aborted";
        return "unknown error";
    }
}
