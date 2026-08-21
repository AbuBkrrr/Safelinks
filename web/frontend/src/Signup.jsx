import React, { useEffect, useState } from "react";
import { ChevronLeft, Building2, UserPlus } from "lucide-react";
import { T, Btn, Field, inputStyle } from "./ui.jsx";
import { api, setSession } from "./api.js";

// Kept in sync with SECURITY_QUESTIONS in reslink-backend/src/routes/auth.js.
// "Write your own" always stays last and switches the dropdown into a
// free-text field rather than being an actual question itself.
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

  // A referral link looks like .../?ref=CODE — prefills the field below
  // but stays fully editable, so someone can still type in a code they
  // were given verbally instead of by link.
  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get("ref");
    if (ref) setReferralCode(ref.toUpperCase());
  }, []);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) return setError("Passwords don't match");
    if (password.length < 8) return setError("Password must be at least 8 characters");
    if (!finalQuestion) return setError("Choose or write a security question");
    if (!securityAnswer.trim() || securityAnswer.trim().length < 2) {
      return setError("Your security answer is too short — this is the only way to recover your account, so make it something you'll remember");
    }
    setSubmitting(true);
    try {
      const res = await api.signup(email.trim(), password, companyName.trim(), finalQuestion, securityAnswer.trim(), referralCode.trim() || undefined);
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
          <div style={{ width: 34, height: 34, borderRadius: 9, background: `${T.primary}18`, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Building2 size={18} color={T.primary} />
          </div>
          <div style={{ fontWeight: 700, fontSize: 17, color: T.ink }}>Create your reseller account</div>
        </div>
        <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 16 }}>
          You'll be in your dashboard immediately — no waiting on approval. A license payment is due before your plans and portal go live (see the License tab once you're in).
        </div>
        <form onSubmit={submit} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 22 }}>
          <Field label="Company name"><input style={inputStyle} value={companyName} onChange={(e) => setCompanyName(e.target.value)} required autoFocus /></Field>
          <Field label="Email"><input style={inputStyle} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <Field label="Password" hint="At least 8 characters"><input style={inputStyle} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          <Field label="Confirm password"><input style={inputStyle} type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required /></Field>
          <Field label="Referral code (optional)" hint="Were you referred by another reseller or a marketer? Enter their code here.">
            <input style={{ ...inputStyle, fontFamily: "monospace", letterSpacing: 1 }} value={referralCode} onChange={(e) => setReferralCode(e.target.value.toUpperCase())} placeholder="e.g. NAIROBI1" />
          </Field>

          <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 4, paddingTop: 14 }}>
            <div style={{ fontSize: 12, color: T.sub, marginBottom: 10 }}>
              There's no "forgot password" email in SAFE_Links — this question is how you get back into your account, so pick something only you'd know the answer to.
            </div>
            <Field label="Security question">
              <select style={inputStyle} value={securityQuestion} onChange={(e) => setSecurityQuestion(e.target.value)}>
                {SECURITY_QUESTIONS.map((q) => <option key={q} value={q}>{q}</option>)}
              </select>
            </Field>
            {isCustom && (
              <Field label="Your question">
                <input style={inputStyle} value={customQuestion} onChange={(e) => setCustomQuestion(e.target.value)} placeholder="e.g. What street did you grow up on?" />
              </Field>
            )}
            <Field label="Your answer" hint="Not case-sensitive — extra spaces don't matter either">
              <input style={inputStyle} value={securityAnswer} onChange={(e) => setSecurityAnswer(e.target.value)} />
            </Field>
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
