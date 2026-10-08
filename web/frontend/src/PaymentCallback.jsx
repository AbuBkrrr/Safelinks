import React, { useEffect, useState } from "react";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { T, Btn } from "./ui.jsx";

const BASE_URL = import.meta.env.VITE_API_URL || "";

export default function PaymentCallback({ onDone }) {
  const [status, setStatus] = useState("checking");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reference = params.get("reference") || params.get("tx_ref");
    const cancelled = params.get("status") === "cancelled";
    if (cancelled) {
      setStatus("error");
      setMessage("Payment cancelled.");
      return;
    }
    if (!reference) {
      setStatus("error");
      setMessage("No payment reference found.");
      return;
    }

    // Try each provider to find the reference (backend tries all).
    (async () => {
      for (const provider of ["paystack", "flutterwave", "stripe"]) {
        try {
          const res = await fetch(`${BASE_URL}/api/payments/verify/${provider}/${encodeURIComponent(reference)}`);
          const data = await res.json();
          if (data.ok && data.paid) {
            setStatus("ok");
            setMessage("Payment confirmed! Your access is active.");
            return;
          }
        } catch {}
      }
      setStatus("error");
      setMessage("We couldn't confirm your payment yet. If money left your account, please wait 2 minutes and refresh — the webhook may still be arriving.");
    })();
  }, []);

  return (
    <div style={{ minHeight: "100vh", background: T.bg, fontFamily: "'Segoe UI', system-ui, sans-serif", padding: "60px 20px", display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ width: "100%", maxWidth: 440, background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: 28, textAlign: "center" }}>
        {status === "checking" && (
          <>
            <Loader2 size={40} color={T.primary} style={{ animation: "spin 1s linear infinite" }} />
            <div style={{ marginTop: 14, fontSize: 16, fontWeight: 600 }}>Confirming your payment…</div>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </>
        )}
        {status === "ok" && (
          <>
            <CheckCircle2 size={44} color="#2b8c5e" />
            <div style={{ marginTop: 14, fontSize: 20, fontWeight: 700 }}>Payment successful!</div>
            <div style={{ marginTop: 8, fontSize: 13.5, color: T.sub }}>{message}</div>
            <Btn onClick={onDone} style={{ marginTop: 20, padding: "10px 24px" }}>Continue →</Btn>
          </>
        )}
        {status === "error" && (
          <>
            <XCircle size={44} color="#c53030" />
            <div style={{ marginTop: 14, fontSize: 20, fontWeight: 700 }}>Payment not confirmed</div>
            <div style={{ marginTop: 8, fontSize: 13.5, color: T.sub }}>{message}</div>
            <Btn onClick={onDone} style={{ marginTop: 20, padding: "10px 24px" }}>Back to home</Btn>
          </>
        )}
      </div>
    </div>
  );
}
