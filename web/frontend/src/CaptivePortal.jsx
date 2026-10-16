import React, { useEffect, useState } from "react";
import { ChevronRight, ArrowLeft, Wifi, Clock, Mail, MessageCircle } from "lucide-react";
import { T, Btn, Field, inputStyle, TransferPayBlock, Loading, formatMoney, AttachmentPicker } from "./ui.jsx";
import { api, fileToBase64 } from "./api.js";
import { useResource } from "./hooks.js";
import { t } from "./i18n.js";

/* The end-user's ENTIRE experience. No login, no dashboard. There is no
   payment gateway anywhere in this system — Bank Transfer and USSD are
   the only methods, and both land as "pending" until the reseller
   manually verifies the transfer landed and confirms it (Pending
   Payments tab in the Reseller dashboard). Credentials are then sent to
   the customer by the reseller, by hand — nothing here auto-delivers
   anything. */
export default function CaptivePortal({ resellerId, notify, onExit }) {
  const info = useResource(() => api.portalInfo(resellerId), [resellerId]);
  const plansRes = useResource(() => api.portalPlans(resellerId), [resellerId], (r) => r.plans);

  const [step, setStep] = useState("connect");
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [form, setForm] = useState({ name: "", email: "", phone: "", business: "" });
  const [method, setMethod] = useState("Pay Online");
  const [reference, setReference] = useState("");
  const [receiptUrl, setReceiptUrl] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState(null);
  const [pendingId, setPendingId] = useState(null);
  const [voucher, setVoucher] = useState(null);
  const [cardProcessing, setCardProcessing] = useState(false);
  const [cardError, setCardError] = useState(null);
  const [clientMac] = useState(() => {
    try { return new URLSearchParams(window.location.search).get("mac") || null; } catch (_) { return null; }
  });
  const [clientIp] = useState(() => {
    try { return new URLSearchParams(window.location.search).get("ip") || null; } catch (_) { return null; }
  });

  // Inject reseller favicon into document head
  useEffect(() => {
    const url = (info && info.data && (info.data.favicon_url || info.data.faviconUrl)) || null;
    if (!url) return;
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = url;
  }, [info && info.data && (info.data.favicon_url || info.data.faviconUrl)]);

  // __suspended_view — shown when the voucher is suspended/expired
  const [__suspended, setSuspended] = useState(() => {
    try { return new URLSearchParams(window.location.search).get("suspended") === "1"; }
    catch (_) { return false; }
  });
  useEffect(() => {
    if (__suspended) return;
    if (!clientMac || !resellerId) return;
    let alive = true;
    api.portalStatus(resellerId, clientMac)
      .then((r) => {
        if (alive && r && (r.status === "suspended" || r.status === "expired")) setSuspended(true);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [clientMac, resellerId, __suspended]);
  if (__suspended) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: T.bg, padding: 20 }}>
        <div style={{ maxWidth: 420, width: "100%", background: "#fff", borderRadius: 16, padding: 28, textAlign: "center", boxShadow: "0 8px 24px rgba(0,0,0,0.08)" }}>
          <div style={{ fontSize: 44, marginBottom: 12 }}>&#9208;</div>
          <div style={{ fontWeight: 700, fontSize: 20, marginBottom: 8 }}>Your access is paused</div>
          <div style={{ fontSize: 13.5, color: T.sub, marginBottom: 20, lineHeight: 1.5 }}>
            Your subscription has expired or been suspended. Renew to reconnect to the internet.
          </div>
          <Btn
            onClick={() => {
              const params = new URLSearchParams(window.location.search);
              params.delete("suspended");
              window.location.search = params.toString();
            }}
            style={{ width: "100%", justifyContent: "center", padding: "12px 0" }}
          >
            Renew subscription
          </Btn>
        </div>
      </div>
    );
  }

  async function uploadReceiptFile(file) {
    const dataBase64 = await fileToBase64(file);
    return api.portalUploadReceipt(resellerId, { filename: file.name, mimeType: file.type, dataBase64 });
  }

  // Support: available from any step, not just after paying — a
  // customer who can't get their plan to load or isn't sure how to pay
  // needs help too, not just one who's already stuck waiting on
  // confirmation.
  const [showHelp, setShowHelp] = useState(false);
  const [helpForm, setHelpForm] = useState({ name: "", email: "", phone: "", subject: "", message: "" });
  const [helpAttachmentUrl, setHelpAttachmentUrl] = useState(null);
  const [helpSubmitting, setHelpSubmitting] = useState(false);
  const [helpSent, setHelpSent] = useState(false);
  const [helpError, setHelpError] = useState(null);

  async function uploadHelpAttachment(blob, mimeType, filename) {
    const dataBase64 = await fileToBase64(blob);
    return api.portalUploadSupportAttachment(resellerId, { filename, mimeType, dataBase64 });
  }

  async function submitHelp() {
    setHelpSubmitting(true);
    setHelpError(null);
    try {
      await api.portalSupport(resellerId, { ...helpForm, attachmentUrl: helpAttachmentUrl });
      setHelpSent(true);
    } catch (err) {
      setHelpError(err.message || "Something went wrong sending that.");
    }
    setHelpSubmitting(false);
  }

  async function submitTransfer() {
    setProcessing(true);
    setError(null);
    try {
      const res = await api.portalSignup(resellerId, {
        name: form.name, email: form.email, phone: form.phone, business: form.business || form.name,
        planId: selectedPlan.id, method, reference, receiptUrl,
        clientMac, clientIp,
      });
      if (res && res.pendingActivationId) setPendingId(res.pendingActivationId);
      setStep("waiting");
      notify?.("Submitted — waiting on your reseller to confirm.");
    } catch (err) {
      setError(err.message || "Something went wrong submitting your payment.");
    }
    setProcessing(false);
  }

  // Poll backend for confirmation (every 3s while waiting)
  useEffect(() => {
    if (step !== "waiting" || !pendingId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const base = import.meta.env.VITE_API_URL || "";
        const r = await fetch(`${base}/api/portal/${resellerId}/activation-status/${pendingId}`);
        if (!r.ok) return;
        const j = await r.json();
        if (stopped) return;
        if (j.status === "confirmed" && j.voucher) {
          setVoucher(j.voucher);
          setStep("confirmed");
          try { localStorage.removeItem("safelinks_pending_id"); localStorage.removeItem("safelinks_reseller_id"); } catch(_) {}
        } else if (j.status === "rejected") {
          setError("Payment rejected. Contact the reseller.");
        }
      } catch (_) {}
    };
    tick();
    const tid = setInterval(tick, 3000);
    return () => { stopped = true; clearInterval(tid); };
  }, [step, pendingId, resellerId]);

  // Resume from card-payment redirect
  useEffect(() => {
    try {
      const pid = localStorage.getItem("safelinks_pending_id");
      const rid = localStorage.getItem("safelinks_reseller_id");
      if (pid && rid && rid === resellerId) {
        setPendingId(pid);
        setStep("waiting");
      }
    } catch (_) {}
  }, [resellerId]);

  // Auto-redirect: if MAC bypass is in effect, client's next packet goes
  // straight through — just send them to their destination. If not, fall
  // through to the manual Start Browsing button.
  useEffect(() => {
    if (step !== "confirmed" || !clientMac) return;
    const params = new URLSearchParams(window.location.search);
    const dst = params.get("dst") || "http://budgetpro.com.ng/";
    const t = setTimeout(() => { window.location.href = dst; }, 3000);
    return () => clearTimeout(t);
  }, [step, clientMac]);

  // __autoRedirectEffect: after payment confirm + MAC bypass active,
  // give user 3s to see credentials, then close/redirect.
  useEffect(() => {
    if (step !== "confirmed") return;
    const params = new URLSearchParams(window.location.search);
    const dst = params.get("dst") || "http://budgetpro.com.ng/";
    const isTauri = typeof window !== "undefined" && (window.__TAURI__ || window.__TAURI_INTERNALS__);
    const t = setTimeout(async () => {
      if (isTauri) {
        try {
          const w = window.__TAURI__ && window.__TAURI__.window && window.__TAURI__.window.getCurrentWindow
            ? window.__TAURI__.window.getCurrentWindow()
            : null;
          if (w) { await w.close(); return; }
        } catch (_) {}
        // Fallback: navigate to dst — user is already online via MAC bypass
        try { window.location.href = dst; return; } catch (_) {}
      }
      window.location.href = dst;
    }, 3000);
    return () => clearTimeout(t);
  }, [step]);

  async function submitCard() {
    setCardProcessing(true);
    setCardError(null);
    try {
      const base = import.meta.env.VITE_API_URL || "";
      const r = await fetch(`${base}/api/portal/${resellerId}/card-checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name, email: form.email, phone: form.phone,
          business: form.business || form.name,
          planId: selectedPlan.id,
          provider: "flutterwave",
          clientMac, clientIp,
        }),
      });
      const ct = r.headers.get("content-type") || "";
      if (!ct.includes("application/json")) {
        throw new Error("Card service is not available yet (deploy still building). Try again in 2 minutes, or use Bank Transfer.");
      }
      const j = await r.json();
      if (!r.ok || !j.checkoutUrl) throw new Error(j.error || "Could not start card payment");
      try {
        if (j.pendingActivationId) localStorage.setItem("safelinks_pending_id", j.pendingActivationId);
        localStorage.setItem("safelinks_reseller_id", resellerId);
      } catch (_) {}
      window.location.href = j.checkoutUrl;
    } catch (e) {
      setCardError(e.message || "Card payment failed");
    }
    setCardProcessing(false);
  }

  if (info.loading) {
    return (
      <div style={{ minHeight: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: T.bg }}>
        <Loading text="Loading…" />
      </div>
    );
  }
  if (info.error || !info.data) {
    return (
      <div style={{ minHeight: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: T.bg, gap: 12, padding: 20, textAlign: "center" }}>
        <div style={{ fontSize: 14, color: T.danger, fontWeight: 600 }}>Couldn't load this portal.</div>
        <div style={{ fontSize: 12.5, color: T.sub }}>{info.error || "Reseller not found."}</div>
        <Btn variant="ghost" onClick={onExit}>Back</Btn>
      </div>
    );
  }

  const reseller = info.data;
  const plans = plansRes.data || [];
  const lang = reseller.language || "en";
  const cur = reseller.currency || "USD";

  return (
    <div style={{
      minHeight: "100%", background: `linear-gradient(160deg, ${reseller.color || T.primary}, ${T.secondary})`,
      display: "flex", alignItems: "center", justifyContent: "center", padding: "30px 16px",
      fontFamily: "'Segoe UI', system-ui, sans-serif",
    }}>
      <div style={{ position: "absolute", top: 18, left: 18 }}>
        <Btn variant="ghost" size="sm" style={{ color: "#fff" }} onClick={onExit}><ArrowLeft size={14} /> {t(lang, "exitPortal")}</Btn>
      </div>
      {!showHelp && (
        <div style={{ position: "absolute", top: 18, right: 18 }}>
          <Btn variant="ghost" size="sm" style={{ color: "#fff" }} onClick={() => { setShowHelp(true); setHelpSent(false); setHelpError(null); }}>{t(lang, "helpLink")}</Btn>
        </div>
      )}
      <div style={{ background: "#fff", borderRadius: 18, width: "100%", maxWidth: 420, overflow: "hidden", boxShadow: "0 24px 60px rgba(0,0,0,0.25)" }}>
        <div style={{ background: (reseller.background_image_url || reseller.backgroundImageUrl) ? `linear-gradient(rgba(0,0,0,0.45), rgba(0,0,0,0.55)), url(${reseller.background_image_url || reseller.backgroundImageUrl}) center/cover no-repeat` : `linear-gradient(135deg, ${reseller.color || T.primary}, ${T.secondary})`, padding: "28px 22px", textAlign: "center", color: "#fff" }}>
          {(reseller.logo_url || reseller.logoUrl) ? (
            <img src={reseller.logo_url || reseller.logoUrl} alt="" style={{ height: 44, maxWidth: 140, objectFit: "contain", marginBottom: 8 }} />
          ) : (
            <Wifi size={30} style={{ marginBottom: 8 }} />
          )}
          <div style={{ fontWeight: 700, fontSize: 17 }}>{reseller.portalTitle}</div>
          {(reseller.welcome_message || reseller.welcomeMessage) && (
            <div style={{ fontSize: 12.5, opacity: 0.9, marginTop: 5, lineHeight: 1.4 }}>{reseller.welcome_message || reseller.welcomeMessage}</div>
          )}
          <div style={{ fontSize: 12.5, opacity: 0.85, marginTop: 6 }}>📡 {reseller.ssid}</div>
          {(reseller.support_phone || reseller.supportPhone) && (
            <div style={{ fontSize: 12, opacity: 0.9, marginTop: 8 }}>
              <a href={`tel:${(reseller.support_phone || reseller.supportPhone).replace(/[^+0-9]/g, "")}`} style={{ color: "#fff", textDecoration: "underline" }}>📞 {reseller.support_phone || reseller.supportPhone}</a>
            </div>
          )}
        </div>
        {(reseller.terms_url || reseller.termsUrl || reseller.privacy_url || reseller.privacyUrl) && (
          <div style={{ padding: "9px 14px", textAlign: "center", fontSize: 11, color: T.sub, background: "#fafafa", borderBottom: `1px solid ${T.border}` }}>
            {(reseller.terms_url || reseller.termsUrl) && <a href={reseller.terms_url || reseller.termsUrl} target="_blank" rel="noreferrer" style={{ color: T.sub, textDecoration: "underline" }}>Terms</a>}
            {(reseller.terms_url || reseller.termsUrl) && (reseller.privacy_url || reseller.privacyUrl) && <span style={{ margin: "0 8px", color: T.sub }}>·</span>}
            {(reseller.privacy_url || reseller.privacyUrl) && <a href={reseller.privacy_url || reseller.privacyUrl} target="_blank" rel="noreferrer" style={{ color: T.sub, textDecoration: "underline" }}>Privacy</a>}
          </div>
        )}

        {showHelp ? (
          <div style={{ padding: 22 }}>
            {helpSent ? (
              <div style={{ textAlign: "center", padding: "10px 0" }}>
                <div style={{ fontSize: 13.5, color: T.ink, marginBottom: 16 }}>{t(lang, "helpSent", { company: reseller.companyName })}</div>
                <Btn onClick={() => setShowHelp(false)} style={{ width: "100%", justifyContent: "center", padding: "11px 0" }}>{t(lang, "close")}</Btn>
              </div>
            ) : (
              <>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>{t(lang, "helpTitle", { company: reseller.companyName })}</div>
                <Field label={t(lang, "fullName")}><input style={inputStyle} value={helpForm.name} onChange={(e) => setHelpForm({ ...helpForm, name: e.target.value })} /></Field>
                <Field label={t(lang, "email")}><input style={inputStyle} type="email" value={helpForm.email} onChange={(e) => setHelpForm({ ...helpForm, email: e.target.value })} /></Field>
                <Field label={t(lang, "phoneWhatsapp")}><input style={inputStyle} value={helpForm.phone} onChange={(e) => setHelpForm({ ...helpForm, phone: e.target.value })} /></Field>
                <Field label={t(lang, "helpSubject")}><input style={inputStyle} value={helpForm.subject} onChange={(e) => setHelpForm({ ...helpForm, subject: e.target.value })} /></Field>
                <Field label={t(lang, "helpMessage")}><textarea style={{ ...inputStyle, minHeight: 70, resize: "vertical", fontFamily: "inherit" }} value={helpForm.message} onChange={(e) => setHelpForm({ ...helpForm, message: e.target.value })} /></Field>
                <AttachmentPicker onUpload={uploadHelpAttachment} attachmentUrl={helpAttachmentUrl} setAttachmentUrl={setHelpAttachmentUrl} lang={lang} />
                {helpError && <div style={{ color: T.danger, fontSize: 12.5, margin: "8px 0 0" }}>{helpError}</div>}
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <Btn disabled={!helpForm.name || !helpForm.subject || !helpForm.message || (!helpForm.email && !helpForm.phone)} onClick={submitHelp}>
                    {helpSubmitting ? "…" : t(lang, "helpSend")}
                  </Btn>
                  <Btn variant="ghost" onClick={() => setShowHelp(false)}>{t(lang, "back")}</Btn>
                </div>
              </>
            )}
          </div>
        ) : (
        <div style={{ padding: 22 }}>
          {step === "connect" && (
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 13.5, color: T.sub, marginBottom: 18 }}>{t(lang, "connectedTo", { ssid: reseller.ssid })}</div>
              <Btn onClick={() => setStep("plans")} style={{ width: "100%", justifyContent: "center", padding: "11px 0" }}>{t(lang, "continue")} <ChevronRight size={14} /></Btn>
            </div>
          )}

          {step === "plans" && (
            <>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>{t(lang, "choosePlan")}</div>
              {plansRes.loading && <Loading />}
              {!plansRes.loading && plans.length === 0 && (
                <div style={{ fontSize: 12.5, color: T.sub, textAlign: "center", padding: "16px 0" }}>{t(lang, "noPlans")}</div>
              )}
              {plans.map((p) => (
                <div key={p.id} onClick={() => { setSelectedPlan(p); setStep("form"); }}
                  style={{ border: `1.5px solid ${p.popular ? (reseller.color || T.primary) : T.border}`, borderRadius: 10, padding: 14, marginBottom: 10, cursor: "pointer", position: "relative" }}>
                  {!!p.popular && <div style={{ position: "absolute", top: -9, right: 12, background: reseller.color || T.primary, color: "#fff", fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 20 }}>{t(lang, "mostPopular")}</div>}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13.5 }}>{p.name}</div>
                      <div style={{ fontSize: 11.5, color: T.sub }}>{p.device_limit} {t(lang, "devices")} · {p.bandwidth} Mbps</div>
                    </div>
                    <div style={{ fontWeight: 700, color: reseller.color || T.primary }}>{formatMoney(p.price, cur)}</div>
                  </div>
                </div>
              ))}
            </>
          )}

          {step === "form" && selectedPlan && (
            <>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>{t(lang, "yourDetails", { plan: selectedPlan.name, price: formatMoney(selectedPlan.price, cur) })}</div>
              <Field label={t(lang, "fullName")}><input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label={t(lang, "email")}><input style={inputStyle} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
              <Field label={t(lang, "phoneWhatsapp")}><input style={inputStyle} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
              <Field label={t(lang, "businessOptional")}><input style={inputStyle} value={form.business} onChange={(e) => setForm({ ...form, business: e.target.value })} /></Field>
              <Btn disabled={!form.name || !form.email || !form.phone} onClick={() => setStep("payment")} style={{ width: "100%", justifyContent: "center", padding: "11px 0", marginTop: 6 }}>{t(lang, "continueToPayment")}</Btn>
            </>
          )}

          {step === "payment" && selectedPlan && (
            <>
              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                {["Pay Online", "Bank Transfer", "USSD"].map((m) => (
                  <div key={m} onClick={() => setMethod(m)} style={{
                    flex: 1, textAlign: "center", padding: "9px 6px", borderRadius: 8, cursor: "pointer",
                    border: `1.5px solid ${method === m ? (reseller.color || T.primary) : T.border}`,
                    fontSize: 12, fontWeight: 600,
                    color: method === m ? (reseller.color || T.primary) : T.sub,
                  }}>{m === "Card" ? (t(lang, "cardPay") || "Card") : m}</div>
                ))}
              </div>
              {method === "Pay Online" ? (
                <>
                  <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>{t(lang, "payDirectly", { company: reseller.companyName })}</div>
                  <div style={{ fontSize: 12, color: T.sub, marginBottom: 12 }}>{t(lang, "onlineNotice") || "Choose from Card, Bank Transfer, USSD, Mobile Money, or Bank Account on the next screen."}</div>
                  <div style={{ fontSize: 11, color: T.sub, marginBottom: 12, opacity: 0.8 }}>Visa · Mastercard · Verve · Bank Transfer · USSD · Mobile Money · Bank Account</div>
                  <Btn disabled={cardProcessing} onClick={submitCard} style={{ width: "100%", justifyContent: "center", padding: "11px 0" }}>
                    {cardProcessing ? "…" : (t(lang, "continuePayment") || "Continue to Payment")}
                  </Btn>
                  {cardError && <div style={{ color: T.danger, fontSize: 12.5, marginTop: 8 }}>{cardError}</div>}
                </>
              ) : (
                <>
                  <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>{t(lang, "payDirectly", { company: reseller.companyName })}</div>
                  <div style={{ fontSize: 12, color: T.sub, marginBottom: 12 }}>{t(lang, "noCardNotice")}</div>
                  <TransferPayBlock
                    payee={{ name: reseller.companyName, bankName: reseller.bankAccount?.bankName, accountName: reseller.bankAccount?.accountName, accountNumber: reseller.bankAccount?.accountNumber, ussdCode: reseller.ussdCode }}
                    amount={formatMoney(selectedPlan.price, cur)} method={method} setMethod={setMethod}
                    reference={reference} setReference={setReference} onSubmit={submitTransfer}
                    submitLabel={processing ? "…" : t(lang, "continueToPayment")} submitting={processing}
                    onUploadFile={uploadReceiptFile} receiptUrl={receiptUrl} setReceiptUrl={setReceiptUrl}
                  />
                  {error && <div style={{ color: T.danger, fontSize: 12.5, marginTop: 8 }}>{error}</div>}
                </>
              )}
            </>
          )}

          {step === "waiting" && (
            <div style={{ textAlign: "center", padding: "10px 0" }}>
              <Clock size={38} color={T.warning} style={{ marginBottom: 10 }} />
              <div style={{ fontWeight: 700, fontSize: 15 }}>{t(lang, "paymentSubmitted")}</div>
              <div style={{ fontSize: 12.5, color: T.sub, margin: "8px 0 14px" }}>
                {t(lang, "verifying", { company: reseller.companyName })}
              </div>
              {(reseller.contactEmail || reseller.contactWhatsapp) && (
                <div style={{ background: T.bg, borderRadius: 10, padding: 12, fontSize: 12, color: T.sub, marginBottom: 14, textAlign: "left" }}>
                  <div style={{ fontWeight: 700, color: T.ink, marginBottom: 6 }}>{t(lang, "needHelp", { company: reseller.companyName })}</div>
                  {reseller.contactEmail && <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}><Mail size={12} /> {reseller.contactEmail}</div>}
                  {reseller.contactWhatsapp && <div style={{ display: "flex", alignItems: "center", gap: 6 }}><MessageCircle size={12} /> {reseller.contactWhatsapp}</div>}
                </div>
              )}
              <Btn onClick={onExit} style={{ width: "100%", justifyContent: "center", padding: "11px 0" }}>{t(lang, "close")}</Btn>
            </div>
          )}

          {step === "confirmed" && voucher && (
            <div style={{ textAlign: "center", padding: "10px 0" }}>
              <div style={{ width: 56, height: 56, margin: "0 auto 12px", borderRadius: "50%", background: "#d5f0e4", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, color: "#0b5e42" }}>✓</div>
              <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 6 }}>{t(lang, "paymentConfirmed") || "Payment confirmed!"}</div>
              <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 16 }}>{t(lang, "yourCredentials") || "Your internet is ready to activate."}</div>
              <div style={{ background: T.bg, borderRadius: 10, padding: 14, marginBottom: 14, textAlign: "left", fontSize: 13 }}>
                <div style={{ marginBottom: 6, color: T.sub, fontSize: 12 }}>{t(lang, "usernameLabel") || "Username"}</div>
                <div style={{ fontFamily: "monospace", fontWeight: 700, marginBottom: 12, fontSize: 15 }}>{voucher.username}</div>
                <div style={{ marginBottom: 6, color: T.sub, fontSize: 12 }}>{t(lang, "passwordLabel") || "Password"}</div>
                <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 15 }}>{voucher.password}</div>
              </div>
              <Btn onClick={() => {
                /* __directToDst — client is already online via MAC bypass;
                   no need to hit router /login. Go straight to destination. */
                const params = new URLSearchParams(window.location.search);
                const dst = params.get("dst") || "https://budgetpro.com.ng/";
                const source = params.get("source");
                if (source === "installer") {
                  // Open dst in the system browser via deep-link.
                  const deeplink = "safelinks-installer://open?url=" + encodeURIComponent(dst);
                  const a = document.createElement("a");
                  a.href = deeplink;
                  a.style.display = "none";
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                } else {
                  window.location.href = dst;
                }
              }} style={{ width: "100%", justifyContent: "center", padding: "13px 0", fontSize: 15 }}>              }} style={{ width: "100%", justifyContent: "center", padding: "13px 0", fontSize: 15 }}>
                🚀 {t(lang, "startBrowsing") || "Start Browsing"}
              </Btn>
              <div style={{ fontSize: 11, color: T.sub, marginTop: 12 }}>{t(lang, "redirecting") || "You will be redirected to the login page and connected automatically."}</div>
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
