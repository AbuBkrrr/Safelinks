import React, { useEffect, useState } from "react";
import { CheckCircle2, XCircle, Loader2, Mail } from "lucide-react";
import { T, Btn } from "./ui.jsx";

const BASE_URL = import.meta.env.VITE_API_URL || "";

export default function VerifyEmail({ onDone }) {
  const [status, setStatus] = useState("checking"); // checking | ok | error
  const [message, setMessage] = useState("");
  const [resendEmail, setResendEmail] = useState("");
  const [resendStatus, setResendStatus] = useState(null); // null | sending | sent | failed

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      setStatus("error");
      setMessage("No verification token in the URL. Please use the link from your email.");
      return;
    }
    (async () => {
      try {
        const res = await fetch(`${BASE_URL}/api/auth/verify-email/${encodeURIComponent(token)}`);
        const data = await res.json();
        if (res.ok && data.ok) {
          setStatus("ok");
          setMessage(data.message || "Your email is verified.");
        } else {
          setStatus("error");
          setMessage(data.error || "Verification failed.");
        }
      } catch {
        setStatus("error");
        setMessage("Could not reach the server. Check your internet connection and try again.");
      }
    })();
  }, []);

  async function resend(e) {
    e.preventDefault();
    if (!resendEmail.trim()) return;
    setResendStatus("sending");
    try {
      const res = await fetch(`${BASE_URL}/api/auth/verify-email/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: resendEmail.trim().toLowerCase() }),
      });
      const data = await res.json();
      setResendStatus(res.ok ? "sent" : "failed");
      if (!res.ok) setMessage(data.error || "Could not resend.");
    } catch {
      setResendStatus("failed");
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: T.bg, fontFamily: "'Segoe UI', system-ui, sans-serif", padding: "60px 20px", display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ width: "100%", maxWidth: 420, background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: 28, textAlign: "center" }}>
        {status === "checking" && (
          <>
            <Loader2 size={36} color={T.primary} style={{ animation: "spin 1s linear infinite" }} />
            <div style={{ marginTop: 14, fontSize: 16, fontWeight: 600, color: T.ink }}>Verifying your email…</div>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </>
        )}

        {status === "ok" && (
          <>
            <CheckCircle2 size={42} color="#2b8c5e" />
            <div style={{ marginTop: 14, fontSize: 18, fontWeight: 700, color: T.ink }}>Email verified!</div>
            <div style={{ marginTop: 8, fontSize: 13.5, color: T.sub }}>{message}</div>
            <Btn onClick={onDone} style={{ marginTop: 20, padding: "10px 24px" }}>Go to dashboard →</Btn>
          </>
        )}

        {status === "error" && (
          <>
            <XCircle size={42} color="#c53030" />
            <div style={{ marginTop: 14, fontSize: 18, fontWeight: 700, color: T.ink }}>Verification problem</div>
            <div style={{ marginTop: 8, fontSize: 13.5, color: T.sub }}>{message}</div>

            <form onSubmit={resend} style={{ marginTop: 22, textAlign: "left" }}>
              <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 6 }}>
                <Mail size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
                Need a new link? Enter your email:
              </div>
              <input
                type="email"
                value={resendEmail}
                onChange={(e) => setResendEmail(e.target.value)}
                placeholder="you@example.com"
                style={{ width: "100%", padding: "10px 12px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 14, boxSizing: "border-box" }}
              />
              <Btn type="submit" disabled={resendStatus === "sending"} style={{ marginTop: 10, width: "100%", justifyContent: "center" }}>
                {resendStatus === "sending" ? "Sending…" : resendStatus === "sent" ? "Sent! Check your inbox." : "Resend verification email"}
              </Btn>
            </form>

            <Btn variant="outline" onClick={onDone} style={{ marginTop: 14, width: "100%", justifyContent: "center" }}>Back to home</Btn>
          </>
        )}
      </div>
    </div>
  );
}
