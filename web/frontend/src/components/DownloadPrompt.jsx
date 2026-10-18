import React, { useState, useEffect } from 'react';

const DownloadPrompt = () => {
  const [os, setOs] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const userAgent = window.navigator.userAgent.toLowerCase();
    if (userAgent.includes('android')) setOs('android');
    else if (userAgent.includes('windows')) setOs('windows');
    else setOs('other');

    // Check if user already dismissed
    const dismissedFlag = localStorage.getItem('downloadPromptDismissed');
    if (dismissedFlag === 'true') setDismissed(true);
  }, []);

  const handleDismiss = () => {
    setDismissed(true);
    localStorage.setItem('downloadPromptDismissed', 'true');
  };

  if (dismissed || os === 'other') return null;

  const downloadUrl = os === 'android' 
    ? '/downloads/safelinks-installer.apk' 
    : '/downloads/safelinks-installer.exe';

  const osName = os === 'android' ? 'Android' : 'Windows';

  return (
    <div style={{
      position: 'fixed',
      bottom: '20px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: '#1a3a6b',
      color: 'white',
      padding: '16px 24px',
      borderRadius: '12px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
      display: 'flex',
      alignItems: 'center',
      gap: '16px',
      zIndex: 1000,
      maxWidth: '90%',
      flexWrap: 'wrap',
      justifyContent: 'center'
    }}>
      <div>
        <span>📱 Download the SAFE_Links Installer for {osName}</span>
        <div style={{ fontSize: 10.5, color: "#cbd5e1", marginTop: 3, opacity: 0.85 }}>
          Windows may warn — click "More info" → "Run anyway"
        </div>
      </div>
      {os === 'windows' ? (
          <a
            href={downloadUrl}
            download
            style={{ display: "inline-block", background: "#22c55e", color: "#fff", padding: "10px 24px", borderRadius: 8, textDecoration: "none", fontWeight: 700, fontSize: 14 }}
            onClick={() => { try { localStorage.setItem('downloadPromptDismissed', 'true'); } catch (_) {} }}
          >
            Download Now
          </a>
        ) : (
          <div style={{ fontSize: 12.5, color: "#cbd5e1", marginTop: 6, padding: "10px 14px", background: "rgba(255,255,255,0.08)", borderRadius: 8, lineHeight: 1.5 }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Windows installer available now</div>
            <div style={{ opacity: 0.85 }}>Mac, Linux, and iOS are coming soon. Use the Windows installer from a PC for now — the router configuration only needs to run once.</div>
          </div>
        )}
      <button 
        onClick={handleDismiss}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'white',
          cursor: 'pointer',
          fontSize: '20px',
          lineHeight: 1,
          padding: '0 4px'
        }}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
};

export default DownloadPrompt;
