import React, { useCallback, useState } from "react";
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

// Nobody's logged in yet on the Landing page, so there's no saved
// dashboardLanguage to read — best we can do is guess from the
// browser's own language setting, falling back to English. Matches
// against the same codes as dashboardI18n.js/i18n.js.
const SUPPORTED_LANGS = ["en", "fr", "sw", "ha", "yo", "pt"];
function detectBrowserLang() {
  const codes = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"])
    .map((l) => l.slice(0, 2).toLowerCase());
  return codes.find((c) => SUPPORTED_LANGS.includes(c)) || "en";
}

/* Client-side "routing" from the URL path — no react-router dependency
   needed for three real routes:
     /            -> reseller welcome (sign up / log in), with a small
                     Super Admin link tucked in the top-right corner
     /portal/:id  -> the public Captive Portal for reseller :id (this is
                     what a router's walled-garden redirect points a
                     freshly-connected device at)
     /install     -> the standalone zero-touch installer, meant to be
                     opened on a technician's phone in the field

   There used to be a fourth route, /reset-password?token=..., for an
   emailed reset link. Password recovery is now done entirely via the
   security question set at signup (see ForgotPassword.jsx) — the whole
   flow happens inline on the login screen, no email/link involved, so
   that route no longer exists.
*/
function parseRoute() {
  const path = window.location.pathname;
  const portalMatch = path.match(/^\/portal\/([^/]+)\/?$/);
  if (portalMatch) return { name: "portal", resellerId: portalMatch[1] };
  if (path.replace(/\/$/, "") === "/install") return { name: "install" };
  return { name: "landing" };
}

/* The landing page is a Reseller welcome screen first and foremost —
   that's who's expected to arrive here from a browser (Super Admin is
   one person, you; resellers are the whole audience this page is
   written for). Super Admin access is still one click away, just
   deliberately small and out of the way, top-right, so it doesn't
   compete with the reseller call-to-action. */
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
      <div
        onClick={onPickSuperAdmin}
        title="Super Admin login"
        style={{
          position: "absolute", top: 16, right: 16, display: "flex", alignItems: "center", gap: 5,
          fontSize: 11.5, fontWeight: 600, color: T.sub, cursor: "pointer", padding: "6px 10px",
          borderRadius: 20, border: `1px solid ${T.border}`, background: T.card,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = T.secondary; e.currentTarget.style.borderColor = T.secondary; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = T.sub; e.currentTarget.style.borderColor = T.border; }}
      >
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
      <VoiceAssistant
        commands={voiceCommands}
        lang={lang}
        greeting={dt(lang, "voiceLandingGreeting")}
      />
    </div>
  );
}

export default function App() {
  const [route] = useState(parseRoute);
  const [session, setSessionState] = useState(getSession);
  const [stage, setStage] = useState(session ? session.role : "landing");
  // 'landing' | 'login_super_admin' | 'login_reseller' | 'signup_reseller'
  // | 'forgot_password_reseller' | 'super_admin' | 'reseller'
  const [toast, setToast] = useState(null);

  const notify = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }, []);

  const handleExit = useCallback(() => {
    clearSession();
    setSessionState(null);
    setStage("landing");
  }, []);

  // Public routes short-circuit the whole landing/login flow.
  if (route.name === "portal") {
    return (
      <div style={{ minHeight: "100vh" }}>
        <GlobalStyle />
        <Toast toast={toast} />
        <CaptivePortal resellerId={route.resellerId} notify={notify} onExit={() => { window.location.href = "/"; }} />
      </div>
    );
  }
  if (route.name === "install") {
    return (
      <div style={{ minHeight: "100vh" }}>
        <GlobalStyle />
        <Toast toast={toast} />
        <StandaloneInstaller onExit={() => { window.location.href = "/"; }} />
      </div>
    );
  }
  return (
    <div style={{ minHeight: "100vh", position: "relative" }}>
      <GlobalStyle />
      <Toast toast={toast} />

      {stage === "landing" && (
        <Landing
          onCreateAccount={() => setStage("signup_reseller")}
          onLogin={() => setStage("login_reseller")}
          onPickSuperAdmin={() => setStage("login_super_admin")}
        />
      )}

      {stage === "login_super_admin" && (
        <Login tone={T.secondary} roleLabel="Super Admin" expectedRole="super_admin"
          onBack={() => setStage("landing")}
          onSuccess={(res) => { setSessionState({ token: res.token, role: res.role, user: res.user }); setStage("super_admin"); }}
        />
      )}
      {stage === "login_reseller" && (
        <Login tone={T.primary} roleLabel="Reseller Admin" expectedRole="reseller"
          onBack={() => setStage("landing")}
          onSuccess={(res) => { setSessionState({ token: res.token, role: res.role, user: res.user }); setStage("reseller"); }}
          onSignup={() => setStage("signup_reseller")}
          onForgotPassword={() => setStage("forgot_password_reseller")}
        />
      )}
      {stage === "signup_reseller" && (
        <Signup
          onBack={() => setStage("login_reseller")}
          onSuccess={(res) => { setSessionState({ token: res.token, role: res.role, user: res.user }); setStage("reseller"); }}
        />
      )}
      {stage === "forgot_password_reseller" && (
        <ForgotPassword onBack={() => setStage("login_reseller")} />
      )}

      {stage === "super_admin" && <SuperAdminApp session={session} onExit={handleExit} notify={notify} />}
      {stage === "reseller" && <ResellerApp session={session} onExit={handleExit} notify={notify} />}
    </div>
  );
}
