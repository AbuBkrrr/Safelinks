import React, { useState } from "react";
import { ChevronLeft, Radio, Lock } from "lucide-react";
import { T, Btn, Field, inputStyle } from "./ui.jsx";
import { api, setSession } from "./api.js";

export default function Login({ tone, roleLabel, expectedRole, onSuccess, onBack, onSignup, onForgotPassword }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.login(email.trim(), password);
      if (expectedRole && res.role !== expectedRole) {
        setError(`That account is a ${res.role.replace("_", " ")}, not a ${roleLabel.toLowerCase()}.`);
        setSubmitting(false);
        return;
      }
      setSession({ token: res.token, role: res.role, user: res.user });
      onSuccess(res);
    } catch (err) {
      setError(err.message || "Login failed");
      setSubmitting(false);
    }
  }

  return (
    <div style={{ minHeight: "100%", background: T.bg, fontFamily: "'Segoe UI', system-ui, sans-serif", padding: "50px 20px", display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <Btn variant="ghost" size="sm" onClick={onBack} style={{ marginBottom: 18 }}><ChevronLeft size={14} /> Back</Btn>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
          <div style={{ width: 34, height: 34, borderRadius: 9, background: `linear-gradient(135deg, ${T.primary}, ${T.secondary})`, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Radio size={18} color="#fff" />
          </div>
          <div style={{ fontWeight: 700, fontSize: 17, color: T.ink }}>{roleLabel} login</div>
        </div>
        <form onSubmit={submit} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 22 }}>
          <Field label="Email">
            <input style={inputStyle} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </Field>
          <Field label="Password">
            <input style={inputStyle} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          {error && <div style={{ color: T.danger, fontSize: 12.5, marginBottom: 12 }}>{error}</div>}
          <Btn type="submit" tone={tone} disabled={submitting} style={{ width: "100%", justifyContent: "center", padding: "10px 0" }}>
            <Lock size={14} /> {submitting ? "Signing in…" : "Sign in"}
          </Btn>
        </form>
        {(onSignup || onForgotPassword) && (
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 14, fontSize: 12.5 }}>
            {onForgotPassword ? (
              <span onClick={onForgotPassword} style={{ color: T.sub, cursor: "pointer" }}>Forgot password?</span>
            ) : <span />}
            {onSignup && (
              <span onClick={onSignup} style={{ color: tone, cursor: "pointer", fontWeight: 600 }}>New here? Create an account</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
