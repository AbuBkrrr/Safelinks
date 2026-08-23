import React, { useMemo, useState } from "react";
import {
  Shield, Building2, Users, DollarSign, Router, Bell, BarChart3, Package,
  Activity, Server, LifeBuoy, AlertCircle, MessageSquare, Mail, Gauge, Cpu,
  CreditCard, Settings as SettingsIcon, Save, CheckCircle2, ChevronRight, Gift,
  KeyRound, Download, Ban, Copy,
} from "lucide-react";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import {
  T, Shell, Panel, StatCard, Badge, Btn, Field, inputStyle, EmptyRow, Loading,
  statusColor, timeAgo, formatMoney, CURRENCIES, AttachmentPicker,
} from "./ui.jsx";
import { api, fileToBase64 } from "./api.js";
import { useResource } from "./hooks.js";
import { LANGUAGES } from "./i18n.js";
import { dt } from "./dashboardI18n.js";

export default function SuperAdminApp({ session, onExit, notify }) {
  const [tab, setTab] = useState("overview");

  const resellers = useResource(() => api.admin.resellers(), [], (r) => r.resellers);
  const platformPlans = useResource(() => api.admin.platformPlans(), [], (r) => r.plans);
  const installations = useResource(() => api.admin.installations(), [], (r) => r.installations);
  const sessions = useResource(() => api.admin.sessions(), [], (r) => r.sessions);
  const monitoring = useResource(() => api.admin.monitoring(), []);
  const licensePayments = useResource(() => api.admin.licensePayments(), [], (r) => r.licensePayments);
  const support = useResource(() => api.admin.support(), [], (r) => r.tickets);
  const notifications = useResource(() => api.admin.notifications(), [], (r) => r.notifications);
  const settingsRes = useResource(() => api.admin.settings(), []);
  const referrals = useResource(() => api.admin.referrals(), []);
  const keySummary = useResource(() => api.admin.productKeySummary(), [], (r) => r.batches);
  const platformCurrency = settingsRes.data?.platformCurrency ?? settingsRes.data?.platform_currency ?? "USD";
  const dashboardLang = settingsRes.data?.dashboardLanguage ?? settingsRes.data?.dashboard_language ?? "en";

  const openTickets = (support.data || []).filter((t) => t.status === "open").length;
  const unreadNotifs = (notifications.data || []).filter((n) => !n.read).length;
  const pendingLicensePayments = (licensePayments.data || []).filter((p) => p.status === "pending").length;
  const pendingReferralBonuses = (referrals.data?.referrals || []).filter((r) => r.status === "signed_up").length;

  const tabs = [
    { key: "overview", label: dt(dashboardLang, "tabOverview"), icon: BarChart3 },
    { key: "resellers", label: dt(dashboardLang, "tabResellers"), icon: Building2 },
    { key: "plans", label: dt(dashboardLang, "tabPlans"), icon: Package },
    { key: "installs", label: dt(dashboardLang, "tabInstalls"), icon: Router },
    { key: "sessions", label: dt(dashboardLang, "tabSessions"), icon: Activity },
    { key: "monitoring", label: dt(dashboardLang, "tabMonitoring"), icon: Server },
    { key: "license", label: dt(dashboardLang, "tabLicense"), icon: CreditCard },
    { key: "referrals", label: dt(dashboardLang, "tabReferrals"), icon: Gift },
    { key: "productKeys", label: dt(dashboardLang, "tabProductKeys"), icon: KeyRound },
    { key: "support", label: dt(dashboardLang, "tabSupport"), icon: LifeBuoy },
    { key: "notifications", label: dt(dashboardLang, "tabNotifications"), icon: Bell },
    { key: "settings", label: dt(dashboardLang, "tabSettings"), icon: SettingsIcon },
  ];

  const activeResellers = (resellers.data || []).filter((r) => r.status === "active").length;
  const totalVouchers = (resellers.data || []).reduce((s, r) => s + (r.voucherCount || 0), 0);
  const vouchersByReseller = (resellers.data || []).map((r) => ({ name: r.companyName.split(" ")[0], vouchers: r.voucherCount || 0 }));

  async function setResellerStatus(id, status) {
    try {
      await api.admin.setResellerStatus(id, status);
      notify(`Reseller ${status === "active" ? "activated" : "suspended"}.`);
      resellers.refetch();
    } catch (err) { notify(err.message); }
  }

  async function markAllRead() {
    try {
      await api.admin.markNotificationsRead();
      notifications.refetch();
    } catch (err) { notify(err.message); }
  }

  async function onNotificationClick(n) {
    if (!n.read) {
      try { await api.admin.markNotificationRead(n.id); notifications.refetch(); } catch { /* non-fatal */ }
    }
    if (n.action_tab) setTab(n.action_tab);
  }

  const [planEdits, setPlanEdits] = useState(null);
  async function savePlatformPlan(p) {
    try {
      await api.admin.updatePlatformPlan(p.id, { price: Number(p.price) });
      notify(`${p.name} pricing updated.`);
      setPlanEdits(null);
      platformPlans.refetch();
    } catch (err) { notify(err.message); }
  }

  const [reply, setReply] = useState({});
  const [replyAttachment, setReplyAttachment] = useState({});
  async function uploadSupportAttachment(blob, mimeType, filename) {
    const dataBase64 = await fileToBase64(blob);
    return api.admin.uploadSupportAttachment({ filename, mimeType, dataBase64 });
  }
  async function sendReply(id) {
    const msg = reply[id];
    const attachment = replyAttachment[id];
    if (!msg && !attachment) return;
    try {
      await api.admin.sendSupportMessage(id, msg || "", attachment || null);
      setReply((r) => ({ ...r, [id]: "" }));
      setReplyAttachment((r) => ({ ...r, [id]: null }));
      support.refetch();
    } catch (err) { notify(err.message); }
  }
  async function setTicketStatus(id, status) {
    try {
      await api.admin.setSupportStatus(id, status);
      notify(status === "resolved" ? "Marked resolved." : "Reopened.");
      support.refetch();
    } catch (err) { notify(err.message); }
  }

  async function decideLicensePayment(id, decision) {
    try {
      await api.admin.decideLicensePayment(id, decision);
      notify(decision === "confirmed" ? "License payment confirmed — reseller's plan extended." : "Payment rejected.");
      licensePayments.refetch();
      resellers.refetch();
    } catch (err) { notify(err.message); }
  }

  async function markReferralPaid(id) {
    try {
      await api.admin.markReferralPaid(id);
      notify("Referral bonus marked as paid.");
      referrals.refetch();
    } catch (err) { notify(err.message); }
  }

  const [keyGenForm, setKeyGenForm] = useState({ count: 100, planId: "", durationDays: 30, batchLabel: "" });
  const [keyGenerating, setKeyGenerating] = useState(false);
  const [lastGeneratedBatch, setLastGeneratedBatch] = useState(null);

  async function generateKeys() {
    if (!keyGenForm.planId) return notify("Choose a plan first.");
    if (!keyGenForm.count || keyGenForm.count < 1 || keyGenForm.count > 5000) return notify("Count must be between 1 and 5000.");
    setKeyGenerating(true);
    try {
      const res = await api.admin.generateProductKeys({
        count: Number(keyGenForm.count),
        planId: keyGenForm.planId,
        durationDays: Number(keyGenForm.durationDays) || 30,
        batchLabel: keyGenForm.batchLabel || undefined,
      });
      setLastGeneratedBatch(res);
      notify(`Generated ${res.count} keys in batch "${res.batchLabel}".`);
      keySummary.refetch();
    } catch (err) { notify(err.message); }
    setKeyGenerating(false);
  }

  async function downloadKeys(batchLabel, status) {
    try {
      await api.admin.downloadProductKeys({ batchLabel, status });
    } catch (err) { notify(err.message); }
  }

  async function revokeBatch(batchLabel) {
    try {
      const res = await api.admin.revokeProductKeyBatch(batchLabel);
      notify(`Revoked ${res.revoked} unused key${res.revoked === 1 ? "" : "s"} in "${batchLabel}".`);
      keySummary.refetch();
    } catch (err) { notify(err.message); }
  }
  const [editingBonusId, setEditingBonusId] = useState(null);
  const [editingBonusValue, setEditingBonusValue] = useState("");
  async function saveReferralBonus(id) {
    const value = Number(editingBonusValue);
    if (!Number.isFinite(value) || value < 0) return notify("Enter a valid non-negative amount.");
    try {
      await api.admin.updateReferralBonus(id, value);
      setEditingBonusId(null);
      referrals.refetch();
    } catch (err) { notify(err.message); }
  }

  const [settingsForm, setSettingsForm] = useState(null);
  const settings = settingsForm || settingsRes.data;
  async function saveSettings() {
    try {
      await api.admin.updateSettings(settings);
      notify("Settings saved.");
      settingsRes.refetch();
      setSettingsForm(null);
    } catch (err) { notify(err.message); }
  }

  return (
    <Shell roleLabel="Super Admin" roleIcon={Shield} tone={T.secondary} identity={session?.user?.email || ""}
      tabs={tabs} active={tab} onTab={setTab} onExit={onExit}
      badges={{ support: openTickets, notifications: unreadNotifs, license: pendingLicensePayments, referrals: pendingReferralBonuses }}
      notifications={notifications.data} dashboardLang={dashboardLang}>

      {tab === "overview" && (
        <>
          <div style={{ display: "flex", gap: 14, marginBottom: 18, flexWrap: "wrap" }}>
            <StatCard icon={Building2} label="Active resellers" value={activeResellers} sub={`${(resellers.data || []).length} total`} tone={T.secondary} />
            <StatCard icon={Users} label="Total vouchers issued" value={totalVouchers} sub="across all resellers" tone={T.primary} />
            <StatCard icon={LifeBuoy} label="Open support tickets" value={openTickets} sub="awaiting your reply" tone={T.warning} />
            <StatCard icon={CreditCard} label="License payments" value={pendingLicensePayments} sub="awaiting confirmation" tone={pendingLicensePayments ? T.warning : T.success} />
          </div>
          {resellers.loading ? <Loading /> : (
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              <Panel title="Vouchers by reseller" style={{ flex: 1, minWidth: 340 }}>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={vouchersByReseller}>
                    <CartesianGrid stroke={T.border} vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11, fill: T.sub }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: T.sub }} axisLine={false} tickLine={false} width={30} allowDecimals={false} />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: `1px solid ${T.border}` }} />
                    <Bar dataKey="vouchers" fill={T.primary} radius={[5, 5, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Panel>
              {monitoring.data && (
                <Panel title="Fleet snapshot" style={{ flex: 1, minWidth: 260 }}>
                  <div style={{ fontSize: 13, lineHeight: 2.1 }}>
                    <div>Router uptime: <b>{monitoring.data.routerUptimePct}%</b> ({monitoring.data.onlineRouters}/{monitoring.data.totalRouters} online)</div>
                    <div>Command queue pending: <b>{monitoring.data.commandQueuePending}</b></div>
                    <div>Failed deliveries pending retry: <b>{monitoring.data.deliveryQueuePending}</b></div>
                  </div>
                </Panel>
              )}
            </div>
          )}
        </>
      )}

      {tab === "resellers" && (
        <Panel title="All resellers" action={<Badge tone={T.primary}>{(resellers.data || []).length} total</Badge>}>
          {resellers.loading ? <Loading /> : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: T.sub, fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4 }}>
                  <th style={{ padding: "6px 8px" }}>Company</th><th>License key</th><th>Plan</th><th>Vouchers</th><th>Status</th><th>Expiry</th><th></th>
                </tr>
              </thead>
              <tbody>
                {(resellers.data || []).map((r) => {
                  const expired = r.subscriptionExpiry < Date.now();
                  const planName = (platformPlans.data || []).find((p) => p.id === r.subscriptionPlan)?.name || r.subscriptionPlan;
                  return (
                    <tr key={r.id} style={{ borderTop: `1px solid ${T.border}` }}>
                      <td style={{ padding: "10px 8px", fontWeight: 600, color: T.ink }}>{r.companyName}
                        <div style={{ fontWeight: 400, color: T.sub, fontSize: 12 }}>{r.email}</div>
                      </td>
                      <td style={{ fontFamily: "monospace", fontSize: 12.5 }}>{r.licenseKey}</td>
                      <td>{planName}</td>
                      <td>{r.voucherCount}</td>
                      <td><Badge tone={statusColor(r.status)}>{r.status}</Badge></td>
                      <td style={{ color: expired ? T.danger : T.sub, fontWeight: expired ? 700 : 400 }}>
                        {new Date(r.subscriptionExpiry).toLocaleDateString()}
                      </td>
                      <td>
                        {r.status === "active" ? (
                          <Btn size="sm" variant="soft" tone={T.danger} onClick={() => setResellerStatus(r.id, "suspended")}>Suspend</Btn>
                        ) : (
                          <Btn size="sm" variant="soft" tone={T.success} onClick={() => setResellerStatus(r.id, "active")}>Activate</Btn>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {!resellers.loading && (resellers.data || []).length === 0 && <EmptyRow text="No resellers yet." />}
        </Panel>
      )}

      {tab === "plans" && (
        <Panel title="Platform plans (what resellers pay you)">
          {platformPlans.loading ? <Loading /> : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px,1fr))", gap: 12 }}>
              {(platformPlans.data || []).map((p) => {
                const editing = planEdits?.id === p.id;
                return (
                  <div key={p.id} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 14 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{p.name}</div>
                    <div style={{ fontSize: 12, color: T.sub, marginBottom: 8 }}>{p.description}</div>
                    {editing ? (
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input style={{ ...inputStyle, width: 90 }} type="number" value={planEdits.price}
                          onChange={(e) => setPlanEdits({ ...planEdits, price: e.target.value })} />
                        <Btn size="sm" onClick={() => savePlatformPlan(planEdits)}><Save size={12} /></Btn>
                        <Btn size="sm" variant="ghost" onClick={() => setPlanEdits(null)}>Cancel</Btn>
                      </div>
                    ) : (
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div style={{ fontSize: 20, fontWeight: 700, color: T.secondary }}>{formatMoney(p.price, platformCurrency)}<span style={{ fontSize: 11, color: T.sub, fontWeight: 500 }}>/mo</span></div>
                        <Btn size="sm" variant="outline" onClick={() => setPlanEdits({ id: p.id, name: p.name, price: p.price })}>Edit price</Btn>
                      </div>
                    )}
                    <div style={{ fontSize: 11.5, color: T.sub, marginTop: 8 }}>Up to {p.maxClients ?? p.max_clients} clients · {p.maxDevicesPerClient ?? p.max_devices_per_client} devices/client</div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      )}

      {tab === "installs" && (
        <Panel title="Installation log">
          {installations.loading ? <Loading /> : (installations.data || []).length === 0 ? <EmptyRow text="No installations yet." /> : (
            (installations.data || []).slice().sort((a, b) => b.time - a.time).map((i) => (
              <div key={i.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 4px", borderBottom: `1px solid ${T.border}` }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13.5, color: T.ink }}>{i.company_name}{i.router_id ? <span style={{ fontWeight: 400, color: T.sub, fontSize: 12 }}> · {i.router_id}</span> : null}</div>
                  <div style={{ fontSize: 12, color: T.sub }}>{i.ip} · {i.location} · {timeAgo(i.time)}</div>
                </div>
                <Badge tone={statusColor(i.status)}>{i.status}</Badge>
              </div>
            ))
          )}
        </Panel>
      )}

      {tab === "sessions" && (
        <Panel title="Active sessions — platform-wide" action={<Badge tone={T.primary}>{(sessions.data || []).length} connected</Badge>}>
          {sessions.loading ? <Loading /> : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: T.sub, fontSize: 11.5, textTransform: "uppercase" }}>
                  <th style={{ padding: "6px 8px" }}>Device</th><th>Voucher</th><th>Reseller</th><th>IP</th><th>Bandwidth</th><th>Connected</th>
                </tr>
              </thead>
              <tbody>
                {(sessions.data || []).map((s) => (
                  <tr key={s.id} style={{ borderTop: `1px solid ${T.border}` }}>
                    <td style={{ padding: "9px 8px", fontWeight: 600 }}>{s.device_label}</td>
                    <td style={{ fontFamily: "monospace", fontSize: 12 }}>{s.username}</td>
                    <td>{s.company_name}</td>
                    <td style={{ fontFamily: "monospace", fontSize: 12 }}>{s.ip}</td>
                    <td>{s.bandwidth_mbps} Mbps</td>
                    <td style={{ color: T.sub }}>{timeAgo(s.connected_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!sessions.loading && (sessions.data || []).length === 0 && <EmptyRow text="No active sessions right now." />}
        </Panel>
      )}

      {tab === "monitoring" && (
        <>
          {monitoring.loading ? <Loading /> : monitoring.data && (
            <>
              <div style={{ display: "flex", gap: 14, marginBottom: 14, flexWrap: "wrap" }}>
                <StatCard icon={Cpu} label="API health" value="Operational" tone={T.success} />
                <StatCard icon={Router} label="Router uptime" value={`${monitoring.data.routerUptimePct}%`} sub={`${monitoring.data.onlineRouters}/${monitoring.data.totalRouters} routers online`} tone={monitoring.data.routerUptimePct > 80 ? T.success : T.warning} />
                <StatCard icon={Mail} label="Delivery queue" value={monitoring.data.deliveryQueuePending} sub="failed deliveries pending retry" tone={monitoring.data.deliveryQueuePending ? T.warning : T.success} />
                <StatCard icon={Gauge} label="Avg API response" value={`${monitoring.data.avgApiResponseMs}ms`} tone={T.primary} />
              </div>
              <Panel title="Router fleet">
                {(monitoring.data.routers || []).length === 0 && <EmptyRow text="No routers registered yet." />}
                {(monitoring.data.routers || []).map((rt) => (
                  <div key={rt.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 4px", borderBottom: `1px solid ${T.border}` }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{rt.router_id} <span style={{ fontWeight: 400, color: T.sub }}>· {rt.company_name}</span></div>
                      <div style={{ fontSize: 11.5, color: T.sub }}>{rt.model} · {rt.firmware} · last check-in {timeAgo(rt.last_check_in)}</div>
                    </div>
                    <Badge tone={statusColor(rt.status)}>{rt.status}</Badge>
                  </div>
                ))}
              </Panel>
            </>
          )}
        </>
      )}

      {tab === "license" && (
        <Panel title="Reseller license payments" action={<Badge tone={pendingLicensePayments ? T.warning : T.success}>{pendingLicensePayments} pending</Badge>}>
          <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 14 }}>
            Resellers transfer their license fee straight to your bank account (set it under Settings) and submit a reference here. Confirming extends their subscription by 30 days.
          </div>
          {licensePayments.loading ? <Loading /> : (licensePayments.data || []).length === 0 ? <EmptyRow text="No license payment submissions yet." /> : (
            licensePayments.data.slice().sort((a, b) => b.time - a.time).map((p) => (
              <div key={p.id} style={{ padding: "13px 4px", borderBottom: `1px solid ${T.border}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13.5 }}>{p.company_name} <span style={{ fontWeight: 400, color: T.sub }}>— {p.plan_name}</span></div>
                    <div style={{ fontSize: 12, color: T.sub, marginTop: 2 }}>
                      {formatMoney(p.amount, platformCurrency)} via {p.method} · ref: <span style={{ fontFamily: "monospace" }}>{p.reference}</span> · {timeAgo(p.time)}
                      {p.receipt_url && (
                        <> · <a href={p.receipt_url} target="_blank" rel="noreferrer" style={{ color: T.primary, fontWeight: 600 }}>view receipt</a></>
                      )}
                    </div>
                  </div>
                  {p.status === "pending" ? (
                    <div style={{ display: "flex", gap: 6 }}>
                      <Btn size="sm" tone={T.success} onClick={() => decideLicensePayment(p.id, "confirmed")}>Confirm</Btn>
                      <Btn size="sm" variant="soft" tone={T.danger} onClick={() => decideLicensePayment(p.id, "rejected")}>Reject</Btn>
                    </div>
                  ) : (
                    <Badge tone={statusColor(p.status)}>{p.status}</Badge>
                  )}
                </div>
              </div>
            ))
          )}
        </Panel>
      )}

      {tab === "referrals" && (
        <Panel title="Referral program" action={<Badge tone={pendingReferralBonuses ? T.warning : T.success}>{pendingReferralBonuses} awaiting payout</Badge>}>
          <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 14, maxWidth: 600 }}>
            Every reseller has their own referral code (see their Referrals tab) they can hand to prospective resellers or marketers. When someone signs up with a code, it shows up here as "signed up" — you send the bonus by hand (same manual-transfer pattern as everything else) and mark it paid once you have. A flagged referral looks like a self-referral (see backend README) and can't be paid until you've reviewed it.
          </div>
          {referrals.loading ? <Loading /> : (
            <>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 18 }}>
                <StatCard icon={Users} label="Signed up — pending" value={referrals.data?.summary?.signedUp ?? 0} tone={T.warning} />
                <StatCard icon={Gift} label="Bonuses paid" value={referrals.data?.summary?.bonusPaid ?? 0} tone={T.success} />
                <StatCard icon={AlertCircle} label="Flagged (self-referral)" value={referrals.data?.summary?.flagged ?? 0} tone={T.danger} />
                <StatCard icon={DollarSign} label="Pending payout" value={formatMoney(referrals.data?.summary?.totalPending, platformCurrency)} tone={T.warning} />
                <StatCard icon={DollarSign} label="Total paid out" value={formatMoney(referrals.data?.summary?.totalPaidOut, platformCurrency)} tone={T.success} />
              </div>
              {(referrals.data?.referrals || []).length === 0 ? (
                <EmptyRow text="No referrals yet." />
              ) : (
                referrals.data.referrals.map((r) => (
                  <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "13px 4px", borderBottom: `1px solid ${T.border}`, flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13.5 }}>
                        {r.referrer_company_name} <span style={{ fontWeight: 400, color: T.sub }}>referred</span> {r.referred_company_name || r.name || r.email || r.phone || "—"}
                      </div>
                      <div style={{ fontSize: 11.5, color: T.sub, marginTop: 2 }}>
                        {r.referrer_email}{r.email ? ` · invited: ${r.email}` : ""}{r.phone ? ` · ${r.phone}` : ""} · {timeAgo(r.created_at)}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      {editingBonusId === r.id ? (
                        <>
                          <input style={{ ...inputStyle, width: 90 }} type="number" min="0" step="0.01" value={editingBonusValue} onChange={(e) => setEditingBonusValue(e.target.value)} autoFocus />
                          <Btn size="sm" onClick={() => saveReferralBonus(r.id)}><Save size={12} /></Btn>
                          <Btn size="sm" variant="ghost" onClick={() => setEditingBonusId(null)}>Cancel</Btn>
                        </>
                      ) : (
                        <div
                          style={{ fontSize: 12.5, color: T.sub, cursor: r.status === "signed_up" ? "pointer" : "default", textDecoration: r.status === "signed_up" ? "underline dotted" : "none" }}
                          title={r.status === "signed_up" ? "Click to adjust this bonus amount" : undefined}
                          onClick={() => { if (r.status === "signed_up") { setEditingBonusId(r.id); setEditingBonusValue(String(r.bonus_amount)); } }}
                        >
                          {formatMoney(r.bonus_amount, platformCurrency)}
                        </div>
                      )}
                      {r.status === "signed_up" ? (
                        <Btn size="sm" tone={T.success} onClick={() => markReferralPaid(r.id)}><Gift size={13} /> Mark bonus paid</Btn>
                      ) : r.status === "flagged" ? (
                        <Badge tone={T.danger}>Flagged — possible self-referral</Badge>
                      ) : (
                        <Badge tone={statusColor(r.status === "bonus_paid" ? "confirmed" : "pending")}>
                          {r.status === "bonus_paid" ? "Bonus paid" : "Invited — not yet signed up"}
                        </Badge>
                      )}
                    </div>
                  </div>
                ))
              )}
            </>
          )}
        </Panel>
      )}

      {tab === "productKeys" && (
        <>
          <Panel title="Generate keys">
            <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 14, maxWidth: 640 }}>
              For manual/offline distribution — generate a batch of one-time activation keys for a plan you've already been paid for outside this system, then hand them out however fits (printed, texted, read over the phone). A reseller enters one in their License tab for <b>instant</b> activation — no confirmation step, because the vetting already happened before you generated the key.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1.4fr", gap: 12, alignItems: "end", maxWidth: 780, marginBottom: 12 }}>
              <Field label="How many">
                <input style={inputStyle} type="number" min="1" max="5000" value={keyGenForm.count}
                  onChange={(e) => setKeyGenForm({ ...keyGenForm, count: e.target.value })} />
              </Field>
              <Field label="Plan">
                <select style={inputStyle} value={keyGenForm.planId} onChange={(e) => setKeyGenForm({ ...keyGenForm, planId: e.target.value })}>
                  <option value="">Choose…</option>
                  {(platformPlans.data || []).map((p) => <option key={p.id} value={p.id}>{p.name} ({formatMoney(p.price, platformCurrency)})</option>)}
                </select>
              </Field>
              <Field label="Duration (days)">
                <input style={inputStyle} type="number" min="1" value={keyGenForm.durationDays}
                  onChange={(e) => setKeyGenForm({ ...keyGenForm, durationDays: e.target.value })} />
              </Field>
              <Field label="Batch label (optional)" hint="For your own tracking — e.g. 'Lagos Expo Aug 2026'">
                <input style={inputStyle} value={keyGenForm.batchLabel} onChange={(e) => setKeyGenForm({ ...keyGenForm, batchLabel: e.target.value })} placeholder="defaults to today's date" />
              </Field>
            </div>
            <Btn onClick={generateKeys} disabled={keyGenerating}><KeyRound size={14} /> {keyGenerating ? "Generating…" : "Generate keys"}</Btn>

            {lastGeneratedBatch && (
              <div style={{ marginTop: 16, background: T.bg, borderRadius: 10, padding: 14, maxWidth: 780 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>Just generated: {lastGeneratedBatch.count} keys — "{lastGeneratedBatch.batchLabel}"</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Btn size="sm" variant="outline" onClick={() => { navigator.clipboard?.writeText(lastGeneratedBatch.keys.join("\n")); notify("Keys copied to clipboard."); }}>
                      <Copy size={12} /> Copy all
                    </Btn>
                    <Btn size="sm" variant="outline" onClick={() => downloadKeys(lastGeneratedBatch.batchLabel, "unused")}>
                      <Download size={12} /> Download .txt
                    </Btn>
                  </div>
                </div>
                <div style={{ maxHeight: 160, overflowY: "auto", fontFamily: "monospace", fontSize: 12, color: T.sub, lineHeight: 1.7, columns: 2 }}>
                  {lastGeneratedBatch.keys.slice(0, 200).map((k) => <div key={k}>{k}</div>)}
                  {lastGeneratedBatch.keys.length > 200 && <div>…and {lastGeneratedBatch.keys.length - 200} more (download for the full list)</div>}
                </div>
              </div>
            )}
          </Panel>

          <div style={{ height: 20 }} />

          <Panel title="Batches">
            {keySummary.loading ? <Loading /> : (keySummary.data || []).length === 0 ? (
              <EmptyRow text="No keys generated yet." />
            ) : (
              keySummary.data.map((b) => (
                <div key={b.batch_label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "13px 4px", borderBottom: `1px solid ${T.border}`, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13.5 }}>{b.batch_label}</div>
                    <div style={{ fontSize: 11.5, color: T.sub, marginTop: 2 }}>
                      {b.total} total · {timeAgo(b.created_at)}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <Badge tone={T.sub}>{b.unused} unused</Badge>
                    <Badge tone={T.success}>{b.used} used</Badge>
                    {b.revoked > 0 && <Badge tone={T.danger}>{b.revoked} revoked</Badge>}
                    <Btn size="sm" variant="outline" onClick={() => downloadKeys(b.batch_label, "unused")} disabled={b.unused === 0}>
                      <Download size={12} /> Download unused
                    </Btn>
                    <Btn size="sm" variant="ghost" tone={T.danger} onClick={() => { if (confirm(`Revoke all ${b.unused} unused keys in "${b.batch_label}"? This can't be undone.`)) revokeBatch(b.batch_label); }} disabled={b.unused === 0}>
                      <Ban size={12} /> Revoke unused
                    </Btn>
                  </div>
                </div>
              ))
            )}
          </Panel>
        </>
      )}

      {tab === "support" && (
        <Panel title="Reseller support tickets" action={<Badge tone={openTickets ? T.warning : T.success}>{openTickets} open</Badge>}>
          {support.loading ? <Loading /> : (support.data || []).length === 0 ? <EmptyRow text="No tickets from resellers yet." /> : (
            support.data.slice().sort((a, b) => b.time - a.time).map((t) => (
              <div key={t.id} style={{ padding: "14px 4px", borderBottom: `1px solid ${T.border}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>{t.subject}</div>
                  <Badge tone={statusColor(t.status)}>{t.status}</Badge>
                </div>
                <div style={{ fontSize: 11.5, color: T.sub, marginBottom: 6 }}>
                  {t.company_name}{t.reseller_email ? ` · ${t.reseller_email}` : ""}{t.reseller_whatsapp ? ` · ${t.reseller_whatsapp}` : ""} · {timeAgo(t.time)}
                </div>
                <div style={{ fontSize: 13, color: T.ink, background: T.bg, borderRadius: 8, padding: 10, marginBottom: 8 }}>
                  {t.message}
                  {t.attachment_url && (
                    <div style={{ marginTop: 6 }}><a href={t.attachment_url} target="_blank" rel="noreferrer" style={{ color: T.primary, fontSize: 11.5, fontWeight: 600 }}>📎 view attachment</a></div>
                  )}
                </div>
                {(t.messages || []).map((m) => (
                  <div key={m.id} style={{
                    fontSize: 13, color: T.ink, borderRadius: 6, padding: 10, marginBottom: 8,
                    background: m.sender === "admin" ? `${T.secondary}0d` : T.bg,
                    borderLeft: m.sender === "admin" ? `3px solid ${T.secondary}` : "none",
                    marginLeft: m.sender === "admin" ? 0 : 16,
                  }}>
                    <b>{m.sender === "admin" ? "You" : t.company_name}:</b> {m.message || <i style={{ color: T.sub }}>(voice note / attachment)</i>}
                    {m.attachment_url && (
                      <div style={{ marginTop: 4 }}><a href={m.attachment_url} target="_blank" rel="noreferrer" style={{ color: T.secondary, fontSize: 11.5, fontWeight: 600 }}>📎 view attachment</a></div>
                    )}
                    <div style={{ fontSize: 10.5, color: T.sub, marginTop: 3 }}>{timeAgo(m.time)}</div>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 8 }}>
                  <input style={inputStyle} placeholder="Write a reply…" value={reply[t.id] || ""} onChange={(e) => setReply((r2) => ({ ...r2, [t.id]: e.target.value }))} />
                  <Btn size="sm" onClick={() => sendReply(t.id)}><MessageSquare size={13} /> {dt(dashboardLang, "sendReply")}</Btn>
                  {t.status === "open" ? (
                    <Btn size="sm" variant="soft" tone={T.success} onClick={() => setTicketStatus(t.id, "resolved")}><CheckCircle2 size={13} /> {dt(dashboardLang, "resolve")}</Btn>
                  ) : (
                    <Btn size="sm" variant="ghost" onClick={() => setTicketStatus(t.id, "open")}>{dt(dashboardLang, "reopen")}</Btn>
                  )}
                </div>
                <AttachmentPicker
                  onUpload={uploadSupportAttachment}
                  attachmentUrl={replyAttachment[t.id] || null}
                  setAttachmentUrl={(url) => setReplyAttachment((r2) => ({ ...r2, [t.id]: url }))}
                  lang={dashboardLang}
                />
              </div>
            ))
          )}
        </Panel>
      )}

      {tab === "notifications" && (
        <Panel title="Notification center" action={<Btn size="sm" variant="ghost" onClick={markAllRead}>{dt(dashboardLang, "markAllRead")}</Btn>}>
          {notifications.loading ? <Loading /> : (notifications.data || []).length === 0 ? <EmptyRow text="You're all caught up." /> : (
            notifications.data.slice().sort((a, b) => b.time - a.time).map((n) => (
              <div key={n.id} onClick={() => onNotificationClick(n)}
                style={{
                  display: "flex", gap: 12, padding: "12px 4px", borderBottom: `1px solid ${T.border}`, opacity: n.read ? 0.6 : 1,
                  cursor: n.action_tab ? "pointer" : "default",
                }}>
                <div style={{ width: 30, height: 30, borderRadius: 8, background: `${T.secondary}18`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {n.type === "install" ? <Router size={14} color={T.secondary} /> : n.type === "payment" ? <DollarSign size={14} color={T.success} /> : n.type === "referral" ? <Gift size={14} color={T.secondary} /> : <AlertCircle size={14} color={T.warning} />}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5, color: T.ink }}>{n.title}</div>
                  <div style={{ fontSize: 12.5, color: T.sub }}>{n.message}</div>
                  <div style={{ fontSize: 11, color: T.sub, marginTop: 3 }}>{timeAgo(n.time)}</div>
                </div>
                {n.action_tab && <ChevronRight size={16} color={T.sub} style={{ marginTop: 6, flexShrink: 0 }} />}
                {!n.read && <span style={{ width: 8, height: 8, borderRadius: "50%", background: T.primary, marginTop: 5, flexShrink: 0 }} />}
              </div>
            ))
          )}
        </Panel>
      )}

      {tab === "settings" && (
        <Panel title="Contact & bank settings">
          <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 16, maxWidth: 520 }}>
            There is no automated email/WhatsApp sending anywhere in SAFE_Links — every notice is sent by hand. This is simply the contact info resellers see when they need to reach you, and the account they transfer license fees to.
          </div>
          {settingsRes.loading || !settings ? <Loading /> : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, maxWidth: 640 }}>
              <Field label="Contact email">
                <input style={inputStyle} value={settings.contactEmail ?? settings.contact_email ?? ""}
                  onChange={(e) => setSettingsForm({ ...settings, contactEmail: e.target.value })} placeholder="support@yourplatform.com" />
              </Field>
              <Field label="Contact WhatsApp number">
                <input style={inputStyle} value={settings.contactWhatsapp ?? settings.contact_whatsapp ?? ""}
                  onChange={(e) => setSettingsForm({ ...settings, contactWhatsapp: e.target.value })} placeholder="+1 555 010 1000" />
              </Field>
              <Field label="Bank name">
                <input style={inputStyle} value={settings.bankName ?? settings.bank_name ?? ""}
                  onChange={(e) => setSettingsForm({ ...settings, bankName: e.target.value })} />
              </Field>
              <Field label="Account name">
                <input style={inputStyle} value={settings.bankAccountName ?? settings.bank_account_name ?? ""}
                  onChange={(e) => setSettingsForm({ ...settings, bankAccountName: e.target.value })} />
              </Field>
              <Field label="Account number">
                <input style={inputStyle} value={settings.bankAccountNumber ?? settings.bank_account_number ?? ""}
                  onChange={(e) => setSettingsForm({ ...settings, bankAccountNumber: e.target.value })} />
              </Field>
              <Field label="USSD code (optional)">
                <input style={inputStyle} value={settings.ussdCode ?? settings.ussd_code ?? ""}
                  onChange={(e) => setSettingsForm({ ...settings, ussdCode: e.target.value })} />
              </Field>
              <Field label="Platform currency (what you charge resellers)">
                <select style={inputStyle} value={settings.platformCurrency ?? settings.platform_currency ?? "USD"}
                  onChange={(e) => setSettingsForm({ ...settings, platformCurrency: e.target.value })}>
                  {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
                </select>
              </Field>
              <Field label="Dashboard language (this console, for you)">
                <select style={inputStyle} value={settings.dashboardLanguage ?? settings.dashboard_language ?? "en"}
                  onChange={(e) => setSettingsForm({ ...settings, dashboardLanguage: e.target.value })}>
                  {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                </select>
              </Field>
              <Field label="Referral bonus amount" hint="Paid to a reseller when someone signs up with their code — snapshotted onto each new invite, so changing this doesn't affect bonuses already promised.">
                <input style={inputStyle} type="number" min="0" step="0.01"
                  value={settings.referralBonusAmount ?? settings.referral_bonus_amount ?? 10}
                  onChange={(e) => setSettingsForm({ ...settings, referralBonusAmount: Number(e.target.value) })} />
              </Field>
              <div style={{ gridColumn: "1 / -1" }}>
                <Btn onClick={saveSettings}><Save size={14} /> {dt(dashboardLang, "saveSettings")}</Btn>
              </div>
            </div>
          )}
        </Panel>
      )}
    </Shell>
  );
}
