import React, { useState } from "react";
import { ChevronLeft, ShieldQuestion, CheckCircle2, Lock } from "lucide-react";
import { T, Btn, Field, inputStyle } from "./ui.jsx";
import { api } from "./api.js";

/* Account recovery via the secret question set at signup — no email
 * involved anywhere in this flow. Three steps, all on this one screen:
 *   1. email            -> POST /password-reset/question
 *   2. question + answer -> POST /password-reset/verify-answer (returns
 *                            a short-lived resetToken on a correct answer)
 *   3. new password      -> POST /password-reset/confirm { resetToken, newPassword }
 * A wrong answer at step 2 just re-shows the question with an error —
 * nothing here reveals whether that was because the email doesn't
 * exist or the answer was wrong, same non-enumeration goal the old
 * email-link flow had.
 */
export default function ForgotPassword({ onBack }) {
  const [step, setStep] = useState("email"); // email | question | newPassword | done
  const [email, setEmail] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [resetToken, setResetToken] = useState(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function submitEmail(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.getSecurityQuestion(email.trim());
      setQuestion(res.question);
      setStep("question");
    } catch (err) {
      setError(err.message || "Something went wrong looking that up");
    }
    setSubmitting(false);
  }

  async function submitAnswer(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.verifySecurityAnswer(email.trim(), answer);
      setResetToken(res.resetToken);
      setStep("newPassword");
    } catch (err) {
      setError(err.message || "That answer doesn't match our records");
    }
    setSubmitting(false);
  }

  async function submitNewPassword(e) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) return setError("Passwords don't match");
    if (password.length < 8) return setError("Password must be at least 8 characters");
    setSubmitting(true);
    try {
      await api.confirmPasswordReset(resetToken, password);
      setStep("done");
    } catch (err) {
      setError(err.message || "That reset session expired — start over");
    }
    setSubmitting(false);
  }

  return (
    <div style={{ minHeight: "100%", background: T.bg, fontFamily: "'Segoe UI', system-ui, sans-serif", padding: "50px 20px", display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <Btn variant="ghost" size="sm" onClick={onBack} style={{ marginBottom: 18 }}><ChevronLeft size={14} /> Back to login</Btn>

        {step === "done" ? (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 26, textAlign: "center" }}>
            <CheckCircle2 size={34} color={T.success} style={{ marginBottom: 10 }} />
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>Password updated</div>
            <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 16 }}>You can log in with your new password now.</div>
            <Btn onClick={onBack} style={{ width: "100%", justifyContent: "center", padding: "10px 0" }}>Go to login</Btn>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <div style={{ width: 34, height: 34, borderRadius: 9, background: `${T.primary}18`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <ShieldQuestion size={18} color={T.primary} />
              </div>
              <div style={{ fontWeight: 700, fontSize: 17, color: T.ink }}>Reset your password</div>
            </div>

            {step === "email" && (
              <>
                <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 16 }}>Enter the email on your reseller account — we'll pull up your security question next.</div>
                <form onSubmit={submitEmail} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 22 }}>
                  <Field label="Email"><input style={inputStyle} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
                  {error && <div style={{ color: T.danger, fontSize: 12.5, marginBottom: 12 }}>{error}</div>}
                  <Btn type="submit" disabled={submitting} style={{ width: "100%", justifyContent: "center", padding: "10px 0" }}>
                    {submitting ? "Looking up…" : "Continue"}
                  </Btn>
                </form>
              </>
            )}

            {step === "question" && (
              <>
                <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 16 }}>Answer the security question you set when you created your account.</div>
                <form onSubmit={submitAnswer} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 22 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5, color: T.ink, marginBottom: 12 }}>{question}</div>
                  <Field label="Your answer"><input style={inputStyle} value={answer} onChange={(e) => setAnswer(e.target.value)} required autoFocus /></Field>
                  {error && <div style={{ color: T.danger, fontSize: 12.5, marginBottom: 12 }}>{error}</div>}
                  <Btn type="submit" disabled={submitting} style={{ width: "100%", justifyContent: "center", padding: "10px 0" }}>
                    {submitting ? "Checking…" : "Verify answer"}
                  </Btn>
                </form>
                <div style={{ marginTop: 12, fontSize: 12, color: T.sub, textAlign: "center" }}>
                  Wrong email? <span onClick={() => { setStep("email"); setError(null); }} style={{ color: T.primary, cursor: "pointer", fontWeight: 600 }}>Start over</span>
                </div>
              </>
            )}

            {step === "newPassword" && (
              <>
                <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 16 }}>Answer verified — set a new password.</div>
                <form onSubmit={submitNewPassword} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 22 }}>
                  <Field label="New password" hint="At least 8 characters"><input style={inputStyle} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus /></Field>
                  <Field label="Confirm new password"><input style={inputStyle} type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required /></Field>
                  {error && <div style={{ color: T.danger, fontSize: 12.5, marginBottom: 12 }}>{error}</div>}
                  <Btn type="submit" disabled={submitting} style={{ width: "100%", justifyContent: "center", padding: "10px 0" }}>
                    <Lock size={14} /> {submitting ? "Updating…" : "Update password"}
                  </Btn>
                </form>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
