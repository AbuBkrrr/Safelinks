import React, { useState } from "react";
import { ChevronLeft, Radio, Lock } from "lucide-react";
import { T, Btn, Field, inputStyle } from "./ui.jsx";
import { api, setSession } from "./api.js";
import GoogleAuthButton from "./GoogleAuthButton.jsx";

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
        setError(`This account isn't a ${roleLabel}.`);
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
    <div style={{ minHeight: "100vh", background: T.bg, fontFamily: "'Segoe UI', system-ui, sans-serif", padding: "50px 20px", display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <Btn variant="ghost" size="sm" onClick={onBack} style={{ marginBottom: 18 }}><ChevronLeft size={14} /> Back</Btn>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
          <div style={{ width: 34, height: 34, borderRadius: 9, background: `${tone}18`, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Lock size={17} color={tone} />
          </div>
          <div style={{ fontWeight: 700, fontSize: 17, color: T.ink }}>{roleLabel} Login</div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <GoogleAuthButton onSuccess={(res) => onSuccess(res)} onError={(msg) => setError(msg)} />
        </div>
        <div style={{ textAlign: "center", fontSize: 11.5, color: T.sub, marginBottom: 14 }}>— or log in with email —</div>

        <form onSubmit={submit} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 22 }}>
          <Field label="Email"><input style={inputStyle} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
          <Field label="Password"><input style={inputStyle} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          {error && <div style={{ color: T.danger, fontSize: 12.5, marginBottom: 12 }}>{error}</div>}
          <Btn type="submit" disabled={submitting} style={{ width: "100%", justifyContent: "center", padding: "10px 0" }}>
            {submitting ? "Signing in…" : "Log in"}
          </Btn>
        </form>

        <div style={{ marginTop: 14, display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
          {onSignup && <a onClick={onSignup} style={{ color: T.primary, cursor: "pointer" }}>Create an account</a>}
          {onForgotPassword && <a onClick={onForgotPassword} style={{ color: T.sub, cursor: "pointer" }}>Forgot password?</a>}
        </div>
      </div>
    </div>
  );
}