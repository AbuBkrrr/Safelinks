// Reseller growth tools: earnings dashboard, automatic payouts, customer list
// + broadcast, promo codes, happy hour / trial / loyalty / referral settings,
// sales agents with commission, router reboot, message outbox.
import { db, id } from "../db.js";
import { json } from "../http.js";
import { authenticate } from "../auth.js";
import * as paystack from "../payments/paystack.js";
import { sendMessage, normalizePhone, naira, providerConfigured } from "../notify.js";
import { queueForReseller } from "../routerCommands.js";
import { issueVoucher, localDay, localHour } from "../growth.js";

function reseller(req, res) {
  const a = authenticate(req, "reseller");
  if (!a.ok) { json(res, a.status, { error: a.error }); return null; }
  return a.user.resellerId;
}

const PLATFORM_FEE_PCT = () => Number(process.env.PLATFORM_FEE_PCT || 5);
const DAY = 86400e3;

/** Revenue figures used by the dashboard and the daily summary message. */
export async function earnings(resellerId, sinceMs) {
  const rows = await db.prepare(`
    SELECT p.amount, p.time, p.plan_id, pl.name AS plan_name, v.router_id
    FROM payments p LEFT JOIN plans pl ON pl.id = p.plan_id LEFT JOIN vouchers v ON v.id = p.voucher_id
    WHERE p.reseller_id = ? AND p.status = 'paid' AND COALESCE(p.purpose_kind,'voucher') <> 'wallet' AND p.time >= ?`).all(resellerId, sinceMs);
  const byDay = {}, byPlan = {}, byHour = Array(24).fill(0), byRouter = {};
  let total = 0;
  for (const r of rows) {
    const amt = Number(r.amount || 0); total += amt;
    const d = localDay(Number(r.time));
    byDay[d] = (byDay[d] || 0) + amt;
    const pn = r.plan_name || "Other";
    byPlan[pn] = byPlan[pn] || { plan: pn, sales: 0, revenue: 0 };
    byPlan[pn].sales += 1; byPlan[pn].revenue += amt;
    byHour[localHour(Number(r.time))] += amt;
    const rk = r.router_id || "unassigned";
    byRouter[rk] = (byRouter[rk] || 0) + amt;
  }
  return {
    total: Math.round(total * 100) / 100, sales: rows.length,
    byDay: Object.entries(byDay).sort().map(([day, revenue]) => ({ day, revenue })),
    byPlan: Object.values(byPlan).sort((a, b) => b.revenue - a.revenue),
    byHour: byHour.map((revenue, hour) => ({ hour, revenue })),
    byRouter: Object.entries(byRouter).map(([router, revenue]) => ({ router, revenue })).sort((a, b) => b.revenue - a.revenue),
  };
}

export function registerGrowthRoutes(router) {
  // ---- earnings dashboard ------------------------------------------------
  router.get("/api/reseller/earnings", async (req, res, { query }) => {
    const rid = reseller(req, res); if (!rid) return;
    const days = Math.min(365, Math.max(1, Number(query.days || 30)));
    const today = await earnings(rid, Date.parse(localDay() + "T00:00:00Z") - Number(process.env.BUSINESS_TZ_OFFSET ?? 1) * 3600e3);
    const period = await earnings(rid, Date.now() - days * DAY);
    const customers = await db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(wallet_balance),0) AS w FROM customers WHERE reseller_id = ?").get(rid);
    const active = await db.prepare("SELECT COUNT(*) AS n FROM vouchers WHERE reseller_id = ? AND status = 'active' AND expires_at > ?").get(rid, Date.now());
    json(res, 200, { today, period, days, customers: Number(customers.n), walletFloat: Number(customers.w), activeLogins: Number(active.n) });
  });

  // ---- settings: notifications, trial, loyalty, referral, happy hour -------
  router.get("/api/reseller/growth-settings", async (req, res) => {
    const rid = reseller(req, res); if (!rid) return;
    const r = await db.prepare(`SELECT notify_phone, trial_enabled, trial_minutes, loyalty_every, referral_reward_minutes,
      happy_hour_start, happy_hour_end, happy_hour_pct, daily_summary, payout_bank_code, payout_account_number, payout_account_name, paystack_subaccount
      FROM resellers WHERE id = ?`).get(rid);
    json(res, 200, { ...r, smsProvider: providerConfigured(), paystack: paystack.isEnabled(), platformFeePct: PLATFORM_FEE_PCT() });
  });

  router.put("/api/reseller/growth-settings", async (req, res, { body }) => {
    const rid = reseller(req, res); if (!rid) return;
    const b = body || {};
    const int = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
    const hh = (v) => (v === null || v === "" || v === undefined ? null : int(v, 0, 23, null));
    const phone = b.notifyPhone ? normalizePhone(b.notifyPhone) : null;
    if (b.notifyPhone && !phone) return json(res, 400, { error: "Invalid phone number" });
    await db.prepare(`UPDATE resellers SET notify_phone = ?, trial_enabled = ?, trial_minutes = ?, loyalty_every = ?, referral_reward_minutes = ?,
      happy_hour_start = ?, happy_hour_end = ?, happy_hour_pct = ?, daily_summary = ? WHERE id = ?`).run(
      phone, b.trialEnabled ? 1 : 0, int(b.trialMinutes, 0, 60, 5), int(b.loyaltyEvery, 0, 100, 10), int(b.referralRewardMinutes, 0, 1440, 60),
      hh(b.happyHourStart), hh(b.happyHourEnd), int(b.happyHourPct, 0, 90, 0), b.dailySummary ? 1 : 0, rid);
    json(res, 200, { ok: true });
  });

  // ---- automatic payouts (Paystack subaccount) ----------------------------
  router.get("/api/reseller/payout/banks", async (req, res) => {
    const rid = reseller(req, res); if (!rid) return;
    if (!paystack.isEnabled()) return json(res, 400, { error: "Paystack is not configured on this platform" });
    try { json(res, 200, { banks: await paystack.listBanks() }); } catch (e) { json(res, 502, { error: e.message }); }
  });

  router.post("/api/reseller/payout", async (req, res, { body }) => {
    const rid = reseller(req, res); if (!rid) return;
    if (!paystack.isEnabled()) return json(res, 400, { error: "Paystack is not configured on this platform" });
    const bankCode = String(body?.bankCode || "").trim(), acct = String(body?.accountNumber || "").replace(/\D/g, "");
    if (!bankCode || acct.length !== 10) return json(res, 400, { error: "Choose your bank and enter the 10-digit account number" });
    const r = await db.prepare("SELECT company_name, paystack_subaccount FROM resellers WHERE id = ?").get(rid);
    try {
      const accountName = await paystack.resolveAccount(acct, bankCode);
      const code = await paystack.upsertSubaccount({ existingCode: r.paystack_subaccount, businessName: r.company_name, bankCode, accountNumber: acct, platformPercent: PLATFORM_FEE_PCT() });
      await db.prepare("UPDATE resellers SET paystack_subaccount = ?, payout_bank_code = ?, payout_account_number = ?, payout_account_name = ? WHERE id = ?")
        .run(code, bankCode, acct, accountName, rid);
      json(res, 200, { ok: true, accountName, subaccount: code, platformFeePct: PLATFORM_FEE_PCT() });
    } catch (e) { json(res, 400, { error: e.message || "Could not set up payouts" }); }
  });

  // ---- customers + broadcast ---------------------------------------------
  router.get("/api/reseller/customers", async (req, res, { query }) => {
    const rid = reseller(req, res); if (!rid) return;
    const rows = await db.prepare(`SELECT c.id, c.phone, c.name, c.email, c.wallet_balance, c.paid_count, c.total_spent, c.last_purchase_at, c.created_at,
        c.auto_renew, c.opted_out, c.referral_code,
        (SELECT MAX(expires_at) FROM vouchers v WHERE v.customer_id = c.id AND v.status = 'active') AS active_until
      FROM customers c WHERE c.reseller_id = ? ORDER BY COALESCE(c.last_purchase_at, c.created_at) DESC LIMIT 1000`).all(rid);
    const q = String(query.q || "").toLowerCase();
    json(res, 200, { customers: q ? rows.filter((c) => `${c.phone} ${c.name || ""}`.toLowerCase().includes(q)) : rows });
  });

  // segment: all | active | lapsed (no purchase 7+ days) | never (trial/leads)
  router.post("/api/reseller/customers/broadcast", async (req, res, { body }) => {
    const rid = reseller(req, res); if (!rid) return;
    const msg = String(body?.message || "").trim();
    if (msg.length < 3 || msg.length > 480) return json(res, 400, { error: "Message must be 3-480 characters" });
    const seg = ["all", "active", "lapsed", "never"].includes(body?.segment) ? body.segment : "all";
    const now = Date.now();
    let rows = await db.prepare("SELECT id, phone, paid_count, last_purchase_at FROM customers WHERE reseller_id = ? AND opted_out = 0").all(rid);
    if (seg === "active") {
      const act = new Set((await db.prepare("SELECT DISTINCT customer_id FROM vouchers WHERE reseller_id = ? AND status='active' AND expires_at > ?").all(rid, now)).map((r) => r.customer_id));
      rows = rows.filter((c) => act.has(c.id));
    } else if (seg === "lapsed") rows = rows.filter((c) => c.paid_count > 0 && Number(c.last_purchase_at || 0) < now - 7 * DAY);
    else if (seg === "never") rows = rows.filter((c) => !c.paid_count);
    const r = await db.prepare("SELECT company_name FROM resellers WHERE id = ?").get(rid);
    let sent = 0, failed = 0;
    for (const c of rows.slice(0, 2000)) {
      const out = await sendMessage({ resellerId: rid, to: c.phone, kind: "broadcast", body: `${r.company_name}: ${msg}` });
      out.status === "failed" ? failed++ : sent++;
    }
    json(res, 200, { ok: true, segment: seg, recipients: rows.length, sent, failed, providerConfigured: providerConfigured() });
  });

  router.get("/api/reseller/messages", async (req, res) => {
    const rid = reseller(req, res); if (!rid) return;
    json(res, 200, { messages: await db.prepare("SELECT to_phone, kind, body, status, error, created_at FROM messages WHERE reseller_id = ? ORDER BY created_at DESC LIMIT 200").all(rid) });
  });

  // ---- promo codes ----------------------------------------------------------
  router.get("/api/reseller/promos", async (req, res) => {
    const rid = reseller(req, res); if (!rid) return;
    json(res, 200, { promos: await db.prepare("SELECT * FROM promo_codes WHERE reseller_id = ? ORDER BY created_at DESC").all(rid) });
  });
  router.post("/api/reseller/promos", async (req, res, { body }) => {
    const rid = reseller(req, res); if (!rid) return;
    const code = String(body?.code || "").trim().toUpperCase();
    if (!/^[A-Z0-9-]{3,20}$/.test(code)) return json(res, 400, { error: "Code: 3-20 letters, digits or -" });
    const pct = Math.min(100, Math.max(0, Number(body?.percentOff || 0))), amt = Math.max(0, Number(body?.amountOff || 0));
    if (!pct && !amt) return json(res, 400, { error: "Set a percent or amount off" });
    try {
      await db.prepare("INSERT INTO promo_codes (id,reseller_id,code,percent_off,amount_off,max_uses,expires_at,active,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(id("pr"), rid, code, pct, amt, Math.max(0, Number(body?.maxUses || 0)), body?.expiresAt ? Number(body.expiresAt) : null, 1, Date.now());
    } catch (e) { return json(res, 409, { error: "That code already exists" }); }
    json(res, 201, { ok: true });
  });
  router.delete("/api/reseller/promos/:id", async (req, res, { params }) => {
    const rid = reseller(req, res); if (!rid) return;
    await db.prepare("UPDATE promo_codes SET active = 0 WHERE id = ? AND reseller_id = ?").run(params.id, rid);
    json(res, 200, { ok: true });
  });

  // ---- sales agents + printed voucher cards --------------------------------
  router.get("/api/reseller/agents", async (req, res) => {
    const rid = reseller(req, res); if (!rid) return;
    const agents = await db.prepare("SELECT * FROM sales_agents WHERE reseller_id = ? AND active = 1 ORDER BY created_at DESC").all(rid);
    for (const a of agents) {
      const s = await db.prepare(`SELECT COUNT(*) AS cards, COUNT(v.redeemed_at) AS sold, COALESCE(SUM(CASE WHEN v.redeemed_at IS NOT NULL THEN pl.price END),0) AS revenue
        FROM vouchers v LEFT JOIN plans pl ON pl.id = v.plan_id WHERE v.agent_id = ?`).get(a.id);
      a.cards = Number(s.cards); a.sold = Number(s.sold); a.revenue = Number(s.revenue);
      a.commission = Math.round(a.revenue * Number(a.commission_pct)) / 100;
    }
    json(res, 200, { agents });
  });
  router.post("/api/reseller/agents", async (req, res, { body }) => {
    const rid = reseller(req, res); if (!rid) return;
    const name = String(body?.name || "").trim();
    if (!name) return json(res, 400, { error: "Agent name required" });
    await db.prepare("INSERT INTO sales_agents (id,reseller_id,name,phone,commission_pct,created_at) VALUES (?,?,?,?,?,?)")
      .run(id("ag"), rid, name.slice(0, 60), normalizePhone(body?.phone), Math.min(50, Math.max(0, Number(body?.commissionPct ?? 10))), Date.now());
    json(res, 201, { ok: true });
  });
  router.delete("/api/reseller/agents/:id", async (req, res, { params }) => {
    const rid = reseller(req, res); if (!rid) return;
    await db.prepare("UPDATE sales_agents SET active = 0 WHERE id = ? AND reseller_id = ?").run(params.id, rid);
    json(res, 200, { ok: true });
  });

  // Print a batch of cards (optionally for an agent). Cards start counting
  // down when first used (redeemed_at), not when printed.
  router.post("/api/reseller/cards", async (req, res, { body }) => {
    const rid = reseller(req, res); if (!rid) return;
    const count = Math.min(200, Math.max(1, Number(body?.count || 0)));
    const plan = await db.prepare("SELECT * FROM plans WHERE id = ? AND reseller_id = ?").get(body?.planId, rid);
    if (!plan) return json(res, 404, { error: "Plan not found" });
    const agent = body?.agentId ? await db.prepare("SELECT * FROM sales_agents WHERE id = ? AND reseller_id = ?").get(body.agentId, rid) : null;
    const cards = [];
    for (let i = 0; i < count; i++) {
      // Long validity until first use; the portal redeem sets the real expiry.
      const v = await issueVoucher({ resellerId: rid, plan, source: "card", agentId: agent?.id || null, durationMs: 365 * DAY });
      await db.prepare("UPDATE vouchers SET status = 'unused' WHERE id = ?").run(v.id);
      cards.push({ code: v.username, password: v.password, plan: plan.name, price: plan.price });
    }
    // Unused cards are not live on the routers until redeemed.
    await db.prepare(`UPDATE router_commands SET status = 'dropped' WHERE status = 'pending' AND type = 'create_user' AND (${cards.map(() => "payload LIKE ?").join(" OR ")})`)
      .run(...cards.map((c) => `%"username":"${c.code}"%`));
    json(res, 201, { cards, agent: agent ? agent.name : null });
  });

  // ---- routers: remote reboot ------------------------------------------------
  router.post("/api/reseller/routers/:routerId/reboot", async (req, res, { params }) => {
    const rid = reseller(req, res); if (!rid) return;
    const r = await db.prepare("SELECT router_id FROM routers WHERE router_id = ? AND reseller_id = ?").get(params.routerId, rid);
    if (!r) return json(res, 404, { error: "Router not found" });
    await db.prepare("INSERT INTO router_commands (id,router_id,type,payload,status,created_at) VALUES (?,?,?,?,?,?)")
      .run(id("cmd"), r.router_id, "reboot", "{}", "pending", Date.now());
    json(res, 200, { ok: true, message: "Reboot queued; the router restarts on its next check-in (within 15s)." });
  });
}

export { naira, queueForReseller };
