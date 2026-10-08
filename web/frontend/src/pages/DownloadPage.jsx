import React from 'react';

const DownloadPage = () => {
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

export default DownloadPage;
