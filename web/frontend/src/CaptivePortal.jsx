import React, { useEffect, useState, useRef } from "react";
import { ChevronRight, ArrowLeft, Wifi, Clock, Mail, MessageCircle, AlertCircle, CheckCircle, Zap } from "lucide-react";
import { T, Btn, Field, inputStyle, TransferPayBlock, Loading, formatMoney, AttachmentPicker } from "./ui.jsx";
import { api, fileToBase64 } from "./api.js";
import { Html5Qrcode } from "html5-qrcode";
import { useResource } from "./hooks.js";
import { t } from "./i18n.js";

/**
 * SAFE_Links Captive Portal - Complete end-to-end payment & voucher flow
 * 
 * States:
 * - connect: Initial landing (voucher entry or subscribe)
 * - plans: Select a data plan
 * - form: Enter customer details
 * - payment: Choose payment method
 * - paying_online: Redirect to payment gateway (Flutterwave/Paystack/etc)
 * - waiting: Bank transfer pending reseller confirmation
 * - confirmed: Payment confirmed, internet access granted
 * 
 * Features:
 * - QR code scanner (inline, no duplicates)
 * - Multiple payment methods (Card, Bank Transfer, USSD, Mobile Money)
 * - Instant internet for card/online payments
 * - Manual confirmation for bank transfers
 * - Responsive mobile-first UI
 * - Real-time WebSocket sync with desktop installer
 * - Professional typography & spacing
 */

export default function CaptivePortal({ resellerId, notify, onExit }) {
  const info = useResource(() => api.portalInfo(resellerId), [resellerId]);
  const plansRes = useResource(() => api.portalPlans(resellerId), [resellerId], (r) => r.plans);

  // ===== STATE =====
  const [step, setStep] = useState("connect");
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [form, setForm] = useState({ name: "", email: "", phone: "", business: "" });
  const [method, setMethod] = useState("Card");
  const [reference, setReference] = useState("");
  const [receiptUrl, setReceiptUrl] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState(null);
  const [pendingId, setPendingId] = useState(null);
  const [voucher, setVoucher] = useState(null);
  const [clientMac, setClientMac] = useState(null);
  const [clientIp, setClientIp] = useState(null);
  const [countdown, setCountdown] = useState(0);
  const [showScanner, setShowScanner] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 480);
  const [isExpired, setIsExpired] = useState(false);
  const [helpForm, setHelpForm] = useState({ name: "", email: "", phone: "", subject: "", message: "" });
  const [helpAttachmentUrl, setHelpAttachmentUrl] = useState(null);
  const [helpSubmitting, setHelpSubmitting] = useState(false);
  const [helpSent, setHelpSent] = useState(false);
  const [helpError, setHelpError] = useState(null);
  const [voucherInput, setVoucherInput] = useState("");
  const [suspended, setSuspended] = useState(false);
  const scannerRef = useRef(null);
  const wsRef = useRef(null);

  // ===== EXTRACT CLIENT MAC & IP =====
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      setClientMac(params.get("mac") || null);
      setClientIp(params.get("ip") || null);
    } catch (_) {}
  }, []);

  // ===== RESPONSIVE HANDLER =====
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 480);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // ===== CHECK VOUCHER EXPIRY & REDIRECT =====
  useEffect(() => {
    if (!voucher || !voucher.expires_at) return;
    const now = Date.now();
    const expiry = Number(voucher.expires_at);
    if (expiry < now) {
      setIsExpired(true);
      setError("Subscription expired. Renew to continue.");
      setStep("connect");
    }
  }, [voucher]);

  // ===== WEBSOCKET SYNC =====
  // The production deployment uses HTTP polling for portal state. Avoid opening
  // a WebSocket here because the public static frontend has no WS upgrade route.
  useEffect(() => {}, []);

  // ===== BROADCAST UPDATE TO WEBSOCKET =====
  const broadcastUpdate = (type, data) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, resellerId, ...data }));
    }
  };

  // ===== FILE UPLOAD HELPERS =====
  async function uploadReceiptFile(file) {
    const dataBase64 = await fileToBase64(file);
    return api.portalUploadReceipt(resellerId, { filename: file.name, mimeType: file.type, dataBase64 });
  }

  async function uploadHelpAttachment(blob, mimeType, filename) {
    const dataBase64 = await fileToBase64(blob);
    return api.portalUploadSupportAttachment(resellerId, { filename, mimeType, dataBase64 });
  }

  // ===== VOUCHER REDEMPTION =====
  async function redeemCode(vCode) {
    if (!vCode) return;
    if (!clientMac) {
      setError("MAC address missing. Please open the portal via the WiFi redirect.");
      return;
    }
    setProcessing(true);
    setError(null);
    try {
      const res = await api.portalRedeemVoucher(resellerId, { voucherCode: vCode, clientMac });
      setVoucher(res.voucher);
      setStep("confirmed");
      setCountdown(30);
      notify?.(`Voucher redeemed! Starting in ${30}s...`);
      broadcastUpdate("voucher_redeemed", { mac: clientMac, voucher: res.voucher });
    } catch (err) {
      setError(err.message || "Invalid voucher code");
    } finally {
      setProcessing(false);
    }
  }

  // ===== QR SCANNER (SINGLE IMPLEMENTATION) =====
  async function startScanner() {
    setShowScanner(true);
    setError(null);
    setTimeout(async () => {
      let scanner = null;
      try {
        if (!window.isSecureContext && window.location.hostname !== "localhost") {
          throw new Error("Camera access requires HTTPS");
        }
        scanner = new Html5Qrcode("qr-reader");
        scannerRef.current = scanner;
        await scanner.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          (decodedText) => {
            scanner.stop().catch(() => {}).finally(() => {
              scannerRef.current = null;
              setShowScanner(false);
              let code = decodedText;
              try {
                const url = new URL(decodedText);
                if (url.searchParams.has('voucher')) {
                  code = url.searchParams.get('voucher');
                }
              } catch (_) {}
              redeemCode(code);
            });
          },
          () => {}
        );
      } catch (err) {
        if (scanner) scanner.clear().catch(() => {});
        scannerRef.current = null;
        setShowScanner(false);
        setError("Camera unavailable. Allow camera access in browser settings, or enter the voucher manually.");
      }
    }, 100);
  }

  function stopScanner() {
    if (scannerRef.current) {
      scannerRef.current.stop().catch(() => {});
      scannerRef.current = null;
    }
    setShowScanner(false);
  }

  // ===== AUTO-REDEEM FROM URL PARAMETER =====
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const vCode = params.get('voucher');
      if (vCode && step === "connect" && clientMac) {
        redeemCode(vCode);
      }
    } catch (_) {}
  }, [clientMac, step]);

  // ===== COUNTDOWN TIMER =====
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  // ===== BANK TRANSFER SUBMISSION =====
  async function submitTransfer() {
    setProcessing(true);
    setError(null);
    try {
      const res = await api.portalSignup(resellerId, {
        name: form.name,
        email: form.email,
        phone: form.phone,
        business: form.business || form.name,
        planId: selectedPlan.id,
        method,
        reference,
        receiptUrl,
        clientMac,
        clientIp,
      });
      if (res?.pendingActivationId) {
        setPendingId(res.pendingActivationId);
        setStep("waiting");
        notify?.("Payment submitted — waiting on reseller confirmation.");
      }
    } catch (err) {
      setError(err.message || "Payment submission failed");
    }
    setProcessing(false);
  }

  // ===== POLL FOR BANK TRANSFER CONFIRMATION =====
  useEffect(() => {
    if (step !== "waiting" || !pendingId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const base = import.meta.env.VITE_API_URL || "";
        const r = await fetch(`${base}/api/portal/${resellerId}/activation-status/${pendingId}`);
        if (!r.ok || stopped) return;
        const j = await r.json();
        if (j.status === "confirmed" && j.voucher) {
          setVoucher(j.voucher);
          setStep("confirmed");
          setCountdown(30);
          notify?.("Payment confirmed! Your internet is ready.");
          broadcastUpdate("payment_confirmed", { pendingId, voucher: j.voucher });
        } else if (j.status === "rejected") {
          setError("Payment rejected. Contact the reseller.");
          setStep("connect");
        }
      } catch (_) {}
    };
    tick();
    const tid = setInterval(tick, 3000);
    return () => { stopped = true; clearInterval(tid); };
  }, [step, pendingId, resellerId, notify]);

  // ===== RESUME FROM CARD PAYMENT REDIRECT =====
  useEffect(() => {
    try {
      const pid = localStorage.getItem("safelinks_pending_id");
      const rid = localStorage.getItem("safelinks_reseller_id");
      if (pid && rid && rid === resellerId) {
        setPendingId(pid);
        setStep("waiting");
        localStorage.removeItem("safelinks_pending_id");
        localStorage.removeItem("safelinks_reseller_id");
      }
    } catch (_) {}
  }, [resellerId]);

  function openBrowsingDestination() {
    const params = new URLSearchParams(window.location.search);
    const dst = params.get("dst") || "https://www.budgetpro.com.ng";
    const isTauri = typeof window !== "undefined" && (window.__TAURI__ || window.__TAURI_INTERNALS__);

    if (isTauri && window.__TAURI__?.window?.getCurrentWindow) {
      window.__TAURI__.window.getCurrentWindow().close().catch(() => {});
      return;
    }

    // Same-tab navigation works in captive-portal browsers that block window.open popups.
    window.location.assign(dst);
  }

  // ===== AUTO-REDIRECT AFTER CONFIRMATION =====
  useEffect(() => {
    if (step !== "confirmed" || !clientMac || countdown > 0) return;
    const t = setTimeout(openBrowsingDestination, 3000);
    return () => clearTimeout(t);
  }, [step, clientMac, countdown]);
  // ===== CARD PAYMENT SUBMISSION =====
  async function submitCard() {
    setProcessing(true);
    setError(null);
    try {
      const base = import.meta.env.VITE_API_URL || "";
      const provider = method === "Card" ? "flutterwave" : 
                       method === "USSD" || method === "Mobile Money" ? "paystack" : "flutterwave";
      
      const r = await fetch(`${base}/api/portal/${resellerId}/card-checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          email: form.email,
          phone: form.phone,
          business: form.business || form.name,
          planId: selectedPlan.id,
          provider,
          clientMac,
          clientIp,
        }),
      });

      const j = await r.json();
      if (!r.ok || !j.checkoutUrl) {
        throw new Error(j.error || "Payment initialization failed");
      }

      try {
        localStorage.setItem("safelinks_pending_id", j.pendingActivationId);
        localStorage.setItem("safelinks_reseller_id", resellerId);
      } catch (_) {}

      window.location.href = j.checkoutUrl;
    } catch (err) {
      setError(err.message || "Card payment failed");
    }
    setProcessing(false);
  }

  // ===== SUPPORT SUBMISSION =====
  async function submitHelp() {
    setHelpSubmitting(true);
    setHelpError(null);
    try {
      await api.portalSupport(resellerId, { ...helpForm, attachmentUrl: helpAttachmentUrl });
      setHelpSent(true);
    } catch (err) {
      setHelpError(err.message || "Failed to send support request");
    }
    setHelpSubmitting(false);
  }

  // ===== RENDER: LOADING =====
  if (info.loading) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: T.bg }}>
        <a href={"mailto:" + (info.data?.contactEmail || "support@safelinks.name.ng")} style={{ position: "fixed", bottom: 20, right: 20, background: "#1e293b", color: "#fff", padding: "12px 16px", borderRadius: "50px", textDecoration: "none", fontWeight: 600, boxShadow: "0 4px 12px rgba(0,0,0,0.2)", zIndex: 999 }}>💬 Support</a>
        <Loading text="Loading portal…" />
      </div>
    );
  }

  // ===== RENDER: ERROR =====
  if (info.error || !info.data) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: T.bg, gap: 12, padding: 20, textAlign: "center" }}>
        <AlertCircle size={36} color={T.danger} />
        <div style={{ fontSize: 14, color: T.danger, fontWeight: 600 }}>Portal Not Found</div>
        <div style={{ fontSize: 12.5, color: T.sub }}>{info.error || "Reseller not found"}</div>
        <Btn variant="ghost" onClick={onExit}>Back</Btn>
      </div>
    );
  }

  // ===== RENDER: SUSPENDED =====
  if (suspended) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: T.bg, padding: 20 }}>
        <a href={`mailto:${info.data?.contactEmail || "support@safelinks.name.ng"}`} 
          style={{ position: "fixed", bottom: 20, right: 20, background: T.primary, color: "#fff", padding: "10px 14px", borderRadius: "50px", textDecoration: "none", fontWeight: 600, fontSize: 13, boxShadow: "0 4px 12px rgba(0,0,0,0.2)", zIndex: 999 }}>
          Support
        </a>
        <div style={{ maxWidth: 420, width: "100%", background: "#fff", borderRadius: 16, padding: 28, textAlign: "center", boxShadow: "0 8px 24px rgba(0,0,0,0.08)" }}>
          <div style={{ fontSize: 44, marginBottom: 12 }}>⏸️</div>
          <div style={{ fontWeight: 700, fontSize: 20, marginBottom: 8 }}>Access Paused</div>
          <div style={{ fontSize: 13.5, color: T.sub, marginBottom: 20, lineHeight: 1.5 }}>
            Your subscription has expired or been suspended. Renew to reconnect.
          </div>
          <Btn onClick={() => {
            const params = new URLSearchParams(window.location.search);
            params.delete("suspended");
            window.location.search = params.toString();
          }} style={{ width: "100%", justifyContent: "center", padding: "12px 0" }}>
            Renew Subscription
          </Btn>
        </div>
      </div>
    );
  }

  // ===== RENDER: QR SCANNER =====
  if (showScanner) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: T.bg, padding: 20 }}>
        <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 20, color: T.ink }}>Scan Voucher QR Code</div>
        <div id="qr-reader" style={{ width: "100%", maxWidth: 350, borderRadius: 12, overflow: "hidden", border: `2px solid ${T.primary}` }}></div>
        <Btn onClick={stopScanner} style={{ marginTop: 20 }}>Cancel</Btn>
      </div>
    );
  }

  const reseller = info.data;
  const plans = plansRes.data || [];
  const lang = reseller.language || "en";
  const cur = reseller.currency || "USD";

  // ===== RENDER: HELP MODAL =====
  if (showHelp) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)", padding: 20 }}>
        <div style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 420, maxHeight: "90vh", overflow: "auto", padding: 24 }}>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 16 }}>Contact Support</div>
          {helpSent ? (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <CheckCircle size={48} color={T.success} style={{ marginBottom: 12 }} />
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Message Sent!</div>
              <div style={{ fontSize: 12.5, color: T.sub }}>The team will respond shortly.</div>
              <Btn onClick={() => setShowHelp(false)} style={{ marginTop: 16, width: "100%", justifyContent: "center", padding: "10px 0" }}>Close</Btn>
            </div>
          ) : (
            <>
              <Field label="Full Name"><input style={inputStyle} value={helpForm.name} onChange={(e) => setHelpForm({ ...helpForm, name: e.target.value })} /></Field>
              <Field label="Email"><input style={inputStyle} type="email" value={helpForm.email} onChange={(e) => setHelpForm({ ...helpForm, email: e.target.value })} /></Field>
              <Field label="Phone"><input style={inputStyle} value={helpForm.phone} onChange={(e) => setHelpForm({ ...helpForm, phone: e.target.value })} /></Field>
              <Field label="Subject"><input style={inputStyle} value={helpForm.subject} onChange={(e) => setHelpForm({ ...helpForm, subject: e.target.value })} /></Field>
              <Field label="Message"><textarea style={{ ...inputStyle, minHeight: 80, resize: "vertical", fontFamily: "inherit" }} value={helpForm.message} onChange={(e) => setHelpForm({ ...helpForm, message: e.target.value })} /></Field>
              <AttachmentPicker onUpload={uploadHelpAttachment} attachmentUrl={helpAttachmentUrl} setAttachmentUrl={setHelpAttachmentUrl} lang={lang} />
              {helpError && <div style={{ color: T.danger, fontSize: 12.5, margin: "8px 0" }}>{helpError}</div>}
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <Btn disabled={!helpForm.name || !helpForm.subject || !helpForm.message || (!helpForm.email && !helpForm.phone)} onClick={submitHelp}>
                  {helpSubmitting ? "Sending…" : "Send"}
                </Btn>
                <Btn variant="ghost" onClick={() => setShowHelp(false)}>Cancel</Btn>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // ===== MAIN PORTAL UI =====
  return (
    <div style={{
      minHeight: "100vh",
      background: `linear-gradient(160deg, ${reseller.color || T.primary}22, ${T.secondary}22)`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "20px 16px",
      fontFamily: "'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif",
    }}>
      {/* TOP BAR */}
      <div style={{ position: "absolute", top: 16, left: 16, right: 16, display: "flex", justifyContent: "space-between", alignItems: "center", zIndex: 10 }}>
        {step !== "connect" && (
          <Btn variant="ghost" size="sm" style={{ color: T.ink }} onClick={() => {
            setError(null);
            if (step === "plans") setStep("connect");
            else if (step === "form") setStep("plans");
            else if (step === "payment") setStep("form");
          }}>
            <ArrowLeft size={14} /> Back
          </Btn>
        )}
        <div style={{ flex: 1 }} />
        <Btn variant="ghost" size="sm" style={{ color: T.ink }} onClick={() => { setShowHelp(true); setHelpSent(false); setHelpError(null); }}>
          📞 Support
        </Btn>
      </div>

      {/* MAIN CARD */}
      <div style={{ background: "#fff", borderRadius: 18, width: "100%", maxWidth: 440, overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.12)", marginTop: 40 }}>
        {/* HEADER */}
        <div style={{
          background: (reseller.background_image_url || reseller.backgroundImageUrl)
            ? `linear-gradient(rgba(0,0,0,0.45), rgba(0,0,0,0.55)), url(${reseller.background_image_url || reseller.backgroundImageUrl}) center/cover`
            : `linear-gradient(135deg, ${reseller.color || T.primary}, ${T.secondary})`,
          padding: "32px 24px",
          textAlign: "center",
          color: "#fff",
        }}>
          {(reseller.logo_url || reseller.logoUrl) && (
            <img src={reseller.logo_url || reseller.logoUrl} alt="Logo" style={{ height: 48, maxWidth: 160, objectFit: "contain", marginBottom: 12 }} />
          )}
          {!(reseller.logo_url || reseller.logoUrl) && <Wifi size={32} style={{ marginBottom: 12 }} />}
          <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 4 }}>{reseller.portalTitle || "Welcome"}</div>
          {reseller.welcome_message && (
            <div style={{ fontSize: 13, opacity: 0.9, marginBottom: 8, lineHeight: 1.4 }}>{reseller.welcome_message}</div>
          )}
          <div style={{ fontSize: 12.5, opacity: 0.85, marginTop: 10 }}>📡 {reseller.ssid}</div>
          {reseller.support_phone && (
            <div style={{ fontSize: 12, opacity: 0.9, marginTop: 8 }}>
              <a href={`tel:${reseller.support_phone.replace(/[^+0-9]/g, "")}`} style={{ color: "#fff", textDecoration: "underline" }}>
                📞 {reseller.support_phone}
              </a>
            </div>
          )}
        </div>

        {/* LEGAL LINKS */}
        {(reseller.terms_url || reseller.privacy_url) && (
          <div style={{ padding: "10px 16px", textAlign: "center", fontSize: 11, color: T.sub, background: "#f8f9fa", borderBottom: `1px solid ${T.border}` }}>
            {reseller.terms_url && <a href={reseller.terms_url} target="_blank" rel="noreferrer" style={{ color: T.sub, textDecoration: "underline" }}>Terms</a>}
            {reseller.terms_url && reseller.privacy_url && <span style={{ margin: "0 8px" }}>·</span>}
            {reseller.privacy_url && <a href={reseller.privacy_url} target="_blank" rel="noreferrer" style={{ color: T.sub, textDecoration: "underline" }}>Privacy</a>}
          </div>
        )}

        {/* CONTENT */}
        <div style={{ padding: isMobile ? "14px 12px" : "24px 16px" }}>
          {step === "connect" && (
            <div>
              <div style={{ fontSize: 14, color: T.sub, marginBottom: 16, textAlign: "center" }}>
                Connected to <strong>{reseller.ssid}</strong>
              </div>

              {clientMac && (
                <div style={{ background: "#f0f9ff", border: `1px solid ${T.primary}22`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10, color: T.ink }}>Already have a voucher?</div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                    <input
                      type="text"
                      placeholder="Enter code or scan QR"
                      value={voucherInput}
                      onChange={(e) => setVoucherInput(e.target.value)}
                      style={{ flex: 1, ...inputStyle }}
                      onKeyPress={(e) => e.key === "Enter" && redeemCode(voucherInput)}
                    />
                    <Btn onClick={() => redeemCode(voucherInput)} disabled={!voucherInput || processing} style={{ whiteSpace: "nowrap" }}>
                      {processing ? "…" : "Verify"}
                    </Btn>
                  </div>
                  <Btn variant="outline" onClick={startScanner} style={{ width: "100%", justifyContent: "center", padding: "8px 0", fontSize: 12 }}>
                    📷 Scan QR Code
                  </Btn>
                  {error && <div style={{ color: T.danger, fontSize: 11.5, marginTop: 8, textAlign: "center" }}>{error}</div>}
                </div>
              )}

              <div style={{ textAlign: "center", color: T.sub, fontSize: 12, margin: "16px 0" }}>or</div>

              <Btn onClick={() => setStep("plans")} style={{ width: "100%", justifyContent: "center", padding: "12px 0", fontSize: 15 }}>
                Subscribe Now <Zap size={14} />
              </Btn>
            </div>
          )}

          {/* PLANS - Select a Data Plan */}
          {step === "plans" && (
            <div>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14, color: T.ink }}>Choose Your Plan</div>
              {plansRes.loading && <Loading />}
              {!plansRes.loading && plans.length === 0 && (
                <div style={{ fontSize: 13, color: T.sub, textAlign: "center", padding: "16px 0" }}>No plans available</div>
              )}
              {plans.map((p, idx) => (
                <div
                  key={p.id}
                  onClick={() => { setSelectedPlan(p); setError(null); setStep("form"); }}
                  style={{
                    border: `1.5px solid ${p.popular ? (reseller.color || T.primary) : T.border}`,
                    borderRadius: 12,
                    padding: 14,
                    marginBottom: 10,
                    cursor: "pointer",
                    position: "relative",
                    background: p.popular ? `${reseller.color || T.primary}08` : "#fff",
                    transition: "all 0.2s",
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.borderColor = reseller.color || T.primary}
                  onMouseLeave={(e) => e.currentTarget.style.borderColor = p.popular ? (reseller.color || T.primary) : T.border}
                >
                  {p.popular && (
                    <div style={{ position: "absolute", top: -10, right: 12, background: reseller.color || T.primary, color: "#fff", fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20 }}>
                      Most Popular
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14, color: T.ink }}>{p.name}</div>
                      <div style={{ fontSize: 12, color: T.sub, marginTop: 4 }}>
                        {p.device_limit} devices · {p.bandwidth} Mbps · {p.duration}
                      </div>
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 16, color: reseller.color || T.primary, whiteSpace: "nowrap", marginLeft: 8 }}>
                      {formatMoney(p.price, cur)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* FORM - Enter Customer Details */}
          {step === "form" && selectedPlan && (
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4, color: T.ink }}>
                {selectedPlan.name}
              </div>
              <div style={{ fontSize: 12, color: T.sub, marginBottom: 16 }}>
                {formatMoney(selectedPlan.price, cur)} for {selectedPlan.duration}
              </div>
              <Field label="Full Name"><input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="John Doe" /></Field>
              <Field label="Email"><input style={inputStyle} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="john@example.com" /></Field>
              <Field label="Phone"><input style={inputStyle} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+234..." /></Field>
              <Field label="Business (Optional)"><input style={inputStyle} value={form.business} onChange={(e) => setForm({ ...form, business: e.target.value })} placeholder="Your business name" /></Field>
              {error && <div style={{ color: T.danger, fontSize: 12.5, marginBottom: 12 }}>{error}</div>}
              <Btn
                disabled={!form.name || !form.email || !form.phone}
                onClick={() => { setError(null); setMethod("Card"); setStep("payment"); }}
                style={{ width: "100%", justifyContent: "center", padding: "12px 0" }}
              >
                Continue to Payment
              </Btn>
            </div>
          )}

          {/* PAYMENT - Choose Payment Method */}
          {step === "payment" && selectedPlan && (
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14, color: T.ink }}>Choose Payment Method</div>

              <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
                {["Card", "USSD", "Bank Transfer"].map((m) => (
                  <div
                    key={m}
                    onClick={() => { setMethod(m); setError(null); }}
                    style={{
                      flex: 1,
                      minWidth: 80,
                      textAlign: "center",
                      padding: "10px 8px",
                      borderRadius: 8,
                      cursor: "pointer",
                      border: `1.5px solid ${method === m ? (reseller.color || T.primary) : T.border}`,
                      fontSize: 12,
                      fontWeight: 600,
                      color: method === m ? (reseller.color || T.primary) : T.sub,
                      background: method === m ? `${reseller.color || T.primary}08` : "#fff",
                    }}
                  >
                    {m === "Card" ? "💳" : m === "USSD" ? "📱" : "🏦"} {m}
                  </div>
                ))}
              </div>

              {method === "Card" || method === "USSD" ? (
                <div>
                  <div style={{ fontSize: 12, color: T.sub, marginBottom: 12 }}>
                    {method === "Card" && "Pay instantly with your card, USSD, or mobile money"}
                    {method === "USSD" && "Send USSD code to pay instantly"}
                  </div>
                  <Btn disabled={processing} onClick={submitCard} style={{ width: "100%", justifyContent: "center", padding: "12px 0", fontSize: 15 }}>
                    {processing ? "Processing…" : `Proceed to ${method === "Card" ? "Payment" : "USSD"}`}
                  </Btn>
                  {error && <div style={{ color: T.danger, fontSize: 12.5, marginTop: 8 }}>{error}</div>}
                </div>
              ) : (
                <div>
                  <TransferPayBlock
                    payee={{
                      name: reseller.companyName,
                      bankName: reseller.bankName,
                      accountName: reseller.bankAccountName,
                      accountNumber: reseller.bankAccountNumber,
                      ussdCode: reseller.ussdCode,
                    }}
                    amount={formatMoney(selectedPlan.price, cur)}
                    method={method}
                    setMethod={setMethod}
                    reference={reference}
                    setReference={setReference}
                    onSubmit={submitTransfer}
                    submitLabel={processing ? "Submitting…" : "Submit Payment"}
                    submitting={processing}
                    onUploadFile={uploadReceiptFile}
                    receiptUrl={receiptUrl}
                    setReceiptUrl={setReceiptUrl}
                  />
                  {error && <div style={{ color: T.danger, fontSize: 12.5, marginTop: 8 }}>{error}</div>}
                </div>
              )}
            </div>
          )}

          {/* WAITING - Bank Transfer Pending Confirmation */}
          {step === "waiting" && (
            <div style={{ textAlign: "center", padding: "10px 0" }}>
              <Clock size={40} color={T.warning} style={{ marginBottom: 12 }} />
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6, color: T.ink }}>Payment Submitted</div>
              <div style={{ fontSize: 13, color: T.sub, marginBottom: 14, lineHeight: 1.5 }}>
                Waiting for {reseller.companyName} to verify and confirm your payment…
              </div>
              {(reseller.contactEmail || reseller.contactWhatsapp) && (
                <div style={{ background: "#f8f9fa", borderRadius: 10, padding: 12, fontSize: 12, color: T.sub, marginBottom: 14, textAlign: "left" }}>
                  <div style={{ fontWeight: 600, color: T.ink, marginBottom: 6 }}>Need help?</div>
                  {reseller.contactEmail && <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}><Mail size={12} /> {reseller.contactEmail}</div>}
                  {reseller.contactWhatsapp && <div style={{ display: "flex", alignItems: "center", gap: 6 }}><MessageCircle size={12} /> {reseller.contactWhatsapp}</div>}
                </div>
              )}
              <Btn onClick={onExit} variant="outline" style={{ width: "100%", justifyContent: "center", padding: "10px 0" }}>
                Close Portal
              </Btn>
            </div>
          )}

          {/* EXPIRED - Subscription Expired */}
          {isExpired && (
            <div style={{ textAlign: "center" }}>
              <AlertCircle size={44} color={T.danger} style={{ marginBottom: 12 }} />
              <div style={{ fontWeight: 700, fontSize: isMobile ? 16 : 18, marginBottom: 8, color: T.ink }}>Subscription Expired</div>
              <div style={{ fontSize: isMobile ? 12 : 13, color: T.sub, marginBottom: 16, lineHeight: 1.5 }}>
                Your subscription has expired. Please renew to continue using the internet.
              </div>
              <Btn onClick={() => { setIsExpired(false); setStep("plans"); }} style={{ width: "100%", justifyContent: "center", padding: "12px 0" }}>
                Renew Subscription
              </Btn>
            </div>
          )}

          {/* CONFIRMED - Payment Approved, Internet Access Granted */}
          {step === "confirmed" && voucher && !isExpired && (
            <div style={{ textAlign: "center" }}>
              <div style={{ width: 56, height: 56, margin: "0 auto 12px", borderRadius: "50%", background: "#d5f0e4", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32 }}>✓</div>
              <div style={{ fontWeight: 700, fontSize: isMobile ? 16 : 17, marginBottom: 6, color: T.success }}>Connected!</div>
              <div style={{ fontSize: isMobile ? 12 : 13, color: T.sub, marginBottom: 16, lineHeight: 1.5 }}>
                Your internet access is active. You can now browse freely.
              </div>

              {countdown > 0 && (
                <div style={{ background: `${reseller.color || T.primary}15`, border: `1px solid ${reseller.color || T.primary}`, borderRadius: 10, padding: 14, marginBottom: 14, textAlign: "center", fontSize: 12, color: T.ink, fontWeight: 600 }}>
                  Syncing with router in {countdown} seconds…
                </div>
              )}

              <Btn
                onClick={openBrowsingDestination}
                disabled={countdown > 0}
                style={{ width: "100%", justifyContent: "center", padding: "12px 0", fontSize: isMobile ? 14 : 15 }}
              >
                🚀 Start Browsing
              </Btn>

              <div style={{ fontSize: 11, color: T.sub, marginTop: 12, opacity: 0.8 }}>
                {countdown > 0 ? `Starting in ${countdown}s…` : "You're online now."}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
