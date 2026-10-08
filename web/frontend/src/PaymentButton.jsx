import React, { useEffect, useState } from "react";
import { CreditCard, Loader2 } from "lucide-react";
import { T, Btn } from "./ui.jsx";

const BASE_URL = import.meta.env.VITE_API_URL || "";

// Reusable payment button. Drop into CaptivePortal / License renewal.
// Props:
//   purpose: 'voucher' | 'license'
//   amountMajor: number (e.g. 150)
//   currency: 'NGN' | 'USD' | ...
//   email, customerName, customerPhone
//   metadata: object (planId, resellerId, routerId, userId)
//   onSuccess: (result) => void
export default function PaymentButton({
  purpose, amountMajor, currency = "NGN", email, customerName, customerPhone,
  metadata = {}, onSuccess, onError, label = "Pay now",
}) {
  const [providers, setProviders] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${BASE_URL}/api/payments/providers`);
        const data = await res.json();
        setProviders(data.providers || []);
        if (data.providers?.length === 1) setSelected(data.providers[0]);
      } catch {
        setProviders([]);
      }
    })();
  }, []);

  async function pay() {
    if (!selected) return;
    setLoading(true);
    try {
      const res = await fetch(`${BASE_URL}/api/payments/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: selected,
          purpose,
          amountMajor,
          currency,
          email,
          metadata: { ...metadata, customer_name: customerName, customer_phone: customerPhone },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.authorizationUrl) throw new Error(data.error || "Payment failed");
      // Redirect to gateway
      window.location.href = data.authorizationUrl;
    } catch (err) {
      setLoading(false);
      if (onError) onError(err.message);
      else alert(err.message);
    }
  }

  if (providers === null) return <div style={{ color: T.sub, fontSize: 13 }}>Loading payment options…</div>;

  if (providers.length === 0) {
    return (
      <div style={{ background: "#fff3cd", border: "1px solid #ffe58f", borderRadius: 10, padding: 14, fontSize: 13 }}>
        <strong>Online payment not available.</strong>
        <div style={{ marginTop: 4, color: "#856404" }}>
          Please use bank transfer or USSD. Contact your provider for details.
        </div>
      </div>
    );
  }

  const LABELS = {
    paystack: "💳 Pay with Card/USSD/Bank (Paystack)",
    flutterwave: "🌍 Pay with Card/Mobile Money (Flutterwave)",
    stripe: "💳 Pay with Card (Stripe)",
  };

  return (
    <div>
      {providers.length > 1 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 6 }}>Choose payment method:</div>
          {providers.map((p) => (
            <label key={p} style={{ display: "flex", alignItems: "center", gap: 8, padding: 8, border: `1px solid ${selected === p ? T.primary : T.border}`, borderRadius: 8, marginBottom: 6, cursor: "pointer" }}>
              <input type="radio" checked={selected === p} onChange={() => setSelected(p)} />
              <span style={{ fontSize: 13.5 }}>{LABELS[p] || p}</span>
            </label>
          ))}
        </div>
      )}
      <Btn
        onClick={pay}
        disabled={loading || !selected}
        style={{ width: "100%", justifyContent: "center", padding: "12px 0", fontSize: 14 }}
      >
        {loading ? <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> : <CreditCard size={16} />}
        {" "}{loading ? "Redirecting…" : label}
      </Btn>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
