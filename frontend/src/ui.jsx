import React from "react";
import { ChevronRight, Landmark, Hash, Upload, Radio, LogOut, Loader2, CheckCircle2 } from "lucide-react";
import VoiceAssistant from "./VoiceAssistant.jsx";
import { dt, dtMatch } from "./dashboardI18n.js";

/* ============================================================
   DESIGN TOKENS
   Brand spec: #667eea / #764ba2 / #48bb78 / #f6ad55 / #fc8181
   ============================================================ */
export const T = {
  primary: "#667eea",
  primaryDark: "#5a67d8",
  secondary: "#764ba2",
  success: "#48bb78",
  warning: "#f6ad55",
  danger: "#fc8181",
  bg: "#f0f2f5",
  card: "#ffffff",
  ink: "#1f2433",
  sub: "#6b7488",
  border: "#e4e7ee",
};

export function timeAgo(ts) {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  const h = Math.floor(diff / 3600000);
  if (diff < 60000) return "just now";
  if (h < 1) return `${Math.floor(diff / 60000)}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/* ============================================================
   CURRENCY — what a reseller charges their own end-users. This is
   separate from the Super Admin's platform license fee, which stays
   in USD regardless (a fixed platform-to-reseller billing relationship,
   not something a reseller localizes). Kept in sync with the backend's
   validation set in reslink-backend/src/routes/reseller.js.
   ============================================================ */
export const CURRENCIES = [
  { code: "USD", symbol: "$", label: "US Dollar (USD)" },
  { code: "NGN", symbol: "₦", label: "Nigerian Naira (NGN)" },
  { code: "KES", symbol: "KSh", label: "Kenyan Shilling (KES)" },
  { code: "UGX", symbol: "USh", label: "Ugandan Shilling (UGX)" },
  { code: "GHS", symbol: "GH₵", label: "Ghanaian Cedi (GHS)" },
  { code: "ZAR", symbol: "R", label: "South African Rand (ZAR)" },
  { code: "TZS", symbol: "TSh", label: "Tanzanian Shilling (TZS)" },
  { code: "XOF", symbol: "CFA", label: "West African CFA Franc (XOF)" },
  { code: "EUR", symbol: "€", label: "Euro (EUR)" },
  { code: "GBP", symbol: "£", label: "British Pound (GBP)" },
];
export function currencySymbol(code) {
  return CURRENCIES.find((c) => c.code === code)?.symbol || code || "$";
}
export function formatMoney(amount, code) {
  const n = Number(amount);
  const formatted = Number.isFinite(n) ? (Number.isInteger(n) ? String(n) : n.toFixed(2)) : String(amount ?? "");
  return `${currencySymbol(code)}${formatted}`;
}

export const statusColor = (s) => ({
  active: T.success, completed: T.success, connected: T.success, confirmed: T.success, resolved: T.success,
  online: T.success, delivered: T.success, executed: T.success,
  pending: T.warning, disconnected: T.sub, open: T.warning, paused: T.warning,
  suspended: T.danger, failed: T.danger, expired: T.danger, rejected: T.danger, offline: T.danger,
}[s] || T.sub);

export function Badge({ children, tone = T.sub }) {
  return (
    <span style={{
      background: `${tone}1a`, color: tone, border: `1px solid ${tone}33`,
      padding: "2px 10px", borderRadius: 20, fontSize: 12, fontWeight: 600,
      display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap",
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: tone }} />
      {children}
    </span>
  );
}

export function StatCard({ icon: Icon, label, value, sub, tone = T.primary }) {
  return (
    <div style={{
      background: T.card, borderRadius: 12, padding: "18px 20px", flex: 1,
      border: `1px solid ${T.border}`, boxShadow: "0 1px 2px rgba(20,20,43,0.04)",
      minWidth: 160,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 12.5, color: T.sub, fontWeight: 600, marginBottom: 6 }}>{label}</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: T.ink, lineHeight: 1 }}>{value}</div>
          {sub && <div style={{ fontSize: 12, color: T.sub, marginTop: 6 }}>{sub}</div>}
        </div>
        <div style={{
          width: 36, height: 36, borderRadius: 9, background: `${tone}18`,
          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
        }}>
          <Icon size={18} color={tone} />
        </div>
      </div>
    </div>
  );
}

export function Panel({ title, action, children, style }) {
  return (
    <div style={{
      background: T.card, borderRadius: 12, border: `1px solid ${T.border}`,
      boxShadow: "0 1px 2px rgba(20,20,43,0.04)", overflow: "hidden", ...style,
    }}>
      {title && (
        <div style={{
          padding: "14px 18px", borderBottom: `1px solid ${T.border}`,
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <div style={{ fontWeight: 700, fontSize: 14.5, color: T.ink }}>{title}</div>
          {action}
        </div>
      )}
      <div style={{ padding: 18 }}>{children}</div>
    </div>
  );
}

export function Btn({ children, onClick, tone = T.primary, variant = "solid", size = "md", disabled, style, type = "button" }) {
  const pad = size === "sm" ? "6px 12px" : "9px 16px";
  const fontSize = size === "sm" ? 12.5 : 13.5;
  const base = {
    border: "none", borderRadius: 7, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer",
    padding: pad, fontSize, display: "inline-flex", alignItems: "center", gap: 6,
    transition: "transform .12s ease, opacity .12s ease", opacity: disabled ? 0.5 : 1,
  };
  const styles = {
    solid: { background: tone, color: "#fff" },
    soft: { background: `${tone}16`, color: tone },
    outline: { background: "transparent", color: tone, border: `1px solid ${tone}55` },
    ghost: { background: "transparent", color: T.sub },
  };
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      onMouseDown={(e) => !disabled && (e.currentTarget.style.transform = "scale(0.97)")}
      onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
      style={{ ...base, ...styles[variant], ...style }}
    >
      {children}
    </button>
  );
}

export function Field({ label, children, hint }) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: T.sub, marginBottom: 6 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: T.sub, marginTop: 4 }}>{hint}</div>}
    </label>
  );
}

export const inputStyle = {
  width: "100%", padding: "9px 12px", borderRadius: 7, border: `1px solid ${T.border}`,
  fontSize: 13.5, color: T.ink, background: "#fbfbfd", outline: "none", boxSizing: "border-box",
};

export function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div role="status" aria-live="polite" style={{
      position: "fixed", top: 18, left: "50%", transform: "translateX(-50%)", zIndex: 1000,
      background: T.ink, color: "#fff", padding: "10px 18px", borderRadius: 10, fontSize: 13,
      fontWeight: 600, boxShadow: "0 8px 24px rgba(0,0,0,0.2)", animation: "slideIn .2s ease",
    }}>
      {toast}
    </div>
  );
}

export function EmptyRow({ text }) {
  return <div style={{ padding: "26px 0", textAlign: "center", color: T.sub, fontSize: 13 }}>{text}</div>;
}

export function ErrorRow({ text }) {
  return (
    <div style={{ padding: "14px 4px", color: T.danger, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
      {text}
    </div>
  );
}

export function Loading({ text = "Loading…" }) {
  return <div style={{ padding: "26px 0", textAlign: "center", color: T.sub, fontSize: 13 }}>{text}</div>;
}

/* Reusable "pay via transfer / USSD + receipt reference" block. This is
   the ONLY payment path in the whole system — there is no gateway.
   bank/USSD details come straight from the reseller (or Super Admin,
   one level up) so the payer knows exactly who to pay and how much.

   `onUploadFile`, if passed, wires up a REAL file picker for the "Upload
   receipt" button (JPEG/PNG/WebP/PDF, 6MB cap — see
   reslink-backend/src/uploads.js): async (file) => { url, originalName }.
   Without it, the button silently does nothing — every caller here
   should pass it now that the upload endpoints exist. `receiptUrl` /
   `setReceiptUrl` track the uploaded file so the parent can include it
   in the final submit body. The text `reference` field stays required
   either way — a photo is additive proof, not a replacement for it. */
export function TransferPayBlock({
  payee, amount, method, setMethod, reference, setReference, onSubmit, submitLabel, submitting, methods,
  onUploadFile, receiptUrl, setReceiptUrl,
}) {
  const opts = methods || ["Bank Transfer", "USSD"];
  const fileInputRef = React.useRef(null);
  const [uploadState, setUploadState] = React.useState("idle"); // idle | uploading | done | error
  const [uploadError, setUploadError] = React.useState(null);
  const [uploadedName, setUploadedName] = React.useState(null);

  async function handleFilePicked(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow picking the same file again after an error
    if (!file || !onUploadFile) return;
    setUploadState("uploading");
    setUploadError(null);
    try {
      const result = await onUploadFile(file);
      setReceiptUrl?.(result.url);
      setUploadedName(file.name);
      setUploadState("done");
      // Convenience default: if the reference field is still empty,
      // pre-fill it with the photo's filename — still editable, and
      // still required to submit either way.
      if (!reference) setReference(file.name);
    } catch (err) {
      setUploadState("error");
      setUploadError(err.message || "Upload failed");
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {opts.map((m) => (
          <div key={m} onClick={() => setMethod(m)} style={{
            flex: 1, textAlign: "center", padding: "9px 8px", borderRadius: 8, cursor: "pointer",
            border: `1.5px solid ${method === m ? T.primary : T.border}`, fontSize: 12.5, fontWeight: 600,
            color: method === m ? T.primary : T.sub,
          }}>
            {m}
          </div>
        ))}
      </div>
      {method === "Bank Transfer" ? (
        <div style={{ background: T.bg, borderRadius: 10, padding: 14, marginBottom: 12, fontSize: 13 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, marginBottom: 8 }}>
            <Landmark size={14} color={T.primary} /> Transfer to {payee.name}'s account
          </div>
          <div style={{ color: T.sub, lineHeight: 1.9 }}>
            Bank: <b style={{ color: T.ink }}>{payee.bankName || "—"}</b><br />
            Account name: <b style={{ color: T.ink }}>{payee.accountName || "—"}</b><br />
            Account number: <b style={{ color: T.ink, fontFamily: "monospace" }}>{payee.accountNumber || "—"}</b><br />
            Amount: <b style={{ color: T.ink }}>{amount}</b>
          </div>
        </div>
      ) : (
        <div style={{ background: T.bg, borderRadius: 10, padding: 14, marginBottom: 12, fontSize: 13 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, marginBottom: 8 }}>
            <Hash size={14} color={T.primary} /> Dial USSD to pay {payee.name}
          </div>
          <div style={{ color: T.sub, lineHeight: 1.9 }}>
            Dial: <b style={{ color: T.ink, fontFamily: "monospace" }}>{payee.ussdCode || "—"}</b><br />
            Amount: <b style={{ color: T.ink }}>{amount}</b><br />
            Follow the prompts to complete payment, then enter the confirmation code below.
          </div>
        </div>
      )}
      <Field label={method === "Bank Transfer" ? "Receipt reference (or upload a photo)" : "USSD confirmation code"} hint="Verified by hand before anything activates — there's no automatic gateway.">
        <div style={{ display: "flex", gap: 8 }}>
          <input style={inputStyle} value={reference} onChange={(e) => setReference(e.target.value)}
            placeholder={method === "Bank Transfer" ? "e.g. Receipt_TXN88213.jpg" : "e.g. QWE123CONFIRM"} />
          {method === "Bank Transfer" && onUploadFile && (
            <>
              <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf"
                onChange={handleFilePicked} style={{ display: "none" }} />
              <button
                type="button"
                aria-label={uploadState === "uploading" ? "Uploading receipt…" : uploadState === "done" ? `Receipt uploaded: ${uploadedName}` : "Upload a photo of your receipt"}
                title={uploadState === "done" ? `Uploaded: ${uploadedName}` : "Upload a photo of your receipt"}
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadState === "uploading"}
                style={{
                  ...inputStyle, width: 42, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                  cursor: uploadState === "uploading" ? "wait" : "pointer", padding: 0,
                  color: uploadState === "done" ? T.success : uploadState === "error" ? T.danger : T.sub,
                  border: `1px solid ${uploadState === "done" ? T.success : uploadState === "error" ? T.danger : T.border}`,
                }}
              >
                {uploadState === "uploading" ? <Loader2 size={14} style={{ animation: "spin 0.8s linear infinite" }} /> : uploadState === "done" ? <CheckCircle2 size={14} /> : <Upload size={14} />}
              </button>
            </>
          )}
        </div>
        {uploadState === "done" && receiptUrl && (
          <div style={{ fontSize: 11.5, color: T.success, marginTop: 4 }}>
            Receipt attached ({uploadedName}) — <a href={receiptUrl} target="_blank" rel="noreferrer" style={{ color: T.success }}>view</a>
          </div>
        )}
        {uploadState === "error" && (
          <div style={{ fontSize: 11.5, color: T.danger, marginTop: 4 }}>{uploadError}</div>
        )}
      </Field>
      <Btn disabled={!reference || submitting} onClick={onSubmit} style={{ width: "100%", justifyContent: "center", padding: "10px 0" }}>
        {submitting ? "Submitting…" : submitLabel}
      </Btn>
    </div>
  );
}

/* ============================================================
   NAV SHELL — sidebar + topbar shared by the two dashboards
   ============================================================ */
export function Shell({ roleLabel, roleIcon: RoleIcon, tone, identity, tabs, active, onTab, onExit, exitLabel, badges, notifications, dashboardLang, children }) {
  const lang = dashboardLang || "en";
  const voiceCommands = [
    ...tabs.map((t) => ({
      match: [t.label.toLowerCase()],
      label: dt(lang, "voiceOpeningTab", { tab: t.label }),
      run: () => { onTab(t.key); return dt(lang, "voiceOpeningTab", { tab: t.label }); },
    })),
    {
      match: dtMatch(lang, "voiceMatchNotifications"),
      label: dt(lang, "voiceReadingNotifs"),
      run: () => {
        const unread = (notifications || []).filter((n) => !n.read);
        if (unread.length === 0) return dt(lang, "voiceNoUnread");
        const spoken = unread.slice(0, 5).map((n) => n.title).join(". ");
        return unread.length === 1
          ? dt(lang, "voiceUnreadOne", { list: spoken })
          : dt(lang, "voiceUnreadMany", { count: unread.length, list: spoken });
      },
    },
    { match: dtMatch(lang, "voiceMatchLogout"), label: dt(lang, "voiceLoggingOut"), run: () => { setTimeout(onExit, 400); return dt(lang, "voiceLoggingOut"); } },
    {
      match: dtMatch(lang, "voiceMatchHelp"),
      label: dt(lang, "voiceHelpLabel"),
      run: () => dt(lang, "voiceDashHelp", { tabs: tabs.slice(0, 4).map((t) => `"${t.label}"`).join(", ") }),
    },
  ];

  return (
    <div style={{ minHeight: "100%", background: T.bg, fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif" }}>
      <a href="#main-content" style={{
        position: "absolute", left: -9999, top: 0, background: T.ink, color: "#fff", padding: "10px 16px",
        borderRadius: 8, zIndex: 2000,
      }} onFocus={(e) => { e.currentTarget.style.left = "12px"; e.currentTarget.style.top = "12px"; }}
        onBlur={(e) => { e.currentTarget.style.left = "-9999px"; }}>
        Skip to main content
      </a>
      <div style={{
        background: T.card, borderBottom: `1px solid ${T.border}`, padding: "0 22px",
        display: "flex", alignItems: "center", justifyContent: "space-between", height: 58,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8, background: `linear-gradient(135deg, ${T.primary}, ${T.secondary})`,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <Radio size={17} color="#fff" />
          </div>
          <div style={{ fontWeight: 700, fontSize: 14.5, color: T.ink }}>SAFE_Links</div>
          <ChevronRight size={14} color={T.sub} />
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: tone, fontWeight: 600, fontSize: 13 }}>
            <RoleIcon size={14} /> {roleLabel}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ fontSize: 12.5, color: T.sub }}>{identity}</div>
          <Btn variant="ghost" size="sm" onClick={onExit}><LogOut size={14} /> {exitLabel || "Log out"}</Btn>
        </div>
      </div>
      <div style={{ display: "flex" }}>
        <nav aria-label="Dashboard sections" style={{
          width: 196, borderRight: `1px solid ${T.border}`, padding: "16px 10px",
          minHeight: "calc(100vh - 58px)", background: T.card, overflowY: "auto",
        }}>
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => onTab(t.key)}
              aria-current={active === t.key ? "page" : undefined}
              aria-label={badges?.[t.key] > 0 ? `${t.label}, ${badges[t.key]} unread` : t.label}
              style={{
                width: "100%", border: "none", textAlign: "left",
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 9, padding: "9px 12px", borderRadius: 8,
                fontSize: 13, fontWeight: 600, cursor: "pointer", marginBottom: 3,
                color: active === t.key ? tone : T.sub,
                background: active === t.key ? `${tone}14` : "transparent",
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 9 }}><t.icon size={15} /> {t.label}</span>
              {badges?.[t.key] > 0 && (
                <span aria-hidden="true" style={{ background: T.danger, color: "#fff", fontSize: 10.5, fontWeight: 700, borderRadius: 10, padding: "1px 6px" }}>
                  {badges[t.key]}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div id="main-content" style={{ flex: 1, padding: 22, maxWidth: 1180 }}>{children}</div>
      </div>
      <VoiceAssistant
        commands={voiceCommands}
        lang={lang}
        greeting={dt(lang, "voiceDashGreeting")}
      />
    </div>
  );
}

/* Reusable file/voice-note attachment control for support forms — the
   Captive Portal's "Need help?" form, a reseller's tickets to Super
   Admin, a reseller's replies to a customer, and Super Admin's replies
   to a reseller. Two ways in: pick a file (image/PDF), or record a
   voice note right in the browser via MediaRecorder — useful for
   anyone who'd rather explain a WiFi problem out loud than type it.
   `onUpload` — async (file: File|Blob, mimeType, filename) => { url }.
   Once attached, shows a small "attached" chip with a remove (×). */
export function AttachmentPicker({ onUpload, attachmentUrl, setAttachmentUrl, lang = "en" }) {
  const fileInputRef = React.useRef(null);
  const mediaRecorderRef = React.useRef(null);
  const chunksRef = React.useRef([]);
  const [state, setState] = React.useState("idle"); // idle | uploading | done | error | recording
  const [error, setError] = React.useState(null);
  const [attachedLabel, setAttachedLabel] = React.useState(null);

  async function upload(blob, mimeType, filename) {
    setState("uploading");
    setError(null);
    try {
      const result = await onUpload(blob, mimeType, filename);
      setAttachmentUrl?.(result.url);
      setAttachedLabel(filename);
      setState("done");
    } catch (err) {
      setState("error");
      setError(err.message || "Upload failed");
    }
  }

  function handleFilePicked(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    upload(file, file.type, file.name);
  }

  async function toggleRecording() {
    if (state === "recording") {
      mediaRecorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ["audio/webm", "audio/ogg", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported?.(t)) || "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        upload(blob, blob.type, "voice-note");
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setState("recording");
    } catch {
      setState("error");
      setError("Couldn't access the microphone — check your browser's permission for this site.");
    }
  }

  function clearAttachment() {
    setAttachmentUrl?.(null);
    setAttachedLabel(null);
    setState("idle");
  }

  if (state === "done" && attachmentUrl) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: T.success, marginTop: 6 }}>
        <Paperclip size={12} />
        <a href={attachmentUrl} target="_blank" rel="noreferrer" style={{ color: T.success }}>{attachedLabel || "Attachment"}</a>
        <button type="button" onClick={clearAttachment} aria-label="Remove attachment"
          style={{ background: "none", border: "none", cursor: "pointer", color: T.sub, padding: 0, display: "flex" }}>
          <X size={12} />
        </button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf"
          onChange={handleFilePicked} style={{ display: "none" }} />
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={state === "uploading" || state === "recording"}
          style={{
            display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: T.sub, background: "none",
            border: `1px solid ${T.border}`, borderRadius: 7, padding: "5px 10px", cursor: "pointer",
          }}>
          <Paperclip size={12} /> Attach file
        </button>
        <button type="button" onClick={toggleRecording} disabled={state === "uploading"}
          style={{
            display: "flex", alignItems: "center", gap: 5, fontSize: 12, cursor: "pointer", borderRadius: 7, padding: "5px 10px",
            color: state === "recording" ? "#fff" : T.sub,
            background: state === "recording" ? T.danger : "none",
            border: `1px solid ${state === "recording" ? T.danger : T.border}`,
          }}>
          <Mic size={12} /> {state === "recording" ? "Stop recording" : "Record voice note"}
        </button>
        {state === "uploading" && <span style={{ fontSize: 12, color: T.sub }}>Uploading…</span>}
      </div>
      {error && <div style={{ fontSize: 11.5, color: T.danger, marginTop: 4 }}>{error}</div>}
    </div>
  );
}

export function GlobalStyle() {
  return (
    <style>{`
      * { box-sizing: border-box; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes blink { 50% { opacity: 0; } }
      @keyframes slideIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
      table { border-collapse: collapse; }
      input:focus, select:focus, textarea:focus { border-color: ${T.primary} !important; }
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-thumb { background: #d6d9e2; border-radius: 4px; }
    `}</style>
  );
}
