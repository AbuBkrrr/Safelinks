// Captive-portal customer features: free trial, promo/referral codes with a
// live price, "My account" (phone sign-in, wallet, auto-renew, referral,
// promo opt-out) and the time/data remaining bar.
import React, { useEffect, useState } from "react";
import { T, Btn, Field, inputStyle, formatMoney } from "./ui.jsx";
import { Gift, Wallet, RefreshCw, Share2, Clock } from "lucide-react";

const base = () => import.meta.env.VITE_API_URL || "";
async function call(method, path, body, token) {
  const r = await fetch(base() + path, {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

const fmtLeft = (ms) => {
  if (ms <= 0) return "expired";
  const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${h}h left` : h ? `${h}h ${m % 60}m left` : `${m} min left`;
};
const fmtBytes = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(2)} GB` : `${Math.round(b / 1048576)} MB`);

function Bar({ pct, color }) {
  return (
    <div style={{ background: "#e9ecf5", borderRadius: 6, height: 10, overflow: "hidden" }}>
      <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color, height: 10, transition: "width .4s" }} />
    </div>
  );
}

/** Time + data remaining for this device's current plan. */
export function UsageCard({ resellerId, clientMac, color, onRenew }) {
  const [u, setU] = useState(null);
  useEffect(() => {
    if (!clientMac) return;
    let stop = false;
    const load = () => call("GET", `/api/portal/${resellerId}/usage?mac=${encodeURIComponent(clientMac)}`).then((j) => !stop && setU(j)).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => { stop = true; clearInterval(t); };
  }, [resellerId, clientMac]);
  if (!u?.active) return null;
  const x = u.usage, now = Date.now();
  const timePct = ((x.expiresAt - now) / Math.max(1, x.expiresAt - x.startedAt)) * 100;
  const dataPct = x.dataLimitMb ? 100 - (x.bytesUsed / (x.dataLimitMb * 1048576)) * 100 : null;
  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 12, padding: 14, marginBottom: 14, background: "#fff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontWeight: 700, color: T.ink, fontSize: 14 }}>{x.plan}</div>
        <div style={{ fontSize: 12, color: T.success, fontWeight: 600 }}>● Connected</div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: T.sub, marginBottom: 4 }}>
        <span><Clock size={11} /> Time</span><span>{fmtLeft(x.expiresAt - now)}</span>
      </div>
      <Bar pct={timePct} color={timePct < 15 ? T.danger : color || T.primary} />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: T.sub, margin: "10px 0 4px" }}>
        <span>Data</span><span>{x.dataLimitMb ? `${fmtBytes(Math.max(0, x.dataLimitMb * 1048576 - x.bytesUsed))} left of ${fmtBytes(x.dataLimitMb * 1048576)}` : `${fmtBytes(x.bytesUsed)} used · unlimited`}</span>
      </div>
      <Bar pct={dataPct ?? 100} color={dataPct != null && dataPct < 15 ? T.danger : T.success} />
      {onRenew && <Btn variant="outline" onClick={onRenew} style={{ width: "100%", justifyContent: "center", marginTop: 12 }}><RefreshCw size={13} /> Add more time</Btn>}
    </div>
  );
}

/** Free trial: phone number in, short login out (the portal then logs in). */
export function TrialCard({ resellerId, minutes, clientMac, onVoucher }) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!minutes) return null;
  async function go() {
    setBusy(true); setErr(null);
    try { const j = await call("POST", `/api/portal/${resellerId}/trial`, { phone, clientMac }); onVoucher(j.voucher); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  }
  return (
    <div style={{ border: `1.5px dashed ${T.success}`, borderRadius: 12, padding: 12, margin: "12px 0", background: "#f0fdf4" }}>
      {!open ? (
        <Btn variant="ghost" tone={T.success} onClick={() => setOpen(true)} style={{ width: "100%", justifyContent: "center" }}>
          <Gift size={15} /> Try free for {minutes} minutes
        </Btn>
      ) : (
        <div>
          <div style={{ fontSize: 12.5, color: T.ink, marginBottom: 8 }}>Enter your phone number for {minutes} free minutes:</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input style={inputStyle} inputMode="tel" placeholder="0803 000 0000" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <Btn disabled={busy || phone.length < 10} onClick={go} tone={T.success}>{busy ? "…" : "Start"}</Btn>
          </div>
          {err && <div style={{ color: T.danger, fontSize: 12, marginTop: 6 }}>{err}</div>}
        </div>
      )}
    </div>
  );
}

/** Promo + referral fields with a live price under them. */
export function PromoFields({ resellerId, plan, cur, promo, setPromo, referral, setReferral, onQuote }) {
  const [q, setQ] = useState(null);
  useEffect(() => {
    if (!plan) return;
    const t = setTimeout(() => {
      call("GET", `/api/portal/${resellerId}/quote?planId=${encodeURIComponent(plan.id)}&promo=${encodeURIComponent(promo || "")}`)
        .then((j) => { setQ(j); onQuote?.(j); }).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [resellerId, plan, promo]);
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <Field label="Promo code (optional)"><input style={inputStyle} value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} placeholder="CODE" /></Field>
        <Field label="Friend's referral code"><input style={inputStyle} value={referral} onChange={(e) => setReferral(e.target.value.toUpperCase())} placeholder="optional" /></Field>
      </div>
      {q && (
        <div style={{ fontSize: 13, margin: "2px 0 12px", color: q.promoError ? T.danger : T.ink }}>
          {q.promoError ? q.promoError : q.discount > 0
            ? <>You pay <b>{formatMoney(q.total, cur)}</b> <s style={{ color: T.sub }}>{formatMoney(q.price, cur)}</s> · {q.notes.join(" · ")}</>
            : <>You pay <b>{formatMoney(q.total, cur)}</b></>}
        </div>
      )}
    </div>
  );
}

/** My account: phone sign-in (OTP), wallet, auto-renew, referral, opt-out. */
export function AccountPanel({ resellerId, plans, cur, clientMac, instantTransfer, onVoucher, onClose, notify }) {
  const key = `sl_cust_${resellerId}`;
  const [token, setToken] = useState(() => { try { return localStorage.getItem(key); } catch (_) { return null; } });
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(null);
  const [me, setMe] = useState(null);
  const [err, setErr] = useState(null);
  const [topup, setTopup] = useState("1000");
  const [account, setAccount] = useState(null);
  const [renewPlan, setRenewPlan] = useState("");

  const load = () => call("GET", `/api/portal/${resellerId}/me?mac=${encodeURIComponent(clientMac || "")}`, null, token)
    .then((j) => { setMe(j); setRenewPlan(j.autoRenewPlanId || plans[0]?.id || ""); })
    .catch(() => { setToken(null); try { localStorage.removeItem(key); } catch (_) {} });
  useEffect(() => { if (token) load(); }, [token]);
  // While a top-up account is shown, refresh balance until it lands.
  useEffect(() => {
    if (!account) return;
    const t = setInterval(async () => {
      try {
        const s = await call("GET", `/api/portal/${resellerId}/transfer-status/${encodeURIComponent(account.reference)}`);
        if (s.status === "paid") { setAccount(null); load(); notify?.("Wallet topped up"); }
      } catch (_) {}
    }, 4000);
    return () => clearInterval(t);
  }, [account]);

  const run = async (fn) => { setErr(null); try { await fn(); } catch (e) { setErr(e.message); } };

  if (!token) {
    return (
      <div>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6, color: T.ink }}>My account</div>
        <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 12 }}>Wallet, auto-renew and your referral code. Sign in with your phone.</div>
        {!sent ? (
          <>
            <Field label="Phone number"><input style={inputStyle} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0803 000 0000" /></Field>
            <Btn style={{ width: "100%", justifyContent: "center" }} onClick={() => run(async () => { const j = await call("POST", `/api/portal/${resellerId}/otp`, { phone }); setSent(j); })}>Send code</Btn>
          </>
        ) : (
          <>
            <Field label="Code we sent you" hint={sent.devCode ? `test mode code: ${sent.devCode}` : undefined}><input style={inputStyle} inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
            <Btn style={{ width: "100%", justifyContent: "center" }} onClick={() => run(async () => {
              const j = await call("POST", `/api/portal/${resellerId}/otp/verify`, { phone, code });
              try { localStorage.setItem(key, j.token); } catch (_) {}
              setToken(j.token);
            })}>Sign in</Btn>
          </>
        )}
        {err && <div style={{ color: T.danger, fontSize: 12, marginTop: 8 }}>{err}</div>}
        <Btn variant="ghost" onClick={onClose} style={{ width: "100%", justifyContent: "center", marginTop: 8 }}>Back</Btn>
      </div>
    );
  }
  if (!me) return <div style={{ padding: 20, textAlign: "center", color: T.sub }}>Loading…</div>;
  const plan = plans.find((p) => p.id === renewPlan);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: T.ink }}>My account</div>
        <div style={{ fontSize: 12, color: T.sub }}>+{me.phone}</div>
      </div>
      <div style={{ background: "linear-gradient(135deg,#667eea,#764ba2)", color: "#fff", borderRadius: 12, padding: 14, marginBottom: 12 }}>
        <div style={{ fontSize: 12, opacity: 0.85 }}><Wallet size={12} /> Wallet balance</div>
        <div style={{ fontSize: 26, fontWeight: 800 }}>{formatMoney(me.wallet, cur)}</div>
        {me.loyaltyEvery > 0 && <div style={{ fontSize: 11.5, opacity: 0.9 }}>Every {me.loyaltyEvery}th purchase is free · {me.paidCount % me.loyaltyEvery}/{me.loyaltyEvery} so far</div>}
      </div>

      {instantTransfer && !account && (
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input style={inputStyle} inputMode="numeric" value={topup} onChange={(e) => setTopup(e.target.value.replace(/\D/g, ""))} />
          <Btn onClick={() => run(async () => setAccount(await call("POST", `/api/portal/${resellerId}/transfer-checkout`, { purpose: "wallet", amount: Number(topup), phone: me.phone, name: me.name || "Customer" })))}>Top up</Btn>
        </div>
      )}
      {account && (
        <div style={{ background: "#f8f9fa", borderRadius: 10, padding: 12, marginBottom: 12, fontSize: 13 }}>
          Transfer <b>{formatMoney(account.amount, cur)}</b> to <b>{account.bankName}</b> <b style={{ fontFamily: "monospace", fontSize: 16 }}>{account.accountNumber}</b>
          <div style={{ fontSize: 11.5, color: T.sub, marginTop: 4 }}>Your balance updates by itself when it lands.</div>
        </div>
      )}

      <div style={{ fontWeight: 600, fontSize: 13, margin: "6px 0", color: T.ink }}>Buy with wallet</div>
      <div style={{ display: "grid", gap: 6, marginBottom: 12 }}>
        {plans.map((p) => (
          <Btn key={p.id} variant="outline" disabled={me.wallet < p.price} style={{ justifyContent: "space-between" }}
            onClick={() => run(async () => { const j = await call("POST", `/api/portal/${resellerId}/me/buy`, { planId: p.id, clientMac }, token); onVoucher(j.voucher); })}>
            <span>{p.name}</span><span>{formatMoney(p.price, cur)}</span>
          </Btn>
        ))}
      </div>

      <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 12, marginBottom: 12 }}>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, fontWeight: 600 }}>
          <input type="checkbox" checked={me.autoRenew} onChange={(e) => run(async () => { await call("POST", `/api/portal/${resellerId}/me/auto-renew`, { on: e.target.checked, planId: renewPlan }, token); load(); })} />
          <RefreshCw size={13} /> Auto-renew from wallet
        </label>
        <select style={{ ...inputStyle, marginTop: 8 }} value={renewPlan} onChange={(e) => setRenewPlan(e.target.value)}>
          {plans.map((p) => <option key={p.id} value={p.id}>{p.name} · {formatMoney(p.price, cur)}</option>)}
        </select>
        <div style={{ fontSize: 11.5, color: T.sub, marginTop: 6 }}>
          {me.autoRenew ? `Renews ${plan?.name || "your plan"} automatically before it runs out.` : "Never get cut off: we renew just before your time ends."}
        </div>
      </div>

      {me.referralCode && (
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 12, marginBottom: 12, fontSize: 13 }}>
          <Share2 size={13} /> Your referral code: <b style={{ fontFamily: "monospace", fontSize: 16 }}>{me.referralCode}</b>
          <div style={{ fontSize: 11.5, color: T.sub, marginTop: 4 }}>A friend enters it when they buy — you get {me.referralRewardMinutes} free minutes.</div>
        </div>
      )}
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: T.sub, marginBottom: 10 }}>
        <input type="checkbox" checked={me.marketing} onChange={(e) => run(async () => { await call("POST", `/api/portal/${resellerId}/me/marketing`, { on: e.target.checked }, token); load(); })} />
        Send me promos and offers
      </label>
      {err && <div style={{ color: T.danger, fontSize: 12, marginBottom: 8 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <Btn variant="ghost" onClick={onClose} style={{ flex: 1, justifyContent: "center" }}>Back</Btn>
        <Btn variant="ghost" tone={T.sub} onClick={() => { try { localStorage.removeItem(key); } catch (_) {} setToken(null); setMe(null); }} style={{ flex: 1, justifyContent: "center" }}>Sign out</Btn>
      </div>
    </div>
  );
}
