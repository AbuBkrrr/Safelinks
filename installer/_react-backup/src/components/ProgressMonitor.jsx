import React from 'react';

export default function ProgressMonitor({ progress }) {
  return (
    <div className="screen">
      <h1>⏳ Configuring Router</h1>
      <p>Please wait while we set up your router...</p>

      <div className="progress-container">
        {progress.length === 0 ? (
          <div className="spinner"></div>
        ) : (
          <div className="progress-list">
            {progress.map((p, i) => (
              <div key={i} className={`progress-item progress-${p.type}`}>
                <span className="progress-icon">
                  {p.type === 'success' && '✅'}
                  {p.type === 'failed' && '⚠️'}
                  {p.type === 'error' && '❌'}
                </span>
                <span className="progress-text">{p.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ marginTop: '30px', color: '#94a3b8', fontSize: '12px' }}>
        <p>Do not close this window until configuration is complete.</p>
      </div>
    </div>
  );
}
