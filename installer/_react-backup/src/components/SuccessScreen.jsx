import React, { useState } from 'react';

export default function SuccessScreen({ result, router, config }) {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="screen success-screen">
      <div className="success-card">
        <h1>🎉 Configuration Complete!</h1>

        <div className="success-summary">
          <p><strong>Router:</strong> {router.ip}</p>
          <p><strong>WiFi Network:</strong> {config.ssid}</p>
          <p><strong>Status:</strong> {result.final_status}</p>
        </div>

        <div className="steps-completed">
          <h3>✅ Steps Completed:</h3>
          <ul>
            {result.steps_completed.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ul>
        </div>

        {result.steps_failed && result.steps_failed.length > 0 && (
          <div className="steps-failed">
            <h3>⚠️ Issues:</h3>
            <ul>
              {result.steps_failed.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="next-steps">
          <h3>📋 Next Steps:</h3>
          <ol>
            <li>End-users can now connect to WiFi: <strong>{config.ssid}</strong></li>
            <li>They'll be redirected to the login portal</li>
            <li>They can subscribe to data plans and get instant access</li>
            <li>Check your reseller dashboard for new subscriptions</li>
          </ol>
        </div>

        <div className="info-box">
          <p><strong>Portal URL:</strong> https://www.safelinks.name.ng/login</p>
          <p><strong>API Endpoint:</strong> https://backend-services-production-78d8.up.railway.app</p>
          <button onClick={() => copyToClipboard(router.ip)} className="btn btn-sm">
            {copied ? '✅ Copied' : '📋'} Copy Router IP
          </button>
        </div>

        <button onClick={() => window.location.reload()} className="btn btn-primary btn-large">
          🔄 Configure Another Router
        </button>
      </div>
    </div>
  );
}
