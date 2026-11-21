// Reseller "Growth" tab: earnings, automatic payouts, customers + broadcast,
// promotions (promo codes, happy hour, trial, loyalty, referral), sales
// agents + printed voucher cards, message outbox.
import React, { useEffect, useState, useCallback } from "react";
import { T, Panel, Btn, Field, inputStyle, StatCard, Badge, EmptyRow, Loading, formatMoney, timeAgo } from "./ui.jsx";
import { http } from "./api.js";
import { TrendingUp, Wallet, Users, Megaphone, Tag, UserCheck, Printer, MessageSquare, Banknote } from "lucide-react";

function useLoad(path, deps = []) {
  const [state, set] = useState({ loading: true, data: null, error: null });
  const reload = useCallback(() => {
    set((s) => ({ ...s, loading: true }));
    http.get(path).then((data) => set({ loading: false, data, error: null })).catch((e) => set({ loading: false, data: null, error: e.message }));
  }, [path]);
  useEffect(reload, [reload, ...deps]);
  return [state, reload];
}

function Bars({ rows, label, value, fmt }) {
  const max = Math.max(1, ...rows.map((r) => r[value]));
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "110px 1fr 90px", alignItems: "center", gap: 8, fontSize: 12 }}>
          <div style={{ color: T.sub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r[label]}</div>
          <div style={{ background: "#eef2ff", borderRadius: 4, height: 12 }}>
            <div style={{ width: `${(r[value] / max) * 100}%`, background: T.primary, height: 12, borderRadius: 4 }} />
          </div>
          <div style={{ textAlign: "right", fontWeight: 600 }}>{fmt(r[value])}</div>
        </div>
      ))}
      {rows.length === 0 && <EmptyRow text="No sales yet in this period." />}
    </div>
  );
}

const SECTIONS = [
  ["earnings", "Earnings", TrendingUp], ["payouts", "Payouts", Banknote], ["customers", "Customers", Users],
  ["promos", "Promotions", Tag], ["agents", "Agents & cards", UserCheck], ["messages", "Messages", MessageSquare],
];

export default function GrowthTab({ currency = "NGN", plans = [], notify }) {
  const [sec, setSec] = useState("earnings");
  const money = (n) => formatMoney(n, currency);
  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
        {SECTIONS.map(([k, label, Icon]) => (
          <Btn key={k} size="sm" variant={sec === k ? "solid" : "outline"} onClick={() => setSec(k)}><Icon size={13} /> {label}</Btn>
        ))}
      </div>
      {sec === "earnings" && <Earnings money={money} />}
      {sec === "payouts" && <Payouts notify={notify} />}
      {sec === "customers" && <Customers money={money} notify={notify} />}
      {sec === "promos" && <Promotions notify={notify} />}
      {sec === "agents" && <Agents plans={plans} money={money} notify={notify} />}
      {sec === "messages" && <Messages />}
    </div>
  );
}

function Earnings({ money }) {
  const [days, setDays] = useState(30);
  const [e] = useLoad(`/api/reseller/earnings?days=${days}`, [days]);
  if (e.loading && !e.data) return <Loading />;
  if (e.error) return <EmptyRow text={e.error} />;
  const d = e.data;
  const hours = d.period.byHour.filter((h) => h.revenue > 0).map((h) => ({ ...h, label: `${String(h.hour).padStart(2, "0")}:00` }));
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px,1fr))", gap: 12 }}>
        <StatCard icon={TrendingUp} label="Today" value={money(d.today.total)} sub={`${d.today.sales} sales`} />
        <StatCard icon={TrendingUp} label={`Last ${d.days} days`} value={money(d.period.total)} sub={`${d.period.sales} sales`} />
        <StatCard icon={Users} label="Customers" value={d.customers} sub={`${d.activeLogins} online plans now`} />
        <StatCard icon={Wallet} label="Customer wallets" value={money(d.walletFloat)} sub="prepaid, not yet spent" />
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {[7, 30, 90].map((n) => <Btn key={n} size="sm" variant={days === n ? "solid" : "outline"} onClick={() => setDays(n)}>{n} days</Btn>)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px,1fr))", gap: 14 }}>
        <Panel title="Revenue by day"><Bars rows={d.period.byDay.slice(-14)} label="day" value="revenue" fmt={money} /></Panel>
        <Panel title="Revenue by plan"><Bars rows={d.period.byPlan.map((p) => ({ ...p, label: `${p.plan} (${p.sales})` }))} label="label" value="revenue" fmt={money} /></Panel>
        <Panel title="Best hours to sell"><Bars rows={hours} label="label" value="revenue" fmt={money} /></Panel>
        <Panel title="Revenue by router"><Bars rows={d.period.byRouter} label="router" value="revenue" fmt={money} /></Panel>
      </div>
    </div>
  );
}

function Payouts({ notify }) {
  const [s, reload] = useLoad("/api/reseller/growth-settings");
  const [banks, setBanks] = useState([]);
  const [form, setForm] = useState({ bankCode: "", accountNumber: "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => { http.get("/api/reseller/payout/banks").then((r) => setBanks(r.banks || [])).catch(() => {}); }, []);
  if (s.loading && !s.data) return <Loading />;
  const d = s.data || {};
  async function save() {
    setBusy(true);
    try {
      const r = await http.post("/api/reseller/payout", form);
      notify?.(`Payouts on: ${r.accountName}`); reload();
    } catch (e) { notify?.(e.message); }
    setBusy(false);
  }
  return (
    <Panel title="Automatic same-day payouts">
      <div style={{ fontSize: 13, color: T.sub, lineHeight: 1.6, marginBottom: 12 }}>
        Every card and transfer payment from your customers is split by Paystack: your share goes straight to your bank,
        {` ${d.platformFeePct ?? 5}%`} platform fee is kept. No confirming transfers, no chasing payments.
      </div>
      {d.paystack_subaccount ? (
        <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 10, padding: 12, marginBottom: 12, fontSize: 13 }}>
          <b>Payouts are ON</b> to {d.payout_account_name} · {d.payout_account_number}
        </div>
      ) : !d.paystack ? (
        <EmptyRow text="Paystack is not configured on this platform yet." />
      ) : null}
      {d.paystack && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px,1fr))", gap: 10, alignItems: "end" }}>
          <Field label="Bank">
            <select style={inputStyle} value={form.bankCode} onChange={(e) => setForm({ ...form, bankCode: e.target.value })}>
              <option value="">Choose your bank…</option>
              {banks.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="Account number"><input style={inputStyle} inputMode="numeric" maxLength={10} value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value.replace(/\D/g, "") })} placeholder="10 digits" /></Field>
          <Btn disabled={busy} onClick={save}>{d.paystack_subaccount ? "Change payout account" : "Turn on payouts"}</Btn>
        </div>
      )}
    </Panel>
  );
}

function Customers({ money, notify }) {
  const [q, setQ] = useState("");
  const [c, reload] = useLoad(`/api/reseller/customers?q=${encodeURIComponent(q)}`, [q]);
  const [msg, setMsg] = useState("");
  const [seg, setSeg] = useState("all");
  const [busy, setBusy] = useState(false);
  async function send() {
    setBusy(true);
    try {
      const r = await http.post("/api/reseller/customers/broadcast", { message: msg, segment: seg });
      notify?.(`Sent to ${r.recipients} customer(s)${r.providerConfigured ? "" : " (logged — add an SMS provider to deliver)"}`); setMsg("");
    } catch (e) { notify?.(e.message); }
    setBusy(false);
  }
  const rows = c.data?.customers || [];
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <Panel title="Send a promo by SMS / WhatsApp">
        <div style={{ display: "grid", gap: 10 }}>
          <textarea style={{ ...inputStyle, minHeight: 70 }} maxLength={480} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Weekend promo: 2 days for ₦1,000 with code WEEKEND" />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select style={{ ...inputStyle, width: "auto" }} value={seg} onChange={(e) => setSeg(e.target.value)}>
              <option value="all">All customers</option>
              <option value="active">Online now</option>
              <option value="lapsed">Haven't bought in 7+ days</option>
              <option value="never">Trial users who never paid</option>
            </select>
            <Btn disabled={busy || msg.trim().length < 3} onClick={send}><Megaphone size={13} /> Send</Btn>
            <span style={{ fontSize: 11.5, color: T.sub }}>Customers who switched off promos are skipped.</span>
          </div>
        </div>
      </Panel>
      <Panel title={`Customers (${rows.length})`} action={<input style={{ ...inputStyle, width: 200 }} placeholder="Search phone or name" value={q} onChange={(e) => setQ(e.target.value)} />}>
        {c.loading && !c.data ? <Loading /> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", fontSize: 12.5, borderCollapse: "collapse" }}>
              <thead><tr style={{ textAlign: "left", color: T.sub }}>{["Phone", "Name", "Purchases", "Spent", "Wallet", "Status", "Last purchase"].map((h) => <th key={h} style={{ padding: "6px 4px" }}>{h}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={{ borderTop: `1px solid ${T.border}` }}>
                    <td style={{ padding: "7px 4px", fontFamily: "monospace" }}>+{r.phone}</td>
                    <td>{r.name || "—"}</td><td>{r.paid_count}</td><td>{money(r.total_spent)}</td><td>{money(r.wallet_balance)}</td>
                    <td>{Number(r.active_until) > Date.now() ? <Badge tone={T.success}>online plan</Badge> : r.paid_count ? <Badge tone={T.sub}>lapsed</Badge> : <Badge tone={T.warning}>lead</Badge>}{r.auto_renew ? " ↻" : ""}</td>
                    <td>{r.last_purchase_at ? timeAgo(Number(r.last_purchase_at)) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <EmptyRow text="Customers appear here after their first trial or purchase." />}
          </div>
        )}
      </Panel>
    </div>
  );
}

function Promotions({ notify }) {
  const [p, reloadP] = useLoad("/api/reseller/promos");
  const [s, reloadS] = useLoad("/api/reseller/growth-settings");
  const [form, setForm] = useState({ code: "", percentOff: 20, maxUses: 0 });
  const [set, setSet] = useState(null);
  useEffect(() => {
    if (s.data && !set) {
      const d = s.data;
      setSet({ notifyPhone: d.notify_phone || "", trialEnabled: !!d.trial_enabled, trialMinutes: d.trial_minutes ?? 5, loyaltyEvery: d.loyalty_every ?? 10,
        referralRewardMinutes: d.referral_reward_minutes ?? 60, happyHourStart: d.happy_hour_start ?? "", happyHourEnd: d.happy_hour_end ?? "", happyHourPct: d.happy_hour_pct ?? 0, dailySummary: !!d.daily_summary });
    }
  }, [s.data, set]);
  async function addPromo() {
    try { await http.post("/api/reseller/promos", form); setForm({ code: "", percentOff: 20, maxUses: 0 }); reloadP(); notify?.("Promo code created"); } catch (e) { notify?.(e.message); }
  }
  async function saveSettings() {
    try { await http.put("/api/reseller/growth-settings", set); reloadS(); notify?.("Saved"); } catch (e) { notify?.(e.message); }
  }
  const num = (k) => ({ type: "number", style: inputStyle, value: set?.[k] ?? "", onChange: (e) => setSet({ ...set, [k]: e.target.value }) });
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <Panel title="Customer rewards & alerts">
        {!set ? <Loading /> : (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px,1fr))", gap: 10 }}>
              <Field label="Your WhatsApp/SMS number" hint="Daily earnings + router-down alerts"><input style={inputStyle} value={set.notifyPhone} onChange={(e) => setSet({ ...set, notifyPhone: e.target.value })} placeholder="0803 000 0000" /></Field>
              <Field label="Free trial (minutes)" hint="0 = off · once per phone per day"><input {...num("trialMinutes")} /></Field>
              <Field label="Loyalty: every Nth purchase free" hint="refunded to wallet · 0 = off"><input {...num("loyaltyEvery")} /></Field>
              <Field label="Referral reward (minutes)" hint="free login for the referrer"><input {...num("referralRewardMinutes")} /></Field>
              <Field label="Happy hour starts (0-23)"><input {...num("happyHourStart")} /></Field>
              <Field label="Happy hour ends (0-23)"><input {...num("happyHourEnd")} /></Field>
              <Field label="Happy hour discount %"><input {...num("happyHourPct")} /></Field>
            </div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
              <label><input type="checkbox" checked={set.trialEnabled} onChange={(e) => setSet({ ...set, trialEnabled: e.target.checked })} /> Free trial on</label>
              <label><input type="checkbox" checked={set.dailySummary} onChange={(e) => setSet({ ...set, dailySummary: e.target.checked })} /> Daily earnings message (9pm)</label>
            </div>
            <div><Btn onClick={saveSettings}>Save</Btn></div>
          </div>
        )}
      </Panel>
      <Panel title="Promo codes">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px,1fr))", gap: 10, alignItems: "end", marginBottom: 12 }}>
          <Field label="Code"><input style={inputStyle} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="WEEKEND" /></Field>
          <Field label="% off"><input type="number" style={inputStyle} value={form.percentOff} onChange={(e) => setForm({ ...form, percentOff: e.target.value })} /></Field>
          <Field label="Max uses (0 = ∞)"><input type="number" style={inputStyle} value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: e.target.value })} /></Field>
          <Btn onClick={addPromo} disabled={form.code.length < 3}><Tag size={13} /> Create</Btn>
        </div>
        {(p.data?.promos || []).filter((x) => x.active).map((x) => (
          <div key={x.id} style={{ display: "flex", justifyContent: "space-between", padding: "8px 4px", borderTop: `1px solid ${T.border}`, fontSize: 13 }}>
            <span><b style={{ fontFamily: "monospace" }}>{x.code}</b> · {x.percent_off ? `${x.percent_off}% off` : `${x.amount_off} off`} · used {x.uses}{x.max_uses ? `/${x.max_uses}` : ""}</span>
            <Btn size="sm" variant="ghost" tone={T.danger} onClick={async () => { await http.del(`/api/reseller/promos/${x.id}`); reloadP(); }}>Remove</Btn>
          </div>
        ))}
      </Panel>
    </div>
  );
}

function Agents({ plans, money, notify }) {
  const [a, reload] = useLoad("/api/reseller/agents");
  const [form, setForm] = useState({ name: "", phone: "", commissionPct: 10 });
  const [cardForm, setCardForm] = useState({ planId: "", count: 10, agentId: "" });
  const [cards, setCards] = useState(null);
  async function addAgent() {
    try { await http.post("/api/reseller/agents", form); setForm({ name: "", phone: "", commissionPct: 10 }); reload(); } catch (e) { notify?.(e.message); }
  }
  async function makeCards() {
    try { const r = await http.post("/api/reseller/cards", { ...cardForm, count: Number(cardForm.count) }); setCards(r); reload(); } catch (e) { notify?.(e.message); }
  }
  function printCards() {
    const w = window.open("", "_blank");
    if (!w) return;
    const html = cards.cards.map((c) => `<div class="c"><div class="p">${c.plan}</div><div class="k">Code</div><div class="v">${c.code}</div><div class="k">Password</div><div class="v">${c.password}</div><div class="f">Connect to the WiFi, open any page, tap "Enter voucher".</div></div>`).join("");
    w.document.write(`<html><head><title>Voucher cards</title><style>body{font-family:sans-serif}.g{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.c{border:1px dashed #555;padding:10px;border-radius:8px;break-inside:avoid}.p{font-weight:700}.k{font-size:10px;color:#666;margin-top:4px}.v{font:700 16px monospace}.f{font-size:9px;color:#666;margin-top:6px}</style></head><body><div class="g">${html}</div><script>print()</script></body></html>`);
    w.document.close();
  }
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <Panel title="Print voucher cards">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px,1fr))", gap: 10, alignItems: "end" }}>
          <Field label="Plan"><select style={inputStyle} value={cardForm.planId} onChange={(e) => setCardForm({ ...cardForm, planId: e.target.value })}><option value="">Choose…</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="How many"><input type="number" style={inputStyle} value={cardForm.count} onChange={(e) => setCardForm({ ...cardForm, count: e.target.value })} /></Field>
          <Field label="For agent (optional)"><select style={inputStyle} value={cardForm.agentId} onChange={(e) => setCardForm({ ...cardForm, agentId: e.target.value })}><option value="">— none —</option>{(a.data?.agents || []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
          <Btn disabled={!cardForm.planId} onClick={makeCards}><Printer size={13} /> Create cards</Btn>
        </div>
        {cards && (
          <div style={{ marginTop: 12, fontSize: 13 }}>
            {cards.cards.length} cards created{cards.agent ? ` for ${cards.agent}` : ""}. Time starts on first use. <Btn size="sm" onClick={printCards}><Printer size={12} /> Print</Btn>
          </div>
        )}
      </Panel>
      <Panel title="Sales agents">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px,1fr))", gap: 10, alignItems: "end", marginBottom: 12 }}>
          <Field label="Name"><input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Phone"><input style={inputStyle} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Commission %"><input type="number" style={inputStyle} value={form.commissionPct} onChange={(e) => setForm({ ...form, commissionPct: e.target.value })} /></Field>
          <Btn disabled={!form.name} onClick={addAgent}><UserCheck size={13} /> Add agent</Btn>
        </div>
        {(a.data?.agents || []).map((x) => (
          <div key={x.id} style={{ display: "flex", justifyContent: "space-between", padding: "8px 4px", borderTop: `1px solid ${T.border}`, fontSize: 13 }}>
            <span><b>{x.name}</b> · {x.commission_pct}% · cards sold {x.sold}/{x.cards}</span>
            <span>sales {money(x.revenue)} · <b>owed {money(x.commission)}</b></span>
          </div>
        ))}
        {(a.data?.agents || []).length === 0 && <EmptyRow text="Add agents who sell your printed cards; their commission is tracked here." />}
      </Panel>
    </div>
  );
}

function Messages() {
  const [m] = useLoad("/api/reseller/messages");
  const rows = m.data?.messages || [];
  return (
    <Panel title="Messages sent (SMS / WhatsApp)">
      {m.loading && !m.data ? <Loading /> : rows.map((r, i) => (
        <div key={i} style={{ padding: "8px 4px", borderTop: `1px solid ${T.border}`, fontSize: 12.5 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}><b>{r.kind}</b><span style={{ color: T.sub }}>+{r.to_phone} · {timeAgo(Number(r.created_at))} · <Badge tone={r.status === "sent" ? T.success : r.status === "failed" ? T.danger : T.sub}>{r.status}</Badge></span></div>
          <div style={{ color: T.sub, marginTop: 2 }}>{r.body}</div>
        </div>
      ))}
      {!m.loading && rows.length === 0 && <EmptyRow text="Reminders, receipts and promos you send appear here." />}
    </Panel>
  );
}

// "Add a router" for ANY computer: one line pasted into Winbox > New Terminal.
export function RouterSetupPanel({ notify, defaultSsid = "" }) {
  const [f, setF] = useState({ ssid: defaultSsid, wifiPassword: "", wanMode: "dhcp", wanUser: "", wanPass: "" });
  const [out, setOut] = useState(null);
  async function create() {
    try { setOut(await http.post("/api/reseller/pairing-codes", f)); } catch (e) { notify?.(e.message); }
  }
  return (
    <Panel title="Add a router — one line, any MikroTik">
      <div style={{ fontSize: 13, color: T.sub, marginBottom: 10, lineHeight: 1.5 }}>
        Fill in the WiFi name, create a setup line, then in Winbox open <b>New Terminal</b> on the router and paste it.
        The router configures the hotspot, WiFi, DHCP and payments, pairs with your account and shows Online here in about a minute.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px,1fr))", gap: 10, alignItems: "end" }}>
        <Field label="WiFi name (SSID)"><input style={inputStyle} value={f.ssid} maxLength={32} onChange={(e) => setF({ ...f, ssid: e.target.value })} /></Field>
        <Field label="WiFi password" hint="empty = open WiFi (normal for hotspots)"><input style={inputStyle} value={f.wifiPassword} onChange={(e) => setF({ ...f, wifiPassword: e.target.value })} /></Field>
        <Field label="Internet (WAN) on ether1">
          <select style={inputStyle} value={f.wanMode} onChange={(e) => setF({ ...f, wanMode: e.target.value })}><option value="dhcp">Automatic (DHCP)</option><option value="pppoe">PPPoE (username/password)</option></select>
        </Field>
        {f.wanMode === "pppoe" && <>
          <Field label="PPPoE username"><input style={inputStyle} value={f.wanUser} onChange={(e) => setF({ ...f, wanUser: e.target.value })} /></Field>
          <Field label="PPPoE password"><input style={inputStyle} value={f.wanPass} onChange={(e) => setF({ ...f, wanPass: e.target.value })} /></Field>
        </>}
        <Btn onClick={create}>Create setup line</Btn>
      </div>
      {out && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, color: T.sub, marginBottom: 6 }}>Code <b>{out.code}</b> · valid 60 minutes · one router per code</div>
          <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
            <code style={{ flex: 1, background: "#0f172a", color: "#e2e8f0", padding: 10, borderRadius: 8, fontSize: 11.5, wordBreak: "break-all" }}>{out.command}</code>
            <Btn onClick={() => { try { navigator.clipboard.writeText(out.command); notify?.("Copied — paste it in Winbox > New Terminal"); } catch (_) {} }}>Copy</Btn>
          </div>
        </div>
      )}
    </Panel>
  );
}
