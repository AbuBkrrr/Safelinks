import React, { useState } from "react";
import {
  Building2, Users, Activity, Router, Mail, Package, Palette, Zap, Inbox,
  DollarSign, Key, Smartphone, LifeBuoy, Plus, Trash2, Pause, Play, Save,
  RotateCw, ChevronRight, Clock, CreditCard, TrendingUp, MessageSquare,
  CheckCircle2, XCircle, Lock, Wifi, Bell, AlertCircle, Gift, Copy, Phone,
} from "lucide-react";
import {
  T, Shell, Panel, StatCard, Badge, Btn, Field, inputStyle, EmptyRow, Loading,
  statusColor, timeAgo, TransferPayBlock, formatMoney, CURRENCIES, AttachmentPicker,
} from "./ui.jsx";
import { api, fileToBase64 } from "./api.js";
import { useResource } from "./hooks.js";
import InstallerWizard from "./InstallerWizard.jsx";
import { LANGUAGES, t } from "./i18n.js";
import { dt } from "./dashboardI18n.js";

const DURATIONS = [
  { key: "daily", label: "Daily" }, { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" }, { key: "3months", label: "3 months" },
  { key: "6months", label: "6 months" }, { key: "yearly", label: "Yearly" },
];

export default function ResellerApp({ session, onExit, notify }) {
  const [tab, setTab] = useState("vouchers");

  const vouchers = useResource(() => api.reseller.vouchers(), [], (r) => r.vouchers);
  const sessions = useResource(() => api.reseller.sessions(), [], (r) => r.sessions);
  const routers = useResource(() => api.reseller.routers(), [], (r) => r.routers);
  const deliveryLogs = useResource(() => api.reseller.deliveryLogs(), [], (r) => r.deliveryLogs);
  const plans = useResource(() => api.reseller.plans(), [], (r) => r.plans);
  const portalSettingsRes = useResource(() => api.reseller.portalSettings(), []);
  const pending = useResource(() => api.reseller.pendingActivations(), [], (r) => r.pendingActivations);
  const billing = useResource(() => api.reseller.billing(), []);
  const license = useResource(() => api.reseller.license(), []);
  const bankInfo = useResource(() => api.reseller.platformBankInfo(), []);
  const support = useResource(() => api.reseller.support(), [], (r) => r.tickets);
  const customerSupport = useResource(() => api.reseller.customerSupport(), [], (r) => r.tickets);
  const notifications = useResource(() => api.reseller.notifications(), [], (r) => r.notifications);
  const referrals = useResource(() => api.reseller.referrals(), []);

  const openTickets = (support.data || []).filter((t) => t.status === "open").length;
  const openCustomerTickets = (customerSupport.data || []).filter((t) => t.status === "open").length;
  const unreadNotifs = (notifications.data || []).filter((n) => !n.read).length;
  const pendingCount = (pending.data || []).filter((r) => r.status === "pending").length;
  const licenseExpired = license.data ? license.data.subscription_expiry < Date.now() : false;
  // Applies to everything the reseller charges their own end-users
  // (plans, vouchers, revenue) — NOT the platform license fee paid to
  // Super Admin, which is set by Super Admin (see platformCurrency below,
  // sourced from bankInfo, not assumed to be USD).
  const currency = portalSettingsRes.data?.currency || "USD";
  const platformCurrency = bankInfo.data?.platformCurrency || "USD";
  // One language field now drives both this dashboard and the captive
  // portal end-users see — a reseller running their business in French
  // shouldn't have to separately tell us their own screen is French too.
  // `language` is the single source of truth; the legacy dashboardLanguage
  // fallbacks stay here only for accounts that saved a value under the
  // old split before this changed.
  const dashboardLang = portalSettingsRes.data?.language || portalSettingsRes.data?.dashboardLanguage || portalSettingsRes.data?.dashboard_language || "en";
  const companyName = session?.user?.companyName || "";

  const tabs = [
    { key: "vouchers", label: dt(dashboardLang, "tabVouchers"), icon: Users },
    { key: "sessions", label: dt(dashboardLang, "tabSessions"), icon: Activity },
    { key: "routers", label: dt(dashboardLang, "tabRouters"), icon: Router },
    { key: "delivery", label: dt(dashboardLang, "tabDelivery"), icon: Mail },
    { key: "plans", label: dt(dashboardLang, "tabPlans"), icon: Package },
    { key: "portal", label: dt(dashboardLang, "tabPortal"), icon: Palette },
    { key: "pending", label: dt(dashboardLang, "tabPending"), icon: Inbox },
    { key: "billing", label: dt(dashboardLang, "tabBilling"), icon: DollarSign },
    { key: "license", label: dt(dashboardLang, "tabResellerLicense"), icon: Key },
    { key: "referrals", label: dt(dashboardLang, "tabReferrals"), icon: Gift },
    { key: "installer", label: dt(dashboardLang, "tabInstaller"), icon: Smartphone },
    { key: "support", label: dt(dashboardLang, "tabSupport"), icon: LifeBuoy },
    { key: "notifications", label: dt(dashboardLang, "tabNotifications"), icon: Bell },
  ];

  // --- Vouchers ---
  const [revealPw, setRevealPw] = useState({});
  async function setVoucherStatus(id, status) {
    try {
      await api.reseller.setVoucherStatus(id, status);
      notify(`Voucher ${status === "active" ? "resumed" : "paused"} — router will pick this up on its next check-in.`);
      vouchers.refetch();
    } catch (err) { notify(err.message); }
  }
  async function deleteVoucher(id) {
    try {
      await api.reseller.deleteVoucher(id);
      notify("Voucher deleted.");
      vouchers.refetch();
    } catch (err) { notify(err.message); }
  }

  // --- Sessions ---
  async function disconnectSession(id) {
    try {
      await api.reseller.disconnectSession(id);
      notify("Device disconnected.");
      sessions.refetch();
    } catch (err) { notify(err.message); }
  }

  // --- Delivery logs ---
  async function retryDelivery(id) {
    try {
      await api.reseller.retryDelivery(id);
      notify("Marked as delivered.");
      deliveryLogs.refetch();
    } catch (err) { notify(err.message); }
  }

  // --- Plans ---
  const [planForm, setPlanForm] = useState(null);
  async function savePlan() {
    if (!planForm.name || !planForm.price) return;
    try {
      const body = {
        name: planForm.name, duration: planForm.duration, price: Number(planForm.price),
        deviceLimit: Number(planForm.deviceLimit), bandwidth: Number(planForm.bandwidth),
        priority: planForm.priority, popular: !!planForm.popular,
      };
      if (planForm.isNew) await api.reseller.createPlan(body);
      else await api.reseller.updatePlan(planForm.id, body);
      notify(`Plan "${planForm.name}" saved.`);
      setPlanForm(null);
      plans.refetch();
    } catch (err) { notify(err.message); }
  }
  async function deletePlan(id) {
    try {
      await api.reseller.deletePlan(id);
      plans.refetch();
    } catch (err) { notify(err.message); }
  }

  // --- Captive portal settings ---
  const [portalForm, setPortalForm] = useState(null);
  const portal = portalForm || portalSettingsRes.data;
  async function savePortal() {
    try {
      await api.reseller.updatePortalSettings({
        ssid: portal.ssid, portalTitle: portal.portalTitle ?? portal.portal_title,
        color: portal.color, currency: portal.currency, language: portal.language,
        // Kept in sync with `language` rather than exposed as its own
        // field — see the note by `dashboardLang` above for why the two
        // were merged.
        dashboardLanguage: portal.language,
        contactEmail: portal.contactEmail ?? portal.contact_email,
        contactWhatsapp: portal.contactWhatsapp ?? portal.contact_whatsapp,
        bankName: portal.bankName ?? portal.bank_name,
        bankAccountName: portal.bankAccountName ?? portal.bank_account_name,
        bankAccountNumber: portal.bankAccountNumber ?? portal.bank_account_number,
        ussdCode: portal.ussdCode ?? portal.ussd_code,
      });
      notify("Captive portal settings saved.");
      // Wait for the refetch to actually land before dropping the local
      // form override — otherwise there's a window where `portal` falls
      // back to the pre-save `portalSettingsRes.data` (refetch is async
      // and hasn't resolved yet), which visibly flashes the dashboard
      // back to the OLD language for a moment right after saving a new
      // one. Awaiting first makes the switch atomic.
      await portalSettingsRes.refetch();
      setPortalForm(null);
    } catch (err) { notify(err.message); }
  }

  // --- Pending activations ---
  async function decideActivation(id, decision) {
    try {
      const res = await api.reseller.decidePendingActivation(id, decision);
      notify(decision === "confirmed"
        ? `Payment confirmed — voucher ${res.voucher?.username} issued. Send the credentials to the customer by email/WhatsApp yourself.`
        : "Request rejected.");
      pending.refetch();
      vouchers.refetch();
    } catch (err) { notify(err.message); }
  }

  // --- License renewal (manual transfer -> Super Admin confirms) ---
  const [licenseStep, setLicenseStep] = useState("view");
  const [chosenPlanId, setChosenPlanId] = useState(null);
  const [licenseMethod, setLicenseMethod] = useState("Bank Transfer");
  const [licenseReference, setLicenseReference] = useState("");
  const [licenseReceiptUrl, setLicenseReceiptUrl] = useState(null);
  const [licenseSubmitting, setLicenseSubmitting] = useState(false);
  // Lifted up (rather than fetched inside PlanChooser) so the payment
  // step below can also look up the chosen plan's real price instead
  // of showing a "—" placeholder for the amount to transfer.
  const platformPlans = useResource(() => api.reseller.platformPlans(), [], (r) => r.plans);
  const chosenPlanPrice = (platformPlans.data || []).find((p) => p.id === chosenPlanId)?.price;
  async function uploadLicenseReceiptFile(file) {
    const dataBase64 = await fileToBase64(file);
    return api.reseller.uploadReceipt({ filename: file.name, mimeType: file.type, dataBase64 });
  }
  async function submitLicenseRenewal() {
    setLicenseSubmitting(true);
    try {
      await api.reseller.renewLicense({ planId: chosenPlanId, method: licenseMethod, reference: licenseReference, receiptUrl: licenseReceiptUrl });
      notify("Submitted — Super Admin will confirm once the transfer lands.");
      setLicenseStep("view");
      setLicenseReference("");
      setLicenseReceiptUrl(null);
      license.refetch();
    } catch (err) { notify(err.message); }
    setLicenseSubmitting(false);
  }

  const [productKeyInput, setProductKeyInput] = useState("");
  const [redeemingKey, setRedeemingKey] = useState(false);
  async function redeemProductKey() {
    if (!productKeyInput.trim()) return notify("Enter a product key first.");
    setRedeemingKey(true);
    try {
      const res = await api.reseller.redeemProductKey(productKeyInput.trim());
      notify(`Activated! ${res.plan} plan through ${new Date(res.subscriptionExpiry).toLocaleDateString()}.`);
      setProductKeyInput("");
      license.refetch();
    } catch (err) { notify(err.message); }
    setRedeemingKey(false);
  }

  // --- Referrals ---
  const [referralForm, setReferralForm] = useState({ name: "", email: "", phone: "" });
  const [referralSubmitting, setReferralSubmitting] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  async function submitReferral() {
    if (!referralForm.email && !referralForm.phone) return notify("Give at least an email or phone number to invite.");
    setReferralSubmitting(true);
    try {
      await api.reseller.createReferral(referralForm);
      notify("Referral invite recorded.");
      setReferralForm({ name: "", email: "", phone: "" });
      referrals.refetch();
    } catch (err) { notify(err.message); }
    setReferralSubmitting(false);
  }
  async function withdrawReferral(id) {
    try {
      await api.reseller.deleteReferral(id);
      referrals.refetch();
    } catch (err) { notify(err.message); }
  }
  function copyReferralLink() {
    const link = `${window.location.origin}/?ref=${referrals.data?.referralCode || ""}`;
    navigator.clipboard?.writeText(link);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 1800);
  }

  async function onNotificationClick(n) {
    if (!n.read) {
      try { await api.reseller.markNotificationRead(n.id); notifications.refetch(); } catch { /* non-fatal */ }
    }
    if (n.action_tab) setTab(n.action_tab);
  }
  async function markAllNotificationsRead() {
    try { await api.reseller.markNotificationsRead(); notifications.refetch(); } catch (err) { notify(err.message); }
  }

  // --- Support ---
  const [ticketForm, setTicketForm] = useState({ subject: "", message: "" });
  const [ticketAttachmentUrl, setTicketAttachmentUrl] = useState(null);
  async function uploadSupportAttachment(blob, mimeType, filename) {
    const dataBase64 = await fileToBase64(blob);
    return api.reseller.uploadSupportAttachment({ filename, mimeType, dataBase64 });
  }
  async function submitTicket() {
    if (!ticketForm.subject || !ticketForm.message) return;
    try {
      await api.reseller.createSupportTicket({ ...ticketForm, attachmentUrl: ticketAttachmentUrl });
      setTicketForm({ subject: "", message: "" });
      setTicketAttachmentUrl(null);
      notify("Support ticket sent to Super Admin.");
      support.refetch();
    } catch (err) { notify(err.message); }
  }

  const [adminReply, setAdminReply] = useState({});
  const [adminReplyAttachment, setAdminReplyAttachment] = useState({});
  async function sendAdminReply(id) {
    const msg = adminReply[id];
    if (!msg) return;
    try {
      await api.reseller.sendSupportMessage(id, msg, adminReplyAttachment[id] || null);
      setAdminReply((r) => ({ ...r, [id]: "" }));
      setAdminReplyAttachment((r) => ({ ...r, [id]: null }));
      support.refetch();
    } catch (err) { notify(err.message); }
  }
  async function setAdminTicketStatus(id, status) {
    try {
      await api.reseller.setSupportStatus(id, status);
      support.refetch();
    } catch (err) { notify(err.message); }
  }

  const [customerReply, setCustomerReply] = useState({});
  const [customerReplyAttachment, setCustomerReplyAttachment] = useState({});
  async function sendCustomerReply(id) {
    const msg = customerReply[id];
    if (!msg) return;
    try {
      await api.reseller.sendCustomerSupportMessage(id, msg, customerReplyAttachment[id] || null);
      setCustomerReply((r) => ({ ...r, [id]: "" }));
      setCustomerReplyAttachment((r) => ({ ...r, [id]: null }));
      customerSupport.refetch();
    } catch (err) { notify(err.message); }
  }
  async function setCustomerTicketStatus(id, status) {
    try {
      await api.reseller.setCustomerSupportStatus(id, status);
      notify(status === "resolved" ? "Marked resolved — remember to reach the customer directly." : "Reopened.");
      customerSupport.refetch();
    } catch (err) { notify(err.message); }
  }

  // --- Installer ---
  const [installerKey, setInstallerKey] = useState(0);
  const routerOnline = (routers.data || []).some((r) => r.status === "online");
  function onInstallerComplete() {
    notify("Installation recorded — Super Admin notified, router linked.");
    routers.refetch();
    setInstallerKey((k) => k + 1);
    setTab("routers");
  }

  const content = (
    <>
      {licenseExpired && (
        <div style={{ background: `${T.warning}15`, border: `1px solid ${T.warning}55`, borderRadius: 10, padding: "12px 16px", marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Lock size={16} color={T.warning} />
            <div style={{ fontSize: 13, color: T.ink }}><b>License expired.</b> Submit a renewal transfer to keep vouchers running.</div>
          </div>
          <Btn size="sm" tone={T.warning} onClick={() => setTab("license")}>Go to License</Btn>
        </div>
      )}

      {tab === "vouchers" && (
        <Panel title="Vouchers" action={<Badge tone={T.primary}>{(vouchers.data || []).length} issued</Badge>}>
          {vouchers.loading ? <Loading /> : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: T.sub, fontSize: 11.5, textTransform: "uppercase" }}>
                  <th style={{ padding: "6px 8px" }}>Username</th><th>Password</th><th>Plan</th><th>Sessions</th><th>Expires</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {(vouchers.data || []).map((v) => {
                  const revealed = revealPw[v.id];
                  return (
                    <tr key={v.id} style={{ borderTop: `1px solid ${T.border}` }}>
                      <td style={{ padding: "10px 8px", fontWeight: 600, fontFamily: "monospace" }}>{v.username}
                        <div style={{ fontWeight: 400, color: T.sub, fontSize: 11.5, fontFamily: "inherit" }}>{v.business}</div>
                      </td>
                      <td style={{ fontFamily: "monospace", fontSize: 12 }}>
                        <span onClick={() => setRevealPw((p) => ({ ...p, [v.id]: !p[v.id] }))} style={{ cursor: "pointer" }}>
                          {revealed ? v.password : "••••••••"}
                        </span>
                      </td>
                      <td>{v.plan_name || "—"} <span style={{ color: T.sub, fontSize: 11 }}>({v.device_limit} devices)</span></td>
                      <td>{v.session_count}</td>
                      <td style={{ color: v.expires_at < Date.now() ? T.danger : T.sub }}>{new Date(v.expires_at).toLocaleDateString()}</td>
                      <td><Badge tone={statusColor(v.status)}>{v.status}</Badge></td>
                      <td>
                        <div style={{ display: "flex", gap: 4 }}>
                          {v.status === "active" ? (
                            <Btn size="sm" variant="soft" tone={T.warning} onClick={() => setVoucherStatus(v.id, "paused")}><Pause size={11} /></Btn>
                          ) : v.status === "paused" ? (
                            <Btn size="sm" variant="soft" tone={T.success} onClick={() => setVoucherStatus(v.id, "active")}><Play size={11} /></Btn>
                          ) : null}
                          <Btn size="sm" variant="ghost" tone={T.danger} onClick={() => deleteVoucher(v.id)}><Trash2 size={12} /></Btn>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {!vouchers.loading && (vouchers.data || []).length === 0 && <EmptyRow text="No vouchers issued yet — they're created once you confirm a Pending payment." />}
        </Panel>
      )}

      {tab === "sessions" && (
        <Panel title="Active sessions" action={<Badge tone={T.primary}>{(sessions.data || []).length} connected</Badge>}>
          {sessions.loading ? <Loading /> : (sessions.data || []).map((s) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 4px", borderBottom: `1px solid ${T.border}` }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{s.device_label} <span style={{ fontWeight: 400, color: T.sub, fontSize: 11.5 }}>· {s.username}</span></div>
                <div style={{ fontSize: 11.5, color: T.sub, fontFamily: "monospace" }}>{s.mac} · {s.ip} · {s.bandwidth_mbps} Mbps</div>
              </div>
              <span style={{ fontSize: 11.5, color: T.sub }}>{timeAgo(s.connected_at)}</span>
              <Btn size="sm" variant="ghost" tone={T.danger} onClick={() => disconnectSession(s.id)}>Disconnect</Btn>
            </div>
          ))}
          {!sessions.loading && (sessions.data || []).length === 0 && <EmptyRow text="No devices connected right now." />}
        </Panel>
      )}

      {tab === "routers" && (
        <Panel title="Connected routers" action={<Btn size="sm" onClick={() => setTab("installer")}><Plus size={13} /> Provision new router</Btn>}>
          {routers.loading ? <Loading /> : (routers.data || []).map((rt) => (
            <div key={rt.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 4px", borderBottom: `1px solid ${T.border}` }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, fontFamily: "monospace" }}>{rt.router_id}</div>
                <div style={{ fontSize: 11.5, color: T.sub }}>{rt.model} · {rt.firmware} · last check-in {timeAgo(rt.last_check_in)} · {rt.pendingCommands} command(s) pending</div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Badge tone={statusColor(rt.status)}>{rt.status}</Badge>
                <Btn size="sm" variant="outline" onClick={() => setTab("installer")}><RotateCw size={12} /> Re-provision</Btn>
              </div>
            </div>
          ))}
          {!routers.loading && (routers.data || []).length === 0 && <EmptyRow text="No routers linked yet — run the installer to connect your first one." />}
        </Panel>
      )}

      {tab === "delivery" && (
        <Panel title="Credential delivery logs">
          <div style={{ fontSize: 12, color: T.sub, marginBottom: 12 }}>
            Sending is manual — you email/WhatsApp the voucher's credentials yourself. This is just a log of when that happened, so you can retry marking one as sent if it slipped through.
          </div>
          {deliveryLogs.loading ? <Loading /> : (deliveryLogs.data || []).slice().sort((a, b) => b.time - a.time).map((d) => (
            <div key={d.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 4px", borderBottom: `1px solid ${T.border}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                {d.channel === "email" ? <Mail size={14} color={T.sub} /> : <MessageSquare size={14} color={T.sub} />}
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{d.username} <span style={{ fontWeight: 400, color: T.sub, fontSize: 11.5 }}>via {d.channel}</span></div>
                  <div style={{ fontSize: 11, color: T.sub }}>{timeAgo(d.time)}</div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Badge tone={statusColor(d.status)}>{d.status}</Badge>
                {d.status === "failed" && <Btn size="sm" variant="soft" onClick={() => retryDelivery(d.id)}><RotateCw size={12} /> Mark sent</Btn>}
              </div>
            </div>
          ))}
          {!deliveryLogs.loading && (deliveryLogs.data || []).length === 0 && <EmptyRow text="No delivery attempts yet." />}
        </Panel>
      )}

      {tab === "plans" && (
        <Panel title="Subscription plans" action={<Btn size="sm" onClick={() => setPlanForm({ isNew: true, name: "", duration: "monthly", price: "", deviceLimit: 3, bandwidth: 25, priority: "medium", popular: false })}><Plus size={14} /> New plan</Btn>}>
          {plans.loading ? <Loading /> : (
            <div style={{ opacity: licenseExpired ? 0.45 : 1, pointerEvents: licenseExpired ? "none" : "auto", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px,1fr))", gap: 12 }}>
              {(plans.data || []).map((p) => (
                <div key={p.id} style={{ border: `1px solid ${p.popular ? T.primary : T.border}`, borderRadius: 10, padding: 14, position: "relative" }}>
                  {!!p.popular && <div style={{ position: "absolute", top: -10, right: 12, background: T.primary, color: "#fff", fontSize: 10.5, fontWeight: 700, padding: "2px 8px", borderRadius: 20 }}>MOST POPULAR</div>}
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{p.name}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, margin: "6px 0", color: T.primary }}>{formatMoney(p.price, currency)}<span style={{ fontSize: 12, color: T.sub, fontWeight: 500 }}> / {DURATIONS.find((d) => d.key === p.duration)?.label.toLowerCase()}</span></div>
                  <div style={{ fontSize: 12, color: T.sub, marginBottom: 10 }}>{p.device_limit} devices · {p.bandwidth} Mbps · {p.priority} priority</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <Btn size="sm" variant="outline" onClick={() => setPlanForm({ ...p, deviceLimit: p.device_limit })}><Save size={12} /> Edit</Btn>
                    <Btn size="sm" variant="ghost" tone={T.danger} onClick={() => deletePlan(p.id)}><Trash2 size={12} /></Btn>
                  </div>
                </div>
              ))}
              {(plans.data || []).length === 0 && <EmptyRow text="No plans yet — create your first one." />}
            </div>
          )}

          {planForm && (
            <div style={{ marginTop: 18, borderTop: `1px solid ${T.border}`, paddingTop: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 10 }}>{planForm.isNew ? "New plan" : "Edit plan"}</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="Plan name"><input style={inputStyle} value={planForm.name} onChange={(e) => setPlanForm({ ...planForm, name: e.target.value })} placeholder="e.g. Weekly Standard" /></Field>
                <Field label="Price (USD)"><input style={inputStyle} type="number" value={planForm.price} onChange={(e) => setPlanForm({ ...planForm, price: e.target.value })} /></Field>
                <Field label="Duration">
                  <select style={inputStyle} value={planForm.duration} onChange={(e) => setPlanForm({ ...planForm, duration: e.target.value })}>
                    {DURATIONS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                  </select>
                </Field>
                <Field label="Device limit"><input style={inputStyle} type="number" value={planForm.deviceLimit} onChange={(e) => setPlanForm({ ...planForm, deviceLimit: e.target.value })} /></Field>
                <Field label="Bandwidth (Mbps)"><input style={inputStyle} type="number" value={planForm.bandwidth} onChange={(e) => setPlanForm({ ...planForm, bandwidth: e.target.value })} /></Field>
                <Field label="Priority level">
                  <select style={inputStyle} value={planForm.priority} onChange={(e) => setPlanForm({ ...planForm, priority: e.target.value })}>
                    <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
                  </select>
                </Field>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, fontSize: 13 }}>
                <input type="checkbox" checked={!!planForm.popular} onChange={(e) => setPlanForm({ ...planForm, popular: e.target.checked })} /> Mark as "Most Popular"
              </label>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <Btn onClick={savePlan}><Save size={14} /> Save plan</Btn>
                <Btn variant="ghost" onClick={() => setPlanForm(null)}>Cancel</Btn>
              </div>
            </div>
          )}
        </Panel>
      )}

      {tab === "portal" && (
        <Panel title={dt(dashboardLang, "portalConfigTitle")}>
          {portalSettingsRes.loading || !portal ? <Loading /> : (
            <div style={{ opacity: licenseExpired ? 0.45 : 1, pointerEvents: licenseExpired ? "none" : "auto", display: "flex", gap: 24, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 260 }}>
                <Field label={dt(dashboardLang, "fieldSsid")}><input style={inputStyle} value={portal.ssid || ""} onChange={(e) => setPortalForm({ ...portal, ssid: e.target.value })} /></Field>
                <Field label={dt(dashboardLang, "fieldPortalTitle")}><input style={inputStyle} value={portal.portalTitle ?? portal.portal_title ?? ""} onChange={(e) => setPortalForm({ ...portal, portalTitle: e.target.value })} /></Field>
                <Field label={dt(dashboardLang, "fieldBrandColor")}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input type="color" value={portal.color || "#667eea"} onChange={(e) => setPortalForm({ ...portal, color: e.target.value })} style={{ width: 40, height: 34, border: `1px solid ${T.border}`, borderRadius: 6, padding: 2 }} />
                    <input style={inputStyle} value={portal.color || ""} onChange={(e) => setPortalForm({ ...portal, color: e.target.value })} />
                  </div>
                </Field>
                <div style={{ display: "flex", gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <Field label={dt(dashboardLang, "fieldCurrency")}>
                      <select style={inputStyle} value={portal.currency || "USD"} onChange={(e) => setPortalForm({ ...portal, currency: e.target.value })}>
                        {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
                      </select>
                    </Field>
                  </div>
                  <div style={{ flex: 1 }}>
                    <Field label={dt(dashboardLang, "fieldPortalLanguage")}>
                      <select style={inputStyle} value={portal.language || "en"} onChange={(e) => setPortalForm({ ...portal, language: e.target.value })}>
                        {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                      </select>
                    </Field>
                  </div>
                </div>
                <Field label={dt(dashboardLang, "fieldContactEmail")}><input style={inputStyle} value={portal.contactEmail ?? portal.contact_email ?? ""} onChange={(e) => setPortalForm({ ...portal, contactEmail: e.target.value })} /></Field>
                <Field label={dt(dashboardLang, "fieldContactWhatsapp")}><input style={inputStyle} value={portal.contactWhatsapp ?? portal.contact_whatsapp ?? ""} onChange={(e) => setPortalForm({ ...portal, contactWhatsapp: e.target.value })} /></Field>

                {/* Payout details — where a customer's Bank Transfer/USSD
                    payment on the captive portal actually goes. These map
                    straight onto CaptivePortal.jsx's TransferPayBlock via
                    the public /api/portal/:id endpoint (bankAccount.*,
                    ussdCode); until a reseller fills these in, their
                    customers see blank payment details with nowhere to
                    send money. */}
                <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${T.border}` }}>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>{dt(dashboardLang, "payoutDetailsTitle")}</div>
                  <div style={{ fontSize: 12, color: T.sub, marginBottom: 10 }}>{dt(dashboardLang, "payoutDetailsHint")}</div>
                  <Field label={dt(dashboardLang, "fieldBankName")}><input style={inputStyle} value={portal.bankName ?? portal.bank_name ?? ""} onChange={(e) => setPortalForm({ ...portal, bankName: e.target.value })} /></Field>
                  <Field label={dt(dashboardLang, "fieldBankAccountName")}><input style={inputStyle} value={portal.bankAccountName ?? portal.bank_account_name ?? ""} onChange={(e) => setPortalForm({ ...portal, bankAccountName: e.target.value })} /></Field>
                  <div style={{ display: "flex", gap: 12 }}>
                    <div style={{ flex: 1 }}>
                      <Field label={dt(dashboardLang, "fieldBankAccountNumber")}><input style={inputStyle} value={portal.bankAccountNumber ?? portal.bank_account_number ?? ""} onChange={(e) => setPortalForm({ ...portal, bankAccountNumber: e.target.value })} /></Field>
                    </div>
                    <div style={{ flex: 1 }}>
                      <Field label={dt(dashboardLang, "fieldUssdCode")}><input style={inputStyle} value={portal.ussdCode ?? portal.ussd_code ?? ""} onChange={(e) => setPortalForm({ ...portal, ussdCode: e.target.value })} /></Field>
                    </div>
                  </div>
                </div>

                <Btn onClick={savePortal} style={{ marginTop: 14 }}><Save size={14} /> {dt(dashboardLang, "saveSettings")}</Btn>
              </div>
              <div style={{ flex: 1, minWidth: 260 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: T.sub, marginBottom: 8 }}>{dt(dashboardLang, "livePreview")}</div>
                <div style={{ border: `1px solid ${T.border}`, borderRadius: 14, overflow: "hidden" }}>
                  <div style={{ background: `linear-gradient(135deg, ${portal.color || T.primary}, ${T.secondary})`, padding: "26px 20px", color: "#fff", textAlign: "center" }}>
                    <Wifi size={26} style={{ marginBottom: 8 }} />
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{(portal.portalTitle ?? portal.portal_title) || dt(dashboardLang, "portalTitlePlaceholder")}</div>
                    <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>{portal.ssid}</div>
                  </div>
                  <div style={{ padding: 16, fontSize: 12.5, color: T.sub, textAlign: "center" }}>
                    {t(portal.language || "en", "choosePlan")} — {t(portal.language || "en", "continueToPayment")}, e.g. {formatMoney(10, portal.currency || "USD")}/mo
                  </div>
                </div>
              </div>
            </div>
          )}
        </Panel>
      )}

      {tab === "pending" && (
        <Panel title="Pending payment confirmations" action={<Badge tone={pendingCount ? T.warning : T.success}>{pendingCount} pending</Badge>}>
          <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 14 }}>Every portal signup is a manual bank transfer or USSD push — nothing activates automatically. Verify the receipt against your account before confirming; that's what issues the voucher.</div>
          {pending.loading ? <Loading /> : (pending.data || []).length === 0 ? <EmptyRow text="No pending signups." /> : (
            pending.data.slice().sort((a, b) => b.time - a.time).map((req) => (
              <div key={req.id} style={{ padding: "13px 4px", borderBottom: `1px solid ${T.border}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13.5 }}>{req.name} <span style={{ fontWeight: 400, color: T.sub }}>— {req.plan_name}</span></div>
                    <div style={{ fontSize: 12, color: T.sub, marginTop: 2 }}>
                      {formatMoney(req.amount, currency)} via {req.method} · ref: <span style={{ fontFamily: "monospace" }}>{req.reference}</span> · {timeAgo(req.time)}
                      {req.receipt_url && (
                        <> · <a href={req.receipt_url} target="_blank" rel="noreferrer" style={{ color: T.primary, fontWeight: 600 }}>view receipt</a></>
                      )}
                    </div>
                  </div>
                  {req.status === "pending" ? (
                    <div style={{ display: "flex", gap: 6 }}>
                      <Btn size="sm" tone={T.success} onClick={() => decideActivation(req.id, "confirmed")}><CheckCircle2 size={13} /> Confirm</Btn>
                      <Btn size="sm" variant="soft" tone={T.danger} onClick={() => decideActivation(req.id, "rejected")}><XCircle size={13} /> Reject</Btn>
                    </div>
                  ) : (
                    <Badge tone={statusColor(req.status)}>{req.status}</Badge>
                  )}
                </div>
              </div>
            ))
          )}
        </Panel>
      )}

      {tab === "billing" && (
        <Panel title="Revenue & billing">
          {billing.loading ? <Loading /> : billing.data && (
            <div style={{ opacity: licenseExpired ? 0.45 : 1, pointerEvents: licenseExpired ? "none" : "auto" }}>
              <div style={{ display: "flex", gap: 14, marginBottom: 16, flexWrap: "wrap" }}>
                <StatCard icon={TrendingUp} label="Monthly revenue" value={formatMoney(billing.data.monthlyRevenue.toFixed(0), currency)} tone={T.success} />
                <StatCard icon={CreditCard} label={`Platform license fee (${platformCurrency})`} value={formatMoney(billing.data.licenseFee, platformCurrency)} tone={T.secondary} />
                {currency === platformCurrency ? (
                  <StatCard icon={DollarSign} label="Net profit" value={formatMoney(billing.data.netProfit.toFixed(0), platformCurrency)} tone={T.primary} />
                ) : (
                  <div style={{ maxWidth: 220, fontSize: 11.5, color: T.sub, display: "flex", alignItems: "center", padding: "0 4px" }}>
                    Net profit isn't shown here since your revenue is in {currency} and the license fee is billed in {platformCurrency} — there's no currency conversion in SAFE_Links, so subtracting them directly would be misleading.
                  </div>
                )}
              </div>
              <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 8 }}>Recent voucher payments</div>
              {(billing.data.payments || []).length === 0 && <EmptyRow text="No payments yet." />}
              {(billing.data.payments || []).map((p) => (
                <div key={p.id} style={{ display: "flex", justifyContent: "space-between", padding: "9px 4px", borderBottom: `1px solid ${T.border}`, fontSize: 13 }}>
                  <span>{p.note}</span>
                  <span><Badge tone={statusColor(p.status)}>{p.status} · {formatMoney(p.amount, currency)}</Badge></span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}

      {tab === "license" && (
        <>
        <Panel title="License & subscription">
          {license.loading ? <Loading /> : license.data && (
            <>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 16 }}>
                <StatCard icon={Key} label="License key" value={license.data.license_key} tone={T.secondary} />
                <StatCard icon={Clock} label="Expiry" value={licenseExpired ? "Expired" : new Date(license.data.subscription_expiry).toLocaleDateString()} tone={licenseExpired ? T.danger : T.success} />
                <StatCard icon={Package} label="Current tier" value={license.data.subscription_plan} tone={T.primary} />
              </div>

              {license.data.pendingPayment ? (
                <div style={{ background: `${T.warning}12`, border: `1px solid ${T.warning}44`, borderRadius: 10, padding: 14, fontSize: 13 }}>
                  A renewal for <b>{formatMoney(license.data.pendingPayment.amount, platformCurrency)}</b> via {license.data.pendingPayment.method} (ref: <span style={{ fontFamily: "monospace" }}>{license.data.pendingPayment.reference}</span>) is awaiting Super Admin confirmation.
                </div>
              ) : licenseStep === "view" ? (
                <Btn onClick={() => { setChosenPlanId(license.data.subscription_plan); setLicenseStep("choose"); }}>
                  {licenseExpired ? "Renew & submit payment" : "Change plan / renew early"}
                </Btn>
              ) : licenseStep === "choose" ? (
                <PlanChooser
                  chosenPlanId={chosenPlanId} setChosenPlanId={setChosenPlanId} platformPlans={platformPlans} platformCurrency={platformCurrency}
                  onContinue={() => setLicenseStep("pay")} onCancel={() => setLicenseStep("view")}
                />
              ) : (
                bankInfo.data && (
                  <div style={{ maxWidth: 380 }}>
                    <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 10 }}>Submit your license renewal transfer</div>
                    <TransferPayBlock
                      payee={{ name: "SAFE_Links (Super Admin)", bankName: bankInfo.data.bank_name, accountName: bankInfo.data.bank_account_name, accountNumber: bankInfo.data.bank_account_number, ussdCode: bankInfo.data.ussd_code }}
                      amount={chosenPlanPrice != null ? formatMoney(chosenPlanPrice, platformCurrency) : "—"} method={licenseMethod} setMethod={setLicenseMethod}
                      reference={licenseReference} setReference={setLicenseReference}
                      onSubmit={submitLicenseRenewal} submitLabel="Submit for confirmation" submitting={licenseSubmitting}
                      onUploadFile={uploadLicenseReceiptFile} receiptUrl={licenseReceiptUrl} setReceiptUrl={setLicenseReceiptUrl}
                    />
                    <Btn variant="ghost" onClick={() => setLicenseStep("choose")} style={{ marginTop: 8 }}>Back</Btn>
                  </div>
                )
              )}
            </>
          )}
        </Panel>

        <div style={{ height: 20 }} />

        <Panel title="Activate with a product key">
          <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 14, maxWidth: 520 }}>
            Got a key from Super Admin instead of doing a bank transfer? Enter it here — activation is instant, no waiting on confirmation.
          </div>
          <div style={{ display: "flex", gap: 10, maxWidth: 420 }}>
            <input
              style={{ ...inputStyle, fontFamily: "monospace", letterSpacing: 1, textTransform: "uppercase" }}
              value={productKeyInput}
              onChange={(e) => setProductKeyInput(e.target.value)}
              placeholder="XXXX-XXXX-XXXX-XXXX"
              onKeyDown={(e) => { if (e.key === "Enter") redeemProductKey(); }}
            />
            <Btn onClick={redeemProductKey} disabled={redeemingKey}><Key size={14} /> {redeemingKey ? "Activating…" : "Activate"}</Btn>
          </div>
        </Panel>
        </>
      )}

      {tab === "referrals" && (
        <>
          <Panel title="Your referral code">
            <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 14, maxWidth: 560 }}>
              Refer another reseller or a marketer using the email/phone form below, or just share your link. When someone signs up with your code, you earn a bonus — Super Admin confirms and marks it paid once they've actually sent it, same manual-payment pattern as everything else here.
            </div>
            {referrals.loading ? <Loading /> : (
              <>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", marginBottom: 18 }}>
                  <div style={{ background: T.bg, borderRadius: 10, padding: "10px 16px", fontFamily: "monospace", fontWeight: 700, fontSize: 15, letterSpacing: 1, color: T.ink }}>
                    {referrals.data?.referralCode || "—"}
                  </div>
                  <Btn variant="outline" size="sm" onClick={copyReferralLink}><Copy size={12} /> {linkCopied ? "Link copied!" : "Copy referral link"}</Btn>
                  <div style={{ fontSize: 12.5, color: T.sub }}>
                    Bonus per signup: <b style={{ color: T.ink }}>{formatMoney(referrals.data?.bonusAmount, referrals.data?.currency)}</b>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                  <StatCard icon={Users} label="Invited" value={referrals.data?.summary?.invited ?? 0} tone={T.sub} />
                  <StatCard icon={Clock} label="Signed up — pending" value={referrals.data?.summary?.signedUp ?? 0} tone={T.warning} />
                  <StatCard icon={Gift} label="Bonuses paid" value={referrals.data?.summary?.bonusPaid ?? 0} tone={T.success} />
                  <StatCard icon={DollarSign} label="Total earned" value={formatMoney(referrals.data?.summary?.totalEarned, referrals.data?.currency)} tone={T.success} />
                  <StatCard icon={DollarSign} label="Pending" value={formatMoney(referrals.data?.summary?.totalPending, referrals.data?.currency)} tone={T.warning} />
                </div>
              </>
            )}
          </Panel>

          <div style={{ height: 20 }} />

          <Panel title="Invite someone">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, alignItems: "end", maxWidth: 720 }}>
              <Field label="Name"><input style={inputStyle} value={referralForm.name} onChange={(e) => setReferralForm({ ...referralForm, name: e.target.value })} placeholder="e.g. Amina Yusuf" /></Field>
              <Field label="Email"><input style={inputStyle} type="email" value={referralForm.email} onChange={(e) => setReferralForm({ ...referralForm, email: e.target.value })} placeholder="amina@example.com" /></Field>
              <Field label="Phone"><input style={inputStyle} value={referralForm.phone} onChange={(e) => setReferralForm({ ...referralForm, phone: e.target.value })} placeholder="+254 700 000 000" /></Field>
            </div>
            <Btn onClick={submitReferral} disabled={referralSubmitting}><Gift size={14} /> {referralSubmitting ? "Adding…" : "Add referral"}</Btn>
          </Panel>

          <div style={{ height: 20 }} />

          <Panel title="Your referrals" action={<Badge tone={T.primary}>{(referrals.data?.referrals || []).length} total</Badge>}>
            {referrals.loading ? <Loading /> : (referrals.data?.referrals || []).length === 0 ? (
              <EmptyRow text="No referrals yet — invite someone above to get started." />
            ) : (
              (referrals.data.referrals || []).map((r) => (
                <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "12px 4px", borderBottom: `1px solid ${T.border}`, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13.5 }}>{r.name || r.referred_company_name || r.email || r.phone}</div>
                    <div style={{ fontSize: 11.5, color: T.sub, display: "flex", gap: 10, marginTop: 2 }}>
                      {r.email && <span style={{ display: "flex", alignItems: "center", gap: 4 }}><Mail size={11} /> {r.email}</span>}
                      {r.phone && <span style={{ display: "flex", alignItems: "center", gap: 4 }}><Phone size={11} /> {r.phone}</span>}
                      <span>{timeAgo(r.created_at)}</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ fontSize: 12.5, color: T.sub }}>{formatMoney(r.bonus_amount, referrals.data?.currency)}</div>
                    <Badge tone={r.status === "bonus_paid" ? T.success : r.status === "signed_up" ? T.warning : r.status === "flagged" ? T.danger : T.sub}>
                      {r.status === "bonus_paid" ? "Bonus paid" : r.status === "signed_up" ? "Signed up — bonus pending" : r.status === "flagged" ? "Flagged for review" : "Invited"}
                    </Badge>
                    {r.status === "invited" && (
                      <Btn size="sm" variant="ghost" tone={T.danger} onClick={() => withdrawReferral(r.id)}><Trash2 size={12} /></Btn>
                    )}
                  </div>
                </div>
              ))
            )}
          </Panel>
        </>
      )}

      {tab === "installer" && (
        <Panel title="Zero-touch installer" action={<Badge tone={routerOnline ? T.success : T.sub}>{routerOnline ? "Router online" : "No router linked yet"}</Badge>}>
          <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 16, maxWidth: 480 }}>
            Run this on your phone at a new location — it registers the router with your account and generates its polling API key. This can also be reached directly at <code>/install</code> for a field technician.
          </div>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <InstallerWizard key={installerKey} onComplete={onInstallerComplete} embedded />
          </div>
        </Panel>
      )}

      {tab === "support" && (
        <>
        <Panel title="Customer support requests" action={<Badge tone={openCustomerTickets ? T.warning : T.success}>{openCustomerTickets} open</Badge>}>
          <div style={{ fontSize: 12.5, color: T.sub, marginBottom: 14 }}>
            Raised by your own end-users from the Captive Portal's "Need help?" link. There's no automated email in SAFE_Links — nothing here notifies the customer, so reach them yourself at the contact they gave.
          </div>
          {customerSupport.loading ? <Loading /> : (customerSupport.data || []).length === 0 ? <EmptyRow text="No requests from customers yet." /> : (
            customerSupport.data.slice().sort((a, b) => b.time - a.time).map((ct) => (
              <div key={ct.id} style={{ padding: "12px 4px", borderBottom: `1px solid ${T.border}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{ct.subject}</div>
                  <Badge tone={statusColor(ct.status)}>{ct.status}</Badge>
                </div>
                <div style={{ fontSize: 11.5, color: T.sub, marginBottom: 6 }}>
                  {ct.customer_name}{ct.customer_email ? ` · ${ct.customer_email}` : ""}{ct.customer_phone ? ` · ${ct.customer_phone}` : ""} · {timeAgo(ct.time)}
                </div>
                <div style={{ fontSize: 12.5, color: T.ink, background: T.bg, borderRadius: 8, padding: 9, marginBottom: 8 }}>
                  {ct.message}
                  {ct.attachment_url && (
                    <div style={{ marginTop: 6 }}><a href={ct.attachment_url} target="_blank" rel="noreferrer" style={{ color: T.primary, fontSize: 11.5, fontWeight: 600 }}>📎 view attachment</a></div>
                  )}
                </div>
                {(ct.messages || []).map((m) => (
                  <div key={m.id} style={{ fontSize: 12.5, color: T.ink, background: `${T.secondary}0d`, borderLeft: `3px solid ${T.secondary}`, borderRadius: 6, padding: 9, marginBottom: 8 }}>
                    <b>Your note:</b> {m.message}
                    {m.attachment_url && (
                      <div style={{ marginTop: 4 }}><a href={m.attachment_url} target="_blank" rel="noreferrer" style={{ color: T.secondary, fontSize: 11.5, fontWeight: 600 }}>📎 view attachment</a></div>
                    )}
                    <div style={{ fontSize: 10.5, color: T.sub, marginTop: 3 }}>{timeAgo(m.time)}</div>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 8 }}>
                  <input style={inputStyle} placeholder="Note what you did / told them…" value={customerReply[ct.id] || ""} onChange={(e) => setCustomerReply((r2) => ({ ...r2, [ct.id]: e.target.value }))} />
                  <Btn size="sm" onClick={() => sendCustomerReply(ct.id)}><MessageSquare size={13} /> {dt(dashboardLang, "addNote")}</Btn>
                  {ct.status === "open" ? (
                    <Btn size="sm" variant="soft" tone={T.success} onClick={() => setCustomerTicketStatus(ct.id, "resolved")}><CheckCircle2 size={13} /> {dt(dashboardLang, "resolve")}</Btn>
                  ) : (
                    <Btn size="sm" variant="ghost" onClick={() => setCustomerTicketStatus(ct.id, "open")}>{dt(dashboardLang, "reopen")}</Btn>
                  )}
                </div>
                <AttachmentPicker
                  onUpload={uploadSupportAttachment}
                  attachmentUrl={customerReplyAttachment[ct.id] || null}
                  setAttachmentUrl={(url) => setCustomerReplyAttachment((r2) => ({ ...r2, [ct.id]: url }))}
                  lang={dashboardLang}
                />
              </div>
            ))
          )}
        </Panel>
        <div style={{ height: 20 }} />
        <Panel title="Contact Super Admin support" action={openTickets > 0 && <Badge tone={T.warning}>{openTickets} open</Badge>}>
          <div style={{ marginBottom: 18 }}>
            <Field label="Subject"><input style={inputStyle} value={ticketForm.subject} onChange={(e) => setTicketForm({ ...ticketForm, subject: e.target.value })} placeholder="e.g. Question about license renewal" /></Field>
            <Field label="Message">
              <textarea style={{ ...inputStyle, minHeight: 80, resize: "vertical", fontFamily: "inherit" }} value={ticketForm.message} onChange={(e) => setTicketForm({ ...ticketForm, message: e.target.value })} placeholder="Describe your issue or question…" />
            </Field>
            <AttachmentPicker onUpload={uploadSupportAttachment} attachmentUrl={ticketAttachmentUrl} setAttachmentUrl={setTicketAttachmentUrl} lang={dashboardLang} />
            <div style={{ height: 10 }} />
            <Btn onClick={submitTicket}><MessageSquare size={14} /> Send to Super Admin</Btn>
          </div>
          <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 8, borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>Your tickets</div>
          {support.loading ? <Loading /> : (support.data || []).length === 0 ? <EmptyRow text="No tickets sent yet." /> : (
            support.data.slice().sort((a, b) => b.time - a.time).map((st) => (
              <div key={st.id} style={{ padding: "12px 4px", borderBottom: `1px solid ${T.border}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{st.subject}</div>
                  <Badge tone={statusColor(st.status)}>{st.status}</Badge>
                </div>
                <div style={{ fontSize: 12.5, color: T.sub, margin: "4px 0" }}>
                  {st.message}
                  {st.attachment_url && (
                    <div style={{ marginTop: 4 }}><a href={st.attachment_url} target="_blank" rel="noreferrer" style={{ color: T.primary, fontSize: 11.5, fontWeight: 600 }}>📎 view attachment</a></div>
                  )}
                </div>
                {(st.messages || []).map((m) => (
                  <div key={m.id} style={{
                    fontSize: 12.5, color: T.ink, borderRadius: 6, padding: 9, marginTop: 6,
                    background: m.sender === "admin" ? `${T.secondary}0d` : T.bg,
                    borderLeft: m.sender === "admin" ? `3px solid ${T.secondary}` : "none",
                    marginLeft: m.sender === "admin" ? 0 : 16,
                  }}>
                    <b>{m.sender === "admin" ? "Super Admin" : "You"}:</b> {m.message}
                    {m.attachment_url && (
                      <div style={{ marginTop: 4 }}><a href={m.attachment_url} target="_blank" rel="noreferrer" style={{ color: T.secondary, fontSize: 11.5, fontWeight: 600 }}>📎 view attachment</a></div>
                    )}
                    <div style={{ fontSize: 10.5, color: T.sub, marginTop: 3 }}>{timeAgo(m.time)}</div>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <input style={inputStyle} placeholder="Reply…" value={adminReply[st.id] || ""} onChange={(e) => setAdminReply((r2) => ({ ...r2, [st.id]: e.target.value }))} />
                  <Btn size="sm" onClick={() => sendAdminReply(st.id)}><MessageSquare size={13} /> {dt(dashboardLang, "sendReply")}</Btn>
                  {st.status === "open" ? (
                    <Btn size="sm" variant="ghost" onClick={() => setAdminTicketStatus(st.id, "resolved")}>{dt(dashboardLang, "markResolved")}</Btn>
                  ) : (
                    <Btn size="sm" variant="ghost" onClick={() => setAdminTicketStatus(st.id, "open")}>{dt(dashboardLang, "reopen")}</Btn>
                  )}
                </div>
                <AttachmentPicker
                  onUpload={uploadSupportAttachment}
                  attachmentUrl={adminReplyAttachment[st.id] || null}
                  setAttachmentUrl={(url) => setAdminReplyAttachment((r2) => ({ ...r2, [st.id]: url }))}
                  lang={dashboardLang}
                />
              </div>
            ))
          )}
        </Panel>
        </>
      )}
      {tab === "notifications" && (
        <Panel title="Notification center" action={<Btn size="sm" variant="ghost" onClick={markAllNotificationsRead}>{dt(dashboardLang, "markAllRead")}</Btn>}>
          {notifications.loading ? <Loading /> : (notifications.data || []).length === 0 ? <EmptyRow text="You're all caught up." /> : (
            notifications.data.slice().sort((a, b) => b.time - a.time).map((n) => (
              <div key={n.id} onClick={() => onNotificationClick(n)}
                style={{
                  display: "flex", gap: 12, padding: "12px 4px", borderBottom: `1px solid ${T.border}`, opacity: n.read ? 0.6 : 1,
                  cursor: n.action_tab ? "pointer" : "default",
                }}>
                <div style={{ width: 30, height: 30, borderRadius: 8, background: `${T.primary}18`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {n.type === "payment_confirmation" ? <Inbox size={14} color={T.primary} /> : n.type === "support_ticket" ? <MessageSquare size={14} color={T.primary} /> : n.type === "referral" ? <Gift size={14} color={T.primary} /> : <AlertCircle size={14} color={T.warning} />}
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
    </>
  );

  return (
    <Shell roleLabel="Reseller Admin" roleIcon={Building2} tone={T.primary} identity={companyName}
      tabs={tabs} active={tab} onTab={setTab} onExit={onExit}
      badges={{ pending: pendingCount, support: openTickets + openCustomerTickets, notifications: unreadNotifs }}
      notifications={notifications.data} dashboardLang={dashboardLang}>
      {content}
    </Shell>
  );
}

function PlanChooser({ chosenPlanId, setChosenPlanId, platformPlans, platformCurrency, onContinue, onCancel }) {
  const list = platformPlans.data || [];
  return (
    <div>
      <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 10 }}>Choose your platform plan</div>
      {platformPlans.loading ? <Loading /> : list.length === 0 ? <EmptyRow text="No platform plans available — contact Super Admin support." /> : (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px,1fr))", gap: 12, marginBottom: 14 }}>
        {list.map((p) => (
          <div key={p.id} onClick={() => setChosenPlanId(p.id)} style={{ border: `2px solid ${chosenPlanId === p.id ? T.primary : T.border}`, borderRadius: 10, padding: 14, cursor: "pointer" }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>{p.name}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: T.primary, margin: "6px 0" }}>{formatMoney(p.price, platformCurrency)}<span style={{ fontSize: 11, color: T.sub, fontWeight: 500 }}>/mo</span></div>
            <div style={{ fontSize: 11.5, color: T.sub }}>Up to {p.maxClients ?? p.max_clients} clients · {p.maxDevicesPerClient ?? p.max_devices_per_client} devices/client</div>
          </div>
        ))}
      </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <Btn onClick={onContinue} disabled={!chosenPlanId}>Continue to payment <ChevronRight size={14} /></Btn>
        <Btn variant="ghost" onClick={onCancel}>Cancel</Btn>
      </div>
    </div>
  );
}
