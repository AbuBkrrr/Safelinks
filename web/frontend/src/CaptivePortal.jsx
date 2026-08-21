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
  const [method, setMethod] = useState("Bank Transfer");
  const [reference, setReference] = useState("");
  const [receiptUrl, setReceiptUrl] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState(null);

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
      await api.portalSignup(resellerId, {
        name: form.name, email: form.email, phone: form.phone, business: form.business || form.name,
        planId: selectedPlan.id, method, reference, receiptUrl,
      });
      setStep("waiting");
      notify?.("Submitted — waiting on your reseller to confirm.");
    } catch (err) {
      setError(err.message || "Something went wrong submitting your payment.");
    }
    setProcessing(false);
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
        <div style={{ background: `linear-gradient(135deg, ${reseller.color || T.primary}, ${T.secondary})`, padding: "28px 22px", textAlign: "center", color: "#fff" }}>
          <Wifi size={30} style={{ marginBottom: 8 }} />
          <div style={{ fontWeight: 700, fontSize: 17 }}>{reseller.portalTitle}</div>
          <div style={{ fontSize: 12.5, opacity: 0.85, marginTop: 3 }}>{reseller.ssid}</div>
        </div>

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
        </div>
        )}
      </div>
    </div>
  );
}
