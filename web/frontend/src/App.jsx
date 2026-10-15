import React, { useCallback, useEffect, useState } from "react";
import { GoogleOAuthProvider } from "@react-oauth/google";
import { Shield, Wifi, Radio, Smartphone, LogIn, UserPlus } from "lucide-react";
import { T, Btn, Toast, GlobalStyle } from "./ui.jsx";
import VoiceAssistant from "./VoiceAssistant.jsx";
import { dt, dtMatch } from "./dashboardI18n.js";
import { getSession, clearSession } from "./api.js";
import Login from "./Login.jsx";
import Signup from "./Signup.jsx";
import ForgotPassword from "./ForgotPassword.jsx";
import SuperAdminApp from "./SuperAdminApp.jsx";
import ResellerApp from "./ResellerApp.jsx";
import CaptivePortal from "./CaptivePortal.jsx";
import StandaloneInstaller from "./StandaloneInstaller.jsx";
import VerifyEmail from "./VerifyEmail.jsx";
import PaymentCallback from "./PaymentCallback.jsx";
import DownloadPrompt from "./components/DownloadPrompt";

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";

const SUPPORTED_LANGS = ["en", "fr", "sw", "ha", "yo", "pt"];
function detectBrowserLang() {
  const codes = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"])
    .map((l) => l.slice(0, 2).toLowerCase());
  return codes.find((c) => SUPPORTED_LANGS.includes(c)) || "en";
}

function parseRoute() {
  const __p = window.location.pathname;
  if (__p === '/agent-login-auto') return { name: 'agent-login-auto' };
  if (__p === '/agent-login-callback') return { name: 'agent-login-callback' };
  const path = window.location.pathname;
  const portalMatch = path.match(/^\/portal\/([^/]+)\/?$/);
  if (portalMatch) return { name: "portal", resellerId: portalMatch[1] };
  if (path.replace(/\/$/, "") === "/install") return { name: "install" };
  if (path.replace(/\/$/, "") === "/verify-email") return { name: "verify-email" };
  if (path.replace(/\/$/, "") === "/payment-callback") return { name: "payment-callback" };
  return { name: "landing" };
}

function Landing({ onCreateAccount, onLogin, onPickSuperAdmin }) {
  const lang = detectBrowserLang();
  const voiceCommands = [
    { match: dtMatch(lang, "voiceMatchCreateAccount"), label: dt(lang, "voiceOpeningAccount"), run: () => { onCreateAccount(); return dt(lang, "voiceOpeningAccount"); } },
    { match: dtMatch(lang, "voiceMatchLogin"), label: dt(lang, "voiceOpeningLogin"), run: () => { onLogin(); return dt(lang, "voiceOpeningLogin"); } },
    { match: dtMatch(lang, "voiceMatchSuperAdmin"), label: dt(lang, "voiceOpeningSuperAdmin"), run: () => { onPickSuperAdmin(); return dt(lang, "voiceOpeningSuperAdmin"); } },
    { match: dtMatch(lang, "voiceMatchHelp"), label: dt(lang, "voiceHelpLabel"), run: () => dt(lang, "voiceLandingHelp") },
  ];
  return (
    <div style={{ minHeight: "100%", background: T.bg, fontFamily: "'Segoe UI', system-ui, sans-serif", position: "relative", padding: "50px 20px", display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div onClick={onPickSuperAdmin} title="Super Admin login" style={{ position: "absolute", top: 16, right: 16, display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 600, color: T.sub, cursor: "pointer", padding: "6px 10px", borderRadius: 20, border: `1px solid ${T.border}`, background: T.card }}>
        <Shield size={12} /> Super Admin
      </div>
      <div style={{ width: 44, height: 44, borderRadius: 12, background: `linear-gradient(135deg, ${T.primary}, ${T.secondary})`, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 18, marginBottom: 14 }}>
        <Radio size={24} color="#fff" />
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: T.ink, marginBottom: 2 }}>Welcome to SAFE_Links</div>
      <div style={{ fontSize: 12, fontWeight: 600, color: T.sub, marginBottom: 10, letterSpacing: 0.2 }}>A product of A I Brains Ventures</div>
      <div style={{ fontSize: 14, color: T.sub, marginBottom: 30, textAlign: "center", maxWidth: 440 }}>
        Run your own branded internet business — vouchers, routers, and a payment portal your customers see under your name. Create an account or log in to get started.
      </div>
      <div style={{ width: "100%", maxWidth: 340, background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: 24, boxShadow: "0 1px 2px rgba(20,20,43,0.04)" }}>
        <Btn onClick={onCreateAccount} style={{ width: "100%", justifyContent: "center", padding: "12px 0", fontSize: 14 }}>
          <UserPlus size={15} /> Create an account
        </Btn>
        <div style={{ height: 10 }} />
        <Btn variant="outline" onClick={onLogin} style={{ width: "100%", justifyContent: "center", padding: "12px 0", fontSize: 14 }}>
          <LogIn size={15} /> Log in
        </Btn>
      </div>
      <div style={{ marginTop: 30, display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: T.sub }}>
        <Wifi size={13} /> End-users never log in here — they reach your Captive Portal at a URL like <code>/portal/&lt;resellerId&gt;</code> after connecting to WiFi.
      </div>
      <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: T.sub }}>
        <Smartphone size={13} /> Installing a router? Go straight to <code>/install</code> on your phone instead.
      </div>
      <div style={{ marginTop: 22, fontSize: 11.5, color: T.sub, textAlign: "center" }}>
        A I Brains Ventures · +234 803 254 0215 · aibrainsventures@gmail.com
      </div>
      <VoiceAssistant commands={voiceCommands} lang={lang} greeting={dt(lang, "voiceLandingGreeting")} />
    </div>
  );
}

function AgentLoginAuto() {
  const [msg, setMsg] = React.useState('Redirecting to Google...');
  React.useEffect(() => {
    try {
      const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
      if (!clientId) { setMsg('Google sign-in not configured (VITE_GOOGLE_CLIENT_ID missing).'); return; }
      const state = Math.random().toString(36).slice(2);
      sessionStorage.setItem('agent_oauth_state', state);
      const redirectUri = window.location.origin + '/agent-login-callback';
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'openid email profile');
      url.searchParams.set('access_type', 'online');
      url.searchParams.set('prompt', 'select_account');
      url.searchParams.set('state', state);
      window.location.href = url.toString();
    } catch (e) { setMsg('Error: ' + e.message); }
  }, []);
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, textAlign: 'center', fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
      <div>
        <div style={{ fontSize: 26, marginBottom: 8 }}>{String.fromCodePoint(0x1F510)}</div>
        <div style={{ fontSize: 15, color: '#444' }}>{msg}</div>
      </div>
    </div>
  );
}

function AgentLoginCallback() {
  const [msg, setMsg] = React.useState('Verifying with Google...');
  React.useEffect(() => {
    (async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const code = params.get('code');
        const state = params.get('state');
        if (!code) throw new Error(params.get('error_description') || params.get('error') || 'No code in URL');
        const savedState = sessionStorage.getItem('agent_oauth_state');
        if (savedState && state !== savedState) throw new Error('OAuth state mismatch — try again');
        sessionStorage.removeItem('agent_oauth_state');
        const redirectUri = window.location.origin + '/agent-login-callback';
        setMsg('Exchanging code with backend...');
        const resp = await fetch('/api/auth/google', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, redirectUri }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Sign-in failed');
        setMsg('Handing session back to installer...');
        const qs = new URLSearchParams({
          token: data.token || '',
          role: data.role || 'reseller',
          email: (data.user && data.user.email) || '',
          companyName: (data.user && data.user.companyName) || '',
        }).toString();
        window.location.href = 'safelinks-installer://auth?' + qs;
        setTimeout(() => setMsg('If the installer did not open, close this tab and sign in manually.'), 1500);
      } catch (err) {
        setMsg('Error: ' + err.message);
      }
    })();
  }, []);
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, textAlign: 'center', fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
      <div>
        <div style={{ fontSize: 26, marginBottom: 8 }}>{String.fromCodePoint(0x1F510)}</div>
        <div style={{ fontSize: 15, color: '#444' }}>{msg}</div>
      </div>
    </div>
  );
}

export default function App() {
  const [route] = useState(parseRoute);
  const [session, setSessionState] = useState(getSession);
  const [stage, setStage] = useState(session ? session.role : "landing");
  const [toast, setToast] = useState(null);

  const notify = useCallback((msg) => { setToast(msg); setTimeout(() => setToast(null), 2600); }, []);
  const handleExit = useCallback(() => { clearSession(); setSessionState(null); setStage("landing"); }, []);

  // Installer deep-link: if the URL carries ?token=<jwt>, adopt it as the session
  // and jump straight into the reseller dashboard (skip login screen).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // Installer source → always open the reseller login form first.
    if (params.get('source') === 'installer' && !session) {
      setStage('login_reseller');
    }
    const urlToken = params.get('token');
    if (!urlToken) return;
    try {
      const payload = JSON.parse(atob(urlToken.split('.')[1]));
      const role = payload.role || 'reseller';
      const user = {
        id: payload.resellerId || payload.sub,
        resellerId: payload.resellerId,
        email: payload.email || '',
        companyName: payload.companyName || '',
      };
      localStorage.setItem('SAFELINKS_token', urlToken);
      localStorage.setItem('SAFELINKS_role', role);
      localStorage.setItem('SAFELINKS_user', JSON.stringify(user));
      setSessionState({ token: urlToken, role, user });
      setStage(role === 'super_admin' ? 'super_admin' : 'reseller');
      window.history.replaceState({}, '', window.location.pathname);
    } catch (e) {
      // Malformed token - fall through to landing/login
    }
  }, []);

  // When the installer opened this page with ?source=installer, after a
  // successful login/signup we must hand the token back to the installer via
  // the safelinks-installer:// deep-link, then stop in-browser navigation.
  function __installerDeepLink(res) {
    try {
      const p = new URLSearchParams(window.location.search);
      if (p.get('source') !== 'installer') return false;
      const qs = new URLSearchParams({
        token: res.token || '',
        role: res.role || 'reseller',
        email: (res.user && res.user.email) || '',
        companyName: (res.user && res.user.companyName) || '',
      }).toString();
      window.location.href = 'safelinks-installer://auth?' + qs;
      return true;
    } catch (_) { return false; }
  }

  if (route.name === "agent-login-auto") return <AgentLoginAuto />;
  if (route.name === "agent-login-callback") return <AgentLoginCallback />;

  if (route.name === "portal") return (<div style={{ minHeight: "100vh" }}><GlobalStyle /><Toast toast={toast} /><CaptivePortal resellerId={route.resellerId} notify={notify} onExit={() => { window.location.href = "/"; }} /></div>);
  if (route.name === "install") return (<div style={{ minHeight: "100vh" }}><GlobalStyle /><Toast toast={toast} /><StandaloneInstaller onExit={() => { window.location.href = "/"; }} /></div>);
  if (route.name === "verify-email") return (<div style={{ minHeight: "100vh" }}><GlobalStyle /><Toast toast={toast} /><VerifyEmail onDone={() => { window.location.href = "/"; }} /></div>);
  if (route.name === "payment-callback") return (<div style={{ minHeight: "100vh" }}><GlobalStyle /><Toast toast={toast} /><PaymentCallback onDone={() => { window.location.href = "/"; }} /></div>);

  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <div style={{ minHeight: "100vh", position: "relative" }}>
        <GlobalStyle />
        <Toast toast={toast} />
        {stage === "landing" && (<Landing onCreateAccount={() => setStage("signup_reseller")} onLogin={() => setStage("login_reseller")} onPickSuperAdmin={() => setStage("login_super_admin")} />)}
        {stage === "login_super_admin" && (<Login tone={T.secondary} roleLabel="Super Admin" expectedRole="super_admin" onBack={() => setStage("landing")} onSuccess={(res) => { setSessionState({ token: res.token, role: res.role, user: res.user }); setStage("super_admin"); }} />)}
        {stage === "login_reseller" && (<Login tone={T.primary} roleLabel="Reseller Admin" expectedRole="reseller" onBack={() => setStage("landing")} onSuccess={(res) => { if (__installerDeepLink(res)) return; setSessionState({ token: res.token, role: res.role, user: res.user }); setStage("reseller"); }} onSignup={() => setStage("signup_reseller")} onForgotPassword={() => setStage("forgot_password_reseller")} />)}
        {stage === "signup_reseller" && (<Signup onBack={() => setStage("login_reseller")} onSuccess={(res) => { if (__installerDeepLink(res)) return; setSessionState({ token: res.token, role: res.role, user: res.user }); setStage("reseller"); }} />)}
        {stage === "forgot_password_reseller" && (<ForgotPassword onBack={() => setStage("login_reseller")} />)}
        {stage === "super_admin" && <SuperAdminApp session={session} onExit={handleExit} notify={notify} />}
        {stage === "reseller" && <ResellerApp session={session} onExit={handleExit} notify={notify} />}
        <DownloadPrompt />
      </div>
    </GoogleOAuthProvider>
  );
}