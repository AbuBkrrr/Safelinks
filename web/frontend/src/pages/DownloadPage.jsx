import React from 'react';

const DownloadPage = () => {
  const isWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
  const isAndroid = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
  const platformBadge = isWindows ? "Windows" : isAndroid ? "Android" : "Your device";
  const downloads = [
    {
      platform: 'Android',
      file: '/downloads/safelinks-installer.apk',
      icon: '🤖',
      description: 'For Android phones and tablets (APK)',
      size: '~25 MB'
    },
    {
      platform: 'Windows',
      file: '/downloads/safelinks-installer.exe',
      icon: '🪟',
      description: 'For Windows 10/11 PCs (EXE)',
      size: '~80 MB'
    }
  ];

  return (
    <div style={{ maxWidth: '600px', margin: '40px auto', padding: '20px' }}>
      <h1 style={{ textAlign: 'center', marginBottom: '8px' }}>Download SAFE_Links Installer</h1>
      <p style={{ textAlign: 'center', color: '#666', marginBottom: '32px' }}>
        Choose your device to install the standalone application.
      </p>
      {downloads.map((item) => (
        <div key={item.platform} style={{
          display: 'flex',
          alignItems: 'center',
          background: '#f8fafd',
          padding: '20px',
          borderRadius: '12px',
          marginBottom: '16px',
          border: '1px solid #e5ecf5'
        }}>
          <span style={{ fontSize: '36px', marginRight: '16px' }}>{item.icon}</span>
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0 }}>{item.platform}</h3>
            <p style={{ margin: '4px 0', color: '#666', fontSize: '14px' }}>{item.description}</p>
            <span style={{ fontSize: '12px', color: '#999' }}>{item.size}</span>
          </div>
          <a 
            href={item.file} 
            download
            style={{
              background: '#1a3a6b',
              color: 'white',
              padding: '10px 24px',
              borderRadius: '8px',
              textDecoration: 'none',
              fontWeight: '600'
            }}
          >
            Download
          </a>
        </div>
      ))}
    </div>
  );
};


// ─────────────────────────────────────────────────────────────
// SmartScreen install guide (Windows-specific)
// Shown below the download list so first-time users know exactly
// what to expect when they run the .exe.
// ─────────────────────────────────────────────────────────────
const INSTALL_GUIDE_STEPS = [
  "Click Download and save the file (usually to your Downloads folder)",
  "Double-click SAFE_Links-Setup.exe to run it",
  "Windows will show \"Windows protected your PC\" — that's normal for new apps",
  "Click More info (small link under the warning text)",
  "Click Run anyway at the bottom of the dialog",
  "Finish the install wizard (defaults are fine — click Next → Install)",
  "Open SAFE_Links from your Start menu and sign in",
];

export function SmartScreenGuide() {
  return (
    <div style={{ marginTop: 24, padding: 18, background: "#fff3cd", border: "1px solid #ffc107", borderRadius: 12, maxWidth: 640, marginLeft: "auto", marginRight: "auto", textAlign: "left" }}>
      <div style={{ fontWeight: 700, fontSize: 14.5, color: "#856404", marginBottom: 10 }}>
        📋 First time installing? Follow these steps:
      </div>
      <ol style={{ marginLeft: 20, lineHeight: 1.9, fontSize: 13, color: "#664d03" }}>
        {INSTALL_GUIDE_STEPS.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
      <div style={{ marginTop: 14, padding: 12, background: "#fef3c7", borderRadius: 8, fontSize: 12, color: "#664d03", lineHeight: 1.6 }}>
        <b>Why does Windows warn?</b> SmartScreen flags any newly-built app until it's been downloaded many times or signed with a $200/yr certificate. It's a false alarm — the SAFE_Links installer is open source.
      </div>
      <SmartScreenGuide />
    </div>
  );
}

export default DownloadPage;
