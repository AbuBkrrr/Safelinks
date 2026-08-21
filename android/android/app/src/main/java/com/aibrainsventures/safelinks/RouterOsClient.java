package com.aibrainsventures.safelinks;

import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.concurrent.atomic.AtomicReference;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.X509TrustManager;

/**
 * Java port of RouterOsClient.kt - see that file's own doc comment
 * for the full trust-on-first-use (TOFU) design rationale, unchanged
 * here. Short version: RouterOS's REST API ships with a self-signed
 * cert by default, so normal certificate-chain validation can't apply
 * on a LAN device. The first connection in a pairing session records
 * the leaf cert's SHA-256 fingerprint; every connection after that,
 * within the same session, must present that exact fingerprint or the
 * request fails closed.
 */
final class RouterOsClient {

    private final String gatewayIp;
    private String pinnedFingerprint;

    RouterOsClient(String gatewayIp) {
        this.gatewayIp = gatewayIp;
    }

    String getPinnedFingerprint() {
        return pinnedFingerprint;
    }

    static abstract class RouterOsResult {}

    static final class Success extends RouterOsResult {
        final String body;
        Success(String body) { this.body = body; }
    }

    static final class HttpError extends RouterOsResult {
        final int code;
        final String body;
        HttpError(int code, String body) { this.code = code; this.body = body; }
    }

    static final class CertMismatch extends RouterOsResult {
        final String seenFingerprint;
        final String expectedFingerprint;
        CertMismatch(String seen, String expected) { this.seenFingerprint = seen; this.expectedFingerprint = expected; }
    }

    static final class NetworkError extends RouterOsResult {
        final String message;
        NetworkError(String message) { this.message = message; }
    }

    private SSLContext sslContextFor(String expectedFingerprint, AtomicReference<String> observedOut) throws Exception {
        X509TrustManager trustManager = new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) {}

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                if (chain == null || chain.length == 0) {
                    throw new CertificateException("No certificate presented by " + gatewayIp);
                }
                String fp = sha256Fingerprint(chain[0]);
                observedOut.set(fp);
                if (expectedFingerprint != null && !fp.equals(expectedFingerprint)) {
                    // Fail closed: don't complete the handshake on mismatch.
                    throw new CertificateException("Certificate fingerprint changed since first probe");
                }
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        };

        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, new X509TrustManager[]{trustManager}, new SecureRandom());
        return ctx;
    }

    private static String sha256Fingerprint(X509Certificate cert) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] hash = digest.digest(cert.getEncoded());
        StringBuilder sb = new StringBuilder();
        for (byte b : hash) {
            if (sb.length() > 0) sb.append(':');
            sb.append(String.format("%02X", b));
        }
        return sb.toString();
    }

    private HttpsURLConnection openConnection(String path, String expectedFingerprint, AtomicReference<String> observedOut) throws Exception {
        URL url = new URL("https://" + gatewayIp + path);
        HttpsURLConnection conn = (HttpsURLConnection) url.openConnection();
        conn.setSSLSocketFactory(sslContextFor(expectedFingerprint, observedOut).getSocketFactory());
        // Local LAN devices are addressed by IP, not a hostname a cert
        // could ever legitimately match - the fingerprint check above
        // is the real trust boundary here, not hostname verification.
        conn.setHostnameVerifier(new HostnameVerifier() {
            @Override
            public boolean verify(String hostname, javax.net.ssl.SSLSession session) {
                return true;
            }
        });
        conn.setConnectTimeout(4000);
        conn.setReadTimeout(8000);
        return conn;
    }

    private static String readStream(InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        return out.toString("UTF-8");
    }

    private static String basicAuth(String user, String pass) {
        String token = Base64.encodeToString((user + ":" + pass).getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        return "Basic " + token;
    }

    /**
     * First call of a pairing session. Confirms something is listening
     * and speaking RouterOS's REST API, and captures the cert
     * fingerprint for the person pairing to confirm before anything
     * that changes router configuration happens.
     */
    RouterOsResult probe(String adminUser, String adminPass) {
        AtomicReference<String> observed = new AtomicReference<>(null);
        try {
            HttpsURLConnection conn = openConnection("/rest/system/resource", null, observed);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Authorization", basicAuth(adminUser, adminPass));
            int code = conn.getResponseCode();
            String body = readStream(code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream());

            if (observed.get() != null) pinnedFingerprint = observed.get();

            if (code < 200 || code >= 300) return new HttpError(code, body);
            if (!body.contains("\"board-name\"") && !body.contains("\"version\"")) {
                return new HttpError(code, "Response didn't look like RouterOS: " + body);
            }
            return new Success(body);
        } catch (CertificateException e) {
            return new NetworkError("TLS handshake failed: " + e.getMessage());
        } catch (Exception e) {
            return new NetworkError(e.getMessage() != null ? e.getMessage() : e.toString());
        }
    }

    /**
     * Runs a script via POST /rest/execute. Must be called after
     * probe() succeeded and the fingerprint was confirmed by whoever's
     * pairing - pass that confirmed fingerprint as expectedFingerprint
     * so this call fails closed if the cert changed in between.
     */
    RouterOsResult execute(String script, String adminUser, String adminPass, String expectedFingerprint) {
        AtomicReference<String> observed = new AtomicReference<>(null);
        try {
            HttpsURLConnection conn = openConnection("/rest/execute", expectedFingerprint, observed);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Authorization", basicAuth(adminUser, adminPass));
            conn.setRequestProperty("Content-Type", "application/json");

            String payload = "{\"script\": " + jsonString(script) + "}";
            try (OutputStream os = conn.getOutputStream()) {
                os.write(payload.getBytes(StandardCharsets.UTF_8));
            }

            int code = conn.getResponseCode();
            String body = readStream(code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream());

            if (code < 200 || code >= 300) return new HttpError(code, body);
            return new Success(body);
        } catch (CertificateException e) {
            return new CertMismatch(observed.get() != null ? observed.get() : "", expectedFingerprint);
        } catch (Exception e) {
            return new NetworkError(e.getMessage() != null ? e.getMessage() : e.toString());
        }
    }

    private static String jsonString(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append("\"");
        return sb.toString();
    }
}
