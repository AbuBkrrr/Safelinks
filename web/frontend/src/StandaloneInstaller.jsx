import React, { useState } from "react";
import { Radio, ChevronLeft } from "lucide-react";
import { T, Btn, GlobalStyle } from "./ui.jsx";
import { getSession, clearSession } from "./api.js";
import Login from "./Login.jsx";
import InstallerWizard from "./InstallerWizard.jsx";

/* Meant to be opened directly on a technician's phone at /install — a
   small standalone flow: log in as the reseller (or the reseller can
   share the URL + their own credentials with a technician), register
   the router, done. No dashboard, no other tabs. */
export default function StandaloneInstaller({ onExit }) {
  const [session, setSession] = useState(getSession);
  const [done, setDone] = useState(false);

  if (!session || session.role !== "reseller") {
    return (
      <Login tone={T.primary} roleLabel="Reseller Admin" expectedRole="reseller"
        onBack={onExit}
        onSuccess={(res) => setSession({ token: res.token, role: res.role, user: res.user })}
      />
    );
  }

  return (
    <div style={{ minHeight: "100%", background: T.bg, display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 16px", fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
      <div style={{ width: "100%", maxWidth: 420 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <div style={{ width: 30, height: 30, borderRadius: 8, background: `linear-gradient(135deg, ${T.primary}, ${T.secondary})`, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Radio size={16} color="#fff" />
            </div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>SAFE_Links Installer</div>
          </div>
          <Btn variant="ghost" size="sm" onClick={() => { clearSession(); onExit(); }}><ChevronLeft size={13} /> Exit</Btn>
        </div>

        {done ? (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 26, textAlign: "center" }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8 }}>All set</div>
            <div style={{ fontSize: 13, color: T.sub, marginBottom: 16 }}>Router registered. You can install another, or exit.</div>
            <Btn onClick={() => setDone(false)}>Install another router</Btn>
          </div>
        ) : (
          <InstallerWizard onComplete={() => setDone(true)} embedded={false} />
        )}
      </div>
    </div>
  );
}
