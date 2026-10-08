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
      <span>📱 Download the SAFE_Links Installer for {osName}</span>
      <a 
        href={downloadUrl} 
        download
        style={{
          background: '#2b8c5e',
          color: 'white',
          padding: '8px 20px',
          borderRadius: '8px',
          textDecoration: 'none',
          fontWeight: '600',
          whiteSpace: 'nowrap'
        }}
      >
        Download Now
      </a>
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
