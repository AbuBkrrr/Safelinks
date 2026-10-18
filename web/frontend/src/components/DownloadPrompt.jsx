import React, { useState, useEffect } from 'react';

const DownloadPrompt = () => {
  const [os, setOs] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 480);

  useEffect(() => {
    const userAgent = window.navigator.userAgent.toLowerCase();
    if (userAgent.includes('android')) setOs('android');
    else if (userAgent.includes('windows')) setOs('windows');
    else setOs('other');

    // Check if user already dismissed
    const dismissedFlag = localStorage.getItem('downloadPromptDismissed');
    if (dismissedFlag === 'true') setDismissed(true);

    // Handle resize
    const handleResize = () => setIsMobile(window.innerWidth < 480);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleDismiss = () => {
    setDismissed(true);
    localStorage.setItem('downloadPromptDismissed', 'true');
  };

  if (dismissed || os === 'other' || !isMobile) return null;  // ONLY show on mobile

  const downloadUrl = os === 'android' 
    ? '/downloads/safelinks-installer.apk' 
    : '/downloads/safelinks-installer.exe';

  const osName = os === 'android' ? 'Android' : 'Windows';

  return (
    <div style={{
      position: 'relative',  // Changed from fixed
      width: '100%',
      background: '#1a3a6b',
      color: 'white',
      padding: isMobile ? '12px 14px' : '16px 24px',
      margin: isMobile ? '10px 0' : '0',
      borderRadius: '12px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
      display: 'flex',
      alignItems: 'center',
      gap: isMobile ? '8px' : '16px',
      zIndex: 100,
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      fontSize: isMobile ? '12px' : '14px',
    }}>
      <div style={{ flex: 1, minWidth: isMobile ? '200px' : '300px' }}>
        <span>📱 Download SafeLinks Installer for {osName}</span>
        <div style={{ fontSize: isMobile ? '10px' : '10.5px', color: "#cbd5e1", marginTop: 4, opacity: 0.85 }}>
          Windows may warn — click "More info" → "Run anyway"
        </div>
      </div>
      {os === 'windows' ? (
          <a
            href={downloadUrl}
            download
            style={{ 
              display: "inline-block", 
              background: "#22c55e", 
              color: "#fff", 
              padding: isMobile ? "8px 16px" : "10px 24px", 
              borderRadius: 8, 
              textDecoration: "none", 
              fontWeight: 700, 
              fontSize: isMobile ? '12px' : '14px',
              whiteSpace: 'nowrap',
              flexShrink: 0
            }}
            onClick={() => { try { localStorage.setItem('downloadPromptDismissed', 'true'); } catch (_) {} }}
          >
            Download
          </a>
        ) : (
          <div style={{ fontSize: isMobile ? '11px' : '12.5px', color: "#cbd5e1", padding: isMobile ? "8px 12px" : "10px 14px", background: "rgba(255,255,255,0.08)", borderRadius: 8, lineHeight: 1.4 }}>
            <div style={{ fontWeight: 700, marginBottom: 2 }}>Windows available</div>
            <div style={{ opacity: 0.85 }}>iOS coming soon</div>
          </div>
        )}
      <button 
        onClick={handleDismiss}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'white',
          cursor: 'pointer',
          fontSize: '24px',
          lineHeight: 1,
          padding: '0 4px',
          flexShrink: 0
        }}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
};

export default DownloadPrompt;
