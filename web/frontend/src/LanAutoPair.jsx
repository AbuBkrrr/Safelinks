/**
 * LAN router auto-pairing UI — lets someone pair a MikroTik router
 * without typing the pairing code into the router's console by hand,
 * if the device running this app is on the same network as the
 * router. Renders nothing at all unless a native bridge is actually
 * present (Capacitor's RouterLanPairing plugin on Android, or
 * window.ReslinkNative on the Electron desktop app) — on a plain
 * browser, PWA, or iOS, this component is a no-op, and the existing
 * manual/human-typed pairing flow above it is the only option, same
 * as before this existed.
 *
 * Both native bridges are genuinely Promise-based (Capacitor's own
 * call/resolve plugin convention, and Electron's ipcRenderer.invoke /
 * ipcMain.handle pattern), so this component doesn't need the
 * fire-and-forget-plus-global-callback adapter an earlier, separate
 * standalone Kotlin/raw-WebView Android app needed (raw
 * addJavascriptInterface methods there could only return synchronous
 * primitives to JS, not real Promises — that constraint doesn't apply
 * to either bridge this component actually talks to).
 *
 * See RouterLanPairingPlugin.java (Android) / routerOsClient.js +
 * routerOsScripts.js (Electron) for the actual implementation and the
 * trust-on-first-use security model — this component only drives that
 * two-step protocol (probe, then confirm-and-pair), it doesn't
 * implement any of the trust logic itself.
 */

import React, { useState } from "react";
import { Wifi, Loader2, CheckCircle2 } from "lucide-react";
import { T, Btn, Field, inputStyle } from "./ui.jsx";

function getNativeBridge() {
  if (typeof window === "undefined") return null;

  // Capacitor (Android): object-arg calls, e.g.
  // RouterLanPairing.probe({ adminUser, adminPass }).
  const capPlugin = window.Capacitor?.Plugins?.RouterLanPairing;
  if (window.Capacitor?.isNativePlatform?.() && capPlugin) {
    return {
      probe: (adminUser, adminPass) => capPlugin.probe({ adminUser, adminPass }),
      pairWithConfirmedFingerprint: (pairingCode, adminUser, adminPass, confirmedFingerprint) =>
        capPlugin.pairWithConfirmedFingerprint({ pairingCode, adminUser, adminPass, confirmedFingerprint }),
    };
  }

  // Electron desktop: positional-arg calls via window.ReslinkNative
  // (see desktop-app/src/preload.js).
  if (window.ReslinkNative?.probe) {
    return {
      probe: (adminUser, adminPass) => window.ReslinkNative.probe(adminUser, adminPass),
      pairWithConfirmedFingerprint: (pairingCode, adminUser, adminPass, confirmedFingerprint) =>
        window.ReslinkNative.pairWithConfirmedFingerprint(pairingCode, adminUser, adminPass, confirmedFingerprint),
    };
  }

  return null;
}

export default function LanAutoPair({ code, onPaired }) {
  // idle -> credentials -> probing -> confirm -> pairing -> done | error
  const [stage, setStage] = useState("idle");
  const [adminUser, setAdminUser] = useState("admin");
  const [adminPass, setAdminPass] = useState("");
  const [fingerprint, setFingerprint] = useState(null);
  const [gatewayIp, setGatewayIp] = useState(null);
  const [error, setError] = useState(null);

  const bridge = getNativeBridge();
  if (!bridge) return null;

  async function startProbe() {
    setError(null);
    setStage("probing");
    try {
      const result = await bridge.probe(adminUser, adminPass);
      // Capacitor rejects the promise on call.reject(); Electron
      // resolves with { ok: false, error } either way, normalize here
      // so the rest of this component only has one shape to handle.
      if (!result || result.ok === false) {
        throw new Error((result && result.error) || "Could not reach the router.");
      }
      setFingerprint(result.fingerprint);
      setGatewayIp(result.gatewayIp);
      setStage("confirm");
    } catch (err) {
      setError(err.message || "Could not reach the router.");
      setStage("credentials");
    }
  }

  async function confirmAndPair() {
    setStage("pairing");
    setError(null);
    try {
      const result = await bridge.pairWithConfirmedFingerprint(code, adminUser, adminPass, fingerprint);
      if (!result || result.ok === false) {
        throw new Error((result && result.error) || "Pairing failed.");
      }
      setStage("done");
      onPaired?.();
    } catch (err) {
      setError(err.message || "Pairing failed.");
      setStage("credentials");
    }
  }

  return (
    <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px dashed ${T.border}`, textAlign: "left" }}>
      {stage === "idle" && (
        <div
          onClick={() => setStage("credentials")}
          style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", color: T.primary, fontSize: 12.5, fontWeight: 600, justifyContent: "center" }}
        >
          <Wifi size={14} /> On the same network as the router? Pair automatically — no typing required
        </div>
      )}

      {stage === "credentials" && (
        <>
          <div style={{ fontSize: 12, color: T.sub, marginBottom: 10, textAlign: "center" }}>
            Enter this router's admin login. It's only used for this pairing and isn't stored.
          </div>
          <Field label="Admin username">
            <input style={inputStyle} value={adminUser} onChange={(e) => setAdminUser(e.target.value)} />
          </Field>
          <Field label="Admin password">
            <input type="password" style={inputStyle} value={adminPass} onChange={(e) => setAdminPass(e.target.value)} />
          </Field>
          {error && <div style={{ fontSize: 12, color: T.danger, marginBottom: 10 }}>{error}</div>}
          <Btn size="sm" onClick={startProbe} style={{ width: "100%", justifyContent: "center" }}>
            Find router on this network
          </Btn>
        </>
      )}

      {stage === "probing" && (
        <div style={{ textAlign: "center", fontSize: 12.5, color: T.sub, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
          <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> Looking for a router at your gateway…
        </div>
      )}

      {stage === "confirm" && (
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 8 }}>
            Found a router at <span style={{ fontFamily: "monospace" }}>{gatewayIp}</span>.
            Check its certificate fingerprint matches the sticker on the device
            (or its RouterOS <code>/certificate print</code> output) before continuing:
          </div>
          <div style={{ fontFamily: "monospace", fontSize: 10.5, wordBreak: "break-all", background: T.bg, borderRadius: 8, padding: 10, marginBottom: 12 }}>
            {fingerprint}
          </div>
          {error && <div style={{ fontSize: 12, color: T.danger, marginBottom: 10 }}>{error}</div>}
          <Btn size="sm" onClick={confirmAndPair} style={{ width: "100%", justifyContent: "center" }}>
            Matches — pair this router
          </Btn>
        </div>
      )}

      {stage === "pairing" && (
        <div style={{ textAlign: "center", fontSize: 12.5, color: T.sub, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
          <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> Configuring the router…
        </div>
      )}

      {stage === "done" && (
        <div style={{ textAlign: "center", fontSize: 12.5, color: T.success, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
          <CheckCircle2 size={14} /> Sent — waiting for the router's first check-in above.
        </div>
      )}
    </div>
  );
}
