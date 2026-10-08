import React, { useEffect, useState } from "react";
import { ChevronLeft, Building2, UserPlus } from "lucide-react";
import { T, Btn, Field, inputStyle } from "./ui.jsx";
import { api, setSession } from "./api.js";
import GoogleAuthButton from "./GoogleAuthButton.jsx";

const SECURITY_QUESTIONS = [
  "What city were you born in?",
  "What was your first pet's name?",
  "What is your mother's maiden name?",
  "What was the name of your first school?",
  "What is your favorite childhood nickname?",
  "Write your own…",
];

export default function Signup({ onSuccess, onBack }) {
  const [companyName, setCompanyName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [securityQuestion, setSecurityQuestion] = useState(SECURITY_QUESTIONS[0]);
  const [customQuestion, setCustomQuestion] = useState("");
  const [securityAnswer, setSecurityAnswer] = useState("");
  const [referralCode, setReferralCode] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const isCustom = securityQuestion === "Write your own…";
  const finalQuestion = isCustom ? customQuestion.trim() : securityQuestion;

  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get("ref");
    if (ref) setReferralCode(ref.toUpperCase());
  }, []);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    const phoneClean = phone.replace(/[\s\-()]/g, "");
    if (!/^\+?[1-9]\d{6,14}$/.test(phoneClean)) return setError("Enter a valid phone number (e.g. +2348000000000)");
    if (password !== confirmPassword) return setError("Passwords don't match");
    if (password.length < 8) return setError("Password must be at least 8 characters");
    if (!finalQuestion) return setError("Choose or write a security question");
    if (!securityAnswer.trim() || securityAnswer.trim().length < 2) return setError("Your security answer is too short");
    setSubmitting(true);
    try {
      const res = await api.signup(email.trim(), password, companyName.trim(), phoneClean, finalQuestion, securityAnswer.trim(), referralCode.trim() || undefined);
      setSession({ token: res.token, role: res.role, user: res.user });
      onSuccess(res);
    } catch (err) {
      setError(err.message || "Could not create your account");
      setSubmitting(false);
    }
  }

  return (
    <div style={{ minHeight: "100%", background: T.bg, fontFamily: "'Segoe UI', system-ui, sans-serif", padding: "50px 20px", display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <Btn variant="ghost" size="sm" onClick={onBack} style={{ marginBottom: 18 }}><ChevronLeft size={14} /> Back</Btn>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <div style={{ width: 34, height: 34, borderRadius: 9, background: `${T.primary}18`, display: "flex", alignItems: "center", justifyContent: "center" }}><Building2 size={18} color={T.primary} /></div>
          <div style={{ fontWeight: 700, fontSize: 17, color: T.ink }}>Create your reseller account</div>
        </div>

        <div style={{ marginTop: 12, marginBottom: 14 }}>
          <GoogleAuthButton onSuccess={(res) => onSuccess(res)} onError={(msg) => setError(msg)} />
        </div>
        <div style={{ textAlign: "center", fontSize: 11.5, color: T.sub, marginBottom: 14 }}>— or sign up with email —</div>

        <form onSubmit={submit} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 22 }}>
          <Field label="Company name"><input style={inputStyle} value={companyName} onChange={(e) => setCompanyName(e.target.value)} required autoFocus /></Field>
          <Field label="Email"><input style={inputStyle} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <Field label="Phone (WhatsApp)" hint="Required — used to deliver credentials and recover your account.">
            <input style={inputStyle} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+2348000000000" required />
          </Field>
          <Field label="Password" hint="At least 8 characters"><input style={inputStyle} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          <Field label="Confirm password"><input style={inputStyle} type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required /></Field>
          <Field label="Referral code (optional)"><input style={{ ...inputStyle, fontFamily: "monospace", letterSpacing: 1 }} value={referralCode} onChange={(e) => setReferralCode(e.target.value.toUpperCase())} placeholder="e.g. NAIROBI1" /></Field>

          <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 4, paddingTop: 14 }}>
            <Field label="Security question">
              <select style={inputStyle} value={securityQuestion} onChange={(e) => setSecurityQuestion(e.target.value)}>
                {SECURITY_QUESTIONS.map((q) => <option key={q} value={q}>{q}</option>)}
              </select>
            </Field>
            {isCustom && <Field label="Your question"><input style={inputStyle} value={customQuestion} onChange={(e) => setCustomQuestion(e.target.value)} /></Field>}
            <Field label="Your answer"><input style={inputStyle} value={securityAnswer} onChange={(e) => setSecurityAnswer(e.target.value)} /></Field>
          </div>

          {error && <div style={{ color: T.danger, fontSize: 12.5, marginBottom: 12, marginTop: 6 }}>{error}</div>}
          <Btn type="submit" disabled={submitting} style={{ width: "100%", justifyContent: "center", padding: "10px 0", marginTop: 6 }}>
            <UserPlus size={14} /> {submitting ? "Creating account…" : "Create account"}
          </Btn>
        </form>
      </div>
    </div>
  );
}