import React, { useState, useEffect } from 'react';

const DownloadPrompt = () => {
  const [os, setOs] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [hasLoaded, setHasLoaded] = useState(false);

  useEffect(() => {
    const userAgent = window.navigator.userAgent.toLowerCase();
    if (userAgent.includes('android')) setOs('android');
    else if (userAgent.includes('windows')) setOs('windows');
    else setOs('other');

    // Check if user already dismissed **during this session** (NOT from localStorage)
    // This ensures it shows on FIRST load of the landing page
    setHasLoaded(true);

    // Handle resize
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleDismiss = () => {
    setDismissed(true);
    // Store in sessionStorage (cleared when browser closes)
    sessionStorage.setItem('downloadPromptDismissed', 'true');
  };

  // Show on first load (hasLoaded guarantees OS detection complete)
  if (!hasLoaded || dismissed || os === 'other' || os === 'android') return null;

  const downloadUrl = '/downloads/safelinks-installer.exe';

  // **ONLY show on Windows, NOT on mobile**
  if (isMobile) {
    // On mobile: show compact banner at top
    return (
      <div style={{
        width: '100%',
        background: '#1a3a6b',
        color: 'white',
        padding: '10px 12px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        fontSize: '12px',
      }}>
        <span>📱 Get SAFE_Links Installer</span>
        <button
          onClick={handleDismiss}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'white',
            cursor: 'pointer',
            fontSize: '16px',
            padding: '0 4px',
            flexShrink: 0,
          }}
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    );
  }

  // Desktop: show full banner in flow (NOT fixed)
  return (
    <div style={{
      width: '100%',
      background: 'linear-gradient(135deg, #1a3a6b 0%, #0f172a 100%)',
      color: 'white',
      padding: '20px 24px',
      borderRadius: '12px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '20px',
      marginBottom: '20px',
      border: '1px solid rgba(255,255,255,0.1)',
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: '15px', marginBottom: '4px' }}>
          📱 Download SAFE_Links Installer
        </div>
        <div style={{ fontSize: '12px', color: '#cbd5e1', lineHeight: '1.4' }}>
          Configure your router in one click. Windows may warn — click "More info" → "Run anyway" (normal for new apps).
        </div>
      </div>
      <div style={{ display: 'flex', gap: '10px', flexShrink: 0, alignItems: 'center' }}>
        <a
          href={downloadUrl}
          download
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            background: '#22c55e',
            color: '#fff',
            padding: '10px 20px',
            borderRadius: '8px',
            textDecoration: 'none',
            fontWeight: 700,
            fontSize: '13px',
            whiteSpace: 'nowrap',
            border: 'none',
            cursor: 'pointer',
            transition: 'all 0.2s',
          }}
          onClick={() => { try { localStorage.setItem('downloadPromptDismissed', 'true'); } catch (_) {} }}
          onMouseEnter={(e) => e.target.style.background = '#16a34a'}
          onMouseLeave={(e) => e.target.style.background = '#22c55e'}
        >
          ↓ Download
        </a>
        <button
          onClick={handleDismiss}
          style={{
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.3)',
            color: 'white',
            cursor: 'pointer',
            fontSize: '18px',
            padding: '4px 8px',
            borderRadius: '6px',
            transition: 'all 0.2s',
          }}
          onMouseEnter={(e) => e.target.style.background = 'rgba(255,255,255,0.1)'}
          onMouseLeave={(e) => e.target.style.background = 'transparent'}
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
};

export default DownloadPrompt;
