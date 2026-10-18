import React, { useState } from 'react';
const { invoke } = window.__TAURI__.core;

export default function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const result = await invoke('login_user', {
        email,
        password,
        api_url: 'https://backend-services-production-78d8.up.railway.app'
      });

      if (result.token) {
        localStorage.setItem('auth_token', result.token);
        localStorage.setItem('user_email', email);
        localStorage.setItem('reseller_id', result.reseller_id || '');
        onLogin(result);
      } else {
        setError('Invalid email or password');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="screen login-screen">
      <div className="login-card">
        <h1>🔐 SAFE_Links Installer</h1>
        <p>Sign in as a reseller to configure your routers</p>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
              disabled={loading}
            />
          </div>

          <div className="form-group">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              disabled={loading}
            />
          </div>

          {error && <div className="error-message">{error}</div>}

          <button type="submit" disabled={loading} className="btn btn-primary">
            {loading ? '🔄 Signing in...' : '✅ Sign In'}
          </button>
        </form>

        <p style={{ fontSize: '12px', color: '#94a3b8', marginTop: '20px' }}>
          Demo credentials:<br />
          admin@nairobitech.io / reseller123
        </p>
      </div>
    </div>
  );
}
