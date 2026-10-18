import React, { useState } from 'react';
const { invoke } = window.__TAURI__.core;

export default function ConfigForm({ router, onConfigure, onBack }) {
  const [adminUser, setAdminUser] = useState('admin');
  const [adminPass, setAdminPass] = useState('');
  const [ssid, setSsid] = useState('SAFE_Links_WiFi');
  const [wifiPassword, setWifiPassword] = useState('');
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleTestConnection = async () => {
    setTesting(true);
    setError('');
    try {
      const result = await invoke('test_ssh', {
        ip: router.ip,
        username: adminUser,
        password: adminPass
      });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(String(err));
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!adminPass || !wifiPassword) {
      setError('All fields required');
      return;
    }
    onConfigure({
      adminUser,
      adminPass,
      ssid,
      wifiPassword
    });
  };

  return (
    <div className="screen">
      <button onClick={onBack} className="btn-back">← Back</button>

      <h1>⚙️ Configure Router</h1>
      <p>Router: <strong>{router.ip}</strong></p>

      <form onSubmit={handleSubmit}>
        <fieldset className="form-section">
          <legend>Router Login</legend>
          
          <div className="form-group">
            <label>Admin Username</label>
            <input
              type="text"
              value={adminUser}
              onChange={(e) => setAdminUser(e.target.value)}
              placeholder="admin"
              required
            />
          </div>

          <div className="form-group">
            <label>Admin Password</label>
            <input
              type="password"
              value={adminPass}
              onChange={(e) => setAdminPass(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>

          <button
            type="button"
            onClick={handleTestConnection}
            disabled={!adminPass || testing}
            className="btn btn-secondary"
          >
            {testing ? '🔄 Testing...' : '🧪'} Test Connection
          </button>

          {error && <div className="error-message">{error}</div>}
          {success && <div className="success-message">✅ Connection successful!</div>}
        </fieldset>

        <fieldset className="form-section">
          <legend>WiFi Network</legend>

          <div className="form-group">
            <label>WiFi Network Name (SSID)</label>
            <input
              type="text"
              value={ssid}
              onChange={(e) => setSsid(e.target.value)}
              placeholder="SAFE_Links_WiFi"
              required
            />
          </div>

          <div className="form-group">
            <label>WiFi Password</label>
            <input
              type="password"
              value={wifiPassword}
              onChange={(e) => setWifiPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
            <small>Min 8 characters, used for end-user WiFi access</small>
          </div>
        </fieldset>

        <button type="submit" className="btn btn-primary btn-large">
          🚀 Configure Router
        </button>
      </form>
    </div>
  );
}
