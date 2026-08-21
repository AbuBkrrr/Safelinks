import React, { useEffect, useRef, useState } from "react";
import { Router, CheckCircle2, ChevronRight, ChevronLeft, Loader2, Zap, Keyboard, Clock, Copy } from "lucide-react";
import { T, Btn, Field, inputStyle } from "./ui.jsx";
import { api } from "./api.js";
import LanAutoPair from "./LanAutoPair.jsx";

const MODELS = ["MikroTik hAP ac2", "MikroTik hAP ac3", "Ubiquiti EdgeRouter X", "TP-Link ER605", "Generic OpenWRT device"];

/* Two real paths, not a simulation of either:
 *
 * ZERO-TOUCH (MikroTik only, for now): generates a short-lived pairing
 * code via POST /api/reseller/pairing-codes, then polls
 * GET /api/reseller/pairing-codes/:code waiting for the router itself
 * to call POST /api/agent/register with it — see
 * reslink-backend/router-scripts/reslink-agent.rsc, a real RouterOS
 * script (written against documented syntax, not yet hardware-tested —
 * see that file's header). Nobody types in the router's model,
 * firmware, or IP; the router reports those itself.
 *
 * MANUAL (any other vendor, since only MikroTik has a script written
 * yet): the same POST /api/reseller/routers call as before — you type
 * in what you already know about the device.
 */
export default function InstallerWizard({ onComplete, embedded }) {
  const [mode, setMode] = useState(null); // null | 'pairing' | 'manual'

  return (
    <div style={{ width: "100%", maxWidth: 420, background: embedded ? "transparent" : T.card, border: embedded ? "none" : `1px solid ${T.border}`, borderRadius: embedded ? 0 : 14, padding: embedded ? 0 : 22 }}>
      {mode === null && <ModePicker onPick={setMode} />}
      {mode === "pairing" && <PairingFlow onComplete={onComplete} onBack={() => setMode(null)} />}
      {mode === "manual" && <ManualFlow onComplete={onComplete} onBack={() => setMode(null)} />}
    </div>
  );
}

function ModePicker({ onPick }) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <Router size={18} color={T.primary} />
        <div style={{ fontWeight: 700, fontSize: 14.5 }}>Add a router</div>
      </div>
      <div onClick={() => onPick("pairing")} style={{ border: `1.5px solid ${T.primary}`, borderRadius: 10, padding: 14, marginBottom: 10, cursor: "pointer" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 13.5, color: T.primary }}><Zap size={15} /> Pair automatically (MikroTik)</div>
        <div style={{ fontSize: 12, color: T.sub, marginTop: 4 }}>Recommended. You'll get a 6-character code to type into the router once — nothing else. The router reports its own model and firmware.</div>
      </div>
      <div onClick={() => onPick("manual")} style={{ border: `1.5px solid ${T.border}`, borderRadius: 10, padding: 14, cursor: "pointer" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 13.5 }}><Keyboard size={15} /> Enter details manually</div>
        <div style={{ fontSize: 12, color: T.sub, marginTop: 4 }}>For non-MikroTik routers, or if you'd rather configure the device yourself. You'll type in the model, firmware, and IP.</div>
      </div>
    </>
  );
}

function PairingFlow({ onComplete, onBack }) {
  const [code, setCode] = useState(null);
  const [expiresAt, setExpiresAt] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | pending | used | expired | error
  const [router, setRouter] = useState(null);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => {
    generateCode();
    return () => clearInterval(pollRef.current);
  }, []);

  async function generateCode() {
    setStatus("loading");
    setError(null);
    clearInterval(pollRef.current);
    try {
      const res = await api.reseller.createPairingCode();
      setCode(res.code);
      setExpiresAt(res.expiresAt);
      setStatus("pending");
      pollRef.current = setInterval(() => checkStatus(res.code), 3000);
    } catch (err) {
      setError(err.message);
      setStatus("error");
    }
  }

  async function checkStatus(c) {
    try {
      const res = await api.reseller.pairingCodeStatus(c);
      if (res.status === "used") {
        clearInterval(pollRef.current);
        setRouter(res.router);
        setStatus("used");
      } else if (res.status === "expired") {
        clearInterval(pollRef.current);
        setStatus("expired");
      }
    } catch { /* transient poll failure — next tick retries */ }
  }

  const minutesLeft = expiresAt ? Math.max(0, Math.round((expiresAt - Date.now()) / 60000)) : null;

  return (
    <>
      <Btn variant="ghost" size="sm" onClick={onBack} style={{ marginBottom: 14 }}><ChevronLeft size={13} /> Back</Btn>

      {status === "loading" && <div style={{ textAlign: "center", padding: "30px 0", color: T.sub, fontSize: 13 }}><Loader2 size={20} style={{ animation: "spin 1s linear infinite" }} /></div>}

      {status === "pending" && (
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 14 }}>On the router, run the SAFE_Links agent script and enter this code when it asks:</div>
          <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: 6, color: T.primary, background: T.bg, borderRadius: 12, padding: "18px 0", marginBottom: 10, fontFamily: "monospace" }}>{code}</div>
          <div style={{ fontSize: 11.5, color: T.sub, marginBottom: 18, display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}><Clock size={12} /> Expires in {minutesLeft} min</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: T.sub, fontSize: 12.5 }}>
            <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> Waiting for the router to check in…
          </div>
          <LanAutoPair code={code} onPaired={() => checkStatus(code)} />
        </div>
      )}

      {status === "used" && router && (
        <div style={{ textAlign: "center" }}>
          <CheckCircle2 size={40} color={T.success} style={{ marginBottom: 10 }} />
          <div style={{ fontWeight: 700, fontSize: 15.5, marginBottom: 4 }}>Router paired</div>
          <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 16 }}>{router.router_id} checked in — {router.model} running {router.firmware}. It's already syncing your active vouchers.</div>
          <Btn onClick={onComplete} style={{ width: "100%", justifyContent: "center", padding: "10px 0" }}>Done</Btn>
        </div>
      )}

      {status === "expired" && (
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 13, color: T.warning, fontWeight: 600, marginBottom: 10 }}>That code expired before the router checked in.</div>
          <Btn onClick={generateCode}>Generate a new code</Btn>
        </div>
      )}

      {status === "error" && (
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 13, color: T.danger, marginBottom: 10 }}>{error}</div>
          <Btn onClick={generateCode}>Try again</Btn>
        </div>
      )}
    </>
  );
}

function ManualFlow({ onComplete, onBack }) {
  const [form, setForm] = useState({ model: MODELS[0], firmware: "", ssid: "", ip: "", location: "" });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [done, setDone] = useState(false);

  async function register() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.reseller.registerRouter(form);
      setResult(res);
      setDone(true);
    } catch (err) {
      setError(err.message || "Registration failed");
    }
    setSubmitting(false);
  }

  function copyKey() {
    if (result?.apiKey) {
      navigator.clipboard?.writeText(result.apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  }

  if (done && result) {
    return (
      <div style={{ textAlign: "center" }}>
        <CheckCircle2 size={40} color={T.success} style={{ marginBottom: 10 }} />
        <div style={{ fontWeight: 700, fontSize: 15.5, marginBottom: 4 }}>Router registered</div>
        <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 16 }}>
          This device isn't running the SAFE_Links agent, so you'll need to configure it yourself to poll <code>/api/router/checkin</code> — see the backend README's router check-in protocol.
        </div>
        <div style={{ background: T.bg, borderRadius: 10, padding: 14, textAlign: "left", fontSize: 12.5, marginBottom: 14 }}>
          <div style={{ color: T.sub, marginBottom: 4 }}>Router ID</div>
          <div style={{ fontFamily: "monospace", fontWeight: 700, marginBottom: 10 }}>{result.routerId}</div>
          <div style={{ color: T.sub, marginBottom: 4 }}>API key <span style={{ color: T.danger, fontWeight: 600 }}>(shown once — copy it now)</span></div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ fontFamily: "monospace", fontWeight: 700, wordBreak: "break-all", flex: 1 }}>{result.apiKey}</div>
            <Btn size="sm" variant="soft" onClick={copyKey}><Copy size={12} /> {copied ? "Copied" : "Copy"}</Btn>
          </div>
        </div>
        <Btn onClick={onComplete} style={{ width: "100%", justifyContent: "center", padding: "10px 0" }}>Done</Btn>
      </div>
    );
  }

  return (
    <>
      <Btn variant="ghost" size="sm" onClick={onBack} style={{ marginBottom: 14 }}><ChevronLeft size={13} /> Back</Btn>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <Router size={18} color={T.primary} />
        <div style={{ fontWeight: 700, fontSize: 14.5 }}>Router details</div>
      </div>
      <Field label="Router model">
        <select style={inputStyle} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
          {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>
      <Field label="Firmware version" hint="Check the device's admin page or its label">
        <input style={inputStyle} value={form.firmware} onChange={(e) => setForm({ ...form, firmware: e.target.value })} placeholder="e.g. RouterOS 7.14" />
      </Field>
      <Field label="WiFi network name (SSID)">
        <input style={inputStyle} value={form.ssid} onChange={(e) => setForm({ ...form, ssid: e.target.value })} placeholder="e.g. MyBusiness-WiFi" />
      </Field>
      <Field label="Router IP address">
        <input style={inputStyle} value={form.ip} onChange={(e) => setForm({ ...form, ip: e.target.value })} placeholder="e.g. 192.168.88.1" />
      </Field>
      <Field label="Install location">
        <input style={inputStyle} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="e.g. Front counter, Shop 4B" />
      </Field>
      {error && <div style={{ color: T.danger, fontSize: 12.5, marginBottom: 10 }}>{error}</div>}
      <Btn disabled={!form.firmware || !form.ssid || !form.ip || !form.location || submitting} onClick={register} style={{ width: "100%", justifyContent: "center", padding: "10px 0" }}>
        {submitting ? <><Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> Registering…</> : <>Register router <ChevronRight size={14} /></>}
      </Btn>
    </>
  );
}
