import React, { useState, useEffect } from 'react';
const { invoke } = window.__TAURI__.core;

export default function NetworkScanner({ routers, onSelect, onRescan }) {
  const [manualIp, setManualIp] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [testing, setTesting] = useState(null);

  const handleTestRouter = async (router) => {
    setTesting(router.ip);
    try {
      const info = await invoke('test_ssh', {
        ip: router.ip,
        username: 'admin',
        password: 'admin'
      });
      router._identity = info.identity;
      setTimeout(() => onSelect(router), 500);
    } catch (err) {
      console.error('Test failed:', err);
    } finally {
      setTesting(null);
    }
  };

  const handleManualConnect = async () => {
    if (!manualIp) return;
    setTesting(manualIp);
    try {
      const info = await invoke('test_ssh', {
        ip: manualIp,
        username: 'admin',
        password: 'admin'
      });
      onSelect({
        ip: manualIp,
        open_ports: [22],
        kind: 'manual',
        is_gateway: false,
        _identity: info.identity
      });
    } catch (err) {
      alert(`Failed to connect to ${manualIp}: ${err}`);
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="screen">
      <h1>🖥️ Select a Router</h1>
      <p>{routers.length} router(s) found on your network</p>

      <div className="router-list">
        {routers.map((router) => (
          <div key={router.ip} className="router-card">
            <div className="router-info">
              <div className="router-ip">{router.ip}</div>
              <div className="router-kind">{router.kind}</div>
              <div className="router-ports">
                Ports: {router.open_ports.join(', ')} {router.is_gateway && '(Gateway)'}
              </div>
            </div>
            <button
              onClick={() => handleTestRouter(router)}
              disabled={testing === router.ip}
              className="btn btn-sm"
            >
              {testing === router.ip ? '🔄' : '→'} Select
            </button>
          </div>
        ))}
      </div>

      <div className="divider">or</div>

      {!showManual ? (
        <button onClick={() => setShowManual(true)} className="btn btn-secondary">
          Enter IP Manually
        </button>
      ) : (
        <div className="manual-input">
          <input
            type="text"
            value={manualIp}
            onChange={(e) => setManualIp(e.target.value)}
            placeholder="192.168.88.1"
          />
          <button
            onClick={handleManualConnect}
            disabled={!manualIp || testing === manualIp}
            className="btn btn-primary"
          >
            {testing === manualIp ? '🔄' : '✅'} Connect
          </button>
        </div>
      )}

      <button onClick={onRescan} className="btn btn-secondary" style={{ marginTop: '20px' }}>
        🔄 Scan Again
      </button>
    </div>
  );
}
