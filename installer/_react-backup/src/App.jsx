import React, { useState, useEffect } from 'react';
import LoginScreen from './components/LoginScreen';
import NetworkScanner from './components/NetworkScanner';
import ConfigForm from './components/ConfigForm';
import ProgressMonitor from './components/ProgressMonitor';
import SuccessScreen from './components/SuccessScreen';
import './App.css';

const { invoke } = window.__TAURI__.core;

export default function App() {
  const [stage, setStage] = useState('login');
  const [user, setUser] = useState(null);
  const [routers, setRouters] = useState([]);
  const [selectedRouter, setSelectedRouter] = useState(null);
  const [configData, setConfigData] = useState(null);
  const [progress, setProgress] = useState([]);
  const [result, setResult] = useState(null);

  // Check if already logged in
  useEffect(() => {
    const token = localStorage.getItem('auth_token');
    if (token) {
      setUser({
        email: localStorage.getItem('user_email'),
        reseller_id: localStorage.getItem('reseller_id'),
        token
      });
      setStage('scanning');
      startScan();
    }
  }, []);

  const handleLogin = (userData) => {
    setUser(userData);
    setStage('scanning');
    startScan();
  };

  const handleLogout = () => {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('user_email');
    localStorage.removeItem('reseller_id');
    setUser(null);
    setStage('login');
    setRouters([]);
    setSelectedRouter(null);
  };

  const startScan = async () => {
    setStage('scanning');
    setRouters([]);
    try {
      const devices = await invoke('scan_network');
      const potentialRouters = devices.filter(d => 
        d.open_ports.includes(22) || d.open_ports.includes(8291) || d.kind.includes('router')
      );
      setRouters(potentialRouters);
      
      if (potentialRouters.length === 1) {
        setSelectedRouter(potentialRouters[0]);
        setStage('config');
      } else if (potentialRouters.length > 1) {
        setStage('select');
      } else {
        setStage('nofound');
      }
    } catch (e) {
      console.error('Scan failed:', e);
      setStage('error');
    }
  };

  const handleSelectRouter = (router) => {
    setSelectedRouter(router);
    setStage('config');
  };

  const handleConfigure = async (config) => {
    setConfigData(config);
    setStage('running');
    setProgress([]);

    try {
      const result = await invoke('configure_router', {
        ip: selectedRouter.ip,
        username: config.adminUser,
        password: config.adminPass,
        ssid: config.ssid,
        wifi_password: config.wifiPassword
      });

      setResult(result);
      
      const progressItems = [
        ...result.steps_completed.map(s => ({ type: 'success', text: s })),
        ...result.steps_failed.map(s => ({ type: 'failed', text: s }))
      ];
      
      // Animate progress
      progressItems.forEach((item, index) => {
        setTimeout(() => {
          setProgress(prev => [...prev, item]);
        }, index * 500);
      });

      // Auto-advance to success screen
      setTimeout(() => {
        setStage('success');
      }, progressItems.length * 500 + 2000);
    } catch (e) {
      setProgress(prev => [...prev, { type: 'error', text: String(e) }]);
      setStage('error');
    }
  };

  return (
    <div className="app">
      {user && stage !== 'login' && (
        <div className="top-bar">
          <div className="user-info">👤 {user.email}</div>
          <button onClick={handleLogout} className="btn btn-sm">Logout</button>
        </div>
      )}

      {stage === 'login' && (
        <LoginScreen onLogin={handleLogin} />
      )}

      {stage === 'scanning' && (
        <div className="screen">
          <h1>🔍 Scanning for Routers</h1>
          <p>Looking for MikroTik, Ubiquiti, and other routers on your network...</p>
          <div className="spinner"></div>
          <p style={{ marginTop: '20px', color: '#94a3b8', fontSize: '12px' }}>
            This may take up to 30 seconds
          </p>
        </div>
      )}

      {stage === 'select' && (
        <NetworkScanner routers={routers} onSelect={handleSelectRouter} onRescan={startScan} />
      )}

      {stage === 'config' && selectedRouter && (
        <ConfigForm router={selectedRouter} onConfigure={handleConfigure} onBack={() => setStage('select')} />
      )}

      {stage === 'running' && (
        <ProgressMonitor progress={progress} />
      )}

      {stage === 'success' && result && (
        <SuccessScreen result={result} router={selectedRouter} config={configData} />
      )}

      {stage === 'nofound' && (
        <div className="screen">
          <h1>❌ No Routers Found</h1>
          <p>Could not detect any MikroTik or other compatible routers on your network.</p>
          <p style={{ color: '#94a3b8' }}>Make sure:</p>
          <ul style={{ color: '#cbd5e1', textAlign: 'left', display: 'inline-block' }}>
            <li>Your PC is connected to the same network as the router</li>
            <li>The router is powered on</li>
            <li>SSH (port 22) or Winbox (port 8291) is enabled</li>
          </ul>
          <button onClick={startScan} style={{ marginTop: '20px' }} className="btn btn-primary">
            🔄 Scan Again
          </button>
        </div>
      )}

      {stage === 'error' && (
        <div className="screen">
          <h1>⚠️ Configuration Error</h1>
          <p>Something went wrong during configuration:</p>
          <div style={{ background: '#1e293b', padding: '10px', borderRadius: '8px', maxHeight: '200px', overflow: 'auto', marginBottom: '20px' }}>
            {progress.map((p, i) => (
              <div key={i} style={{ color: p.type === 'error' ? '#fc8181' : p.type === 'failed' ? '#fbbf24' : '#22c55e', marginBottom: '5px', fontSize: '12px' }}>
                {p.type === 'error' ? '❌' : p.type === 'failed' ? '⚠️' : '✅'} {p.text}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
            <button onClick={() => setStage('config')} className="btn btn-secondary">
              ⬅ Try Again
            </button>
            <button onClick={startScan} className="btn btn-primary">
              🔄 Scan New Router
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
