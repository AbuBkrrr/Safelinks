package com.aibrainsventures.safelinks;

import java.util.regex.Pattern;

/**
 * The router setup script lives only on the SAFE_Links backend
 * (GET /api/setup/<CODE>.rsc). Every installer, this app included, runs the
 * same one line on the router, so an old or shared copy of this app still
 * applies today's script.
 */
final class RouterOsScripts {
    /** Backend serving the setup script. */
    static final String BACKEND_URL = "https://safelinks.name.ng";

    private static final Pattern PAIRING_CODE_RE = Pattern.compile("^[A-Z0-9]{4,10}$");

    private RouterOsScripts() {}

    static final class InvalidPairingCodeException extends IllegalArgumentException {
        InvalidPairingCodeException(String code) {
            super("Pairing code has an unexpected format: " + code);
        }
    }

    static String buildSetupCommand(String pairingCode, String apiBaseUrl) {
        String code = pairingCode == null ? "" : pairingCode.trim().toUpperCase();
        if (!PAIRING_CODE_RE.matcher(code).matches()) throw new InvalidPairingCodeException(pairingCode);
        String api = apiBaseUrl.replaceAll("/+$", "");
        return "/tool fetch url=\"" + api + "/api/setup/" + code + ".rsc\" dst-path=safelinks-setup.rsc check-certificate=no; :delay 2s; /import safelinks-setup.rsc";
    }
}
