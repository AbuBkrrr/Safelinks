// End-customer features on the captive portal:
//   free trial, phone sign-in (OTP), wallet + auto-renew, usage bar,
//   one-tap renew links, referral code.
import crypto from "node:crypto";
import { db, id } from "../db.js";
import { json } from "../http.js";
import { rateLimitByIp } from "../rateLimit.js";
import { signToken, verifyToken } from "../auth.js";
import { normalizePhone, sendMessage, providerConfigured, naira } from "../notify.js";
import { upsertCustomer, issueVoucher, extendVoucher, walletDebit, afterPaidPurchase, quote } from "../growth.js";
import { planDurationMs } from "../planDuration.js";

const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

function customerAuth(req, resellerId) {
  const h = req.headers["authorization"] || "";
  const p = verifyToken(h.startsWith("Bearer ") ? h.slice(7) : null);
  if (!p || p.role !== "customer" || p.rid !== resellerId) return null;
  return p;
}

async function activeVoucherFor(resellerId, { mac, customerId }) {
  if (customerId) {
    const v = await db.prepare("SELECT * FROM vouchers WHERE reseller_id = ? AND customer_id = ? AND status = 'active' AND expires_at > ? ORDER BY expires_at DESC LIMIT 1").get(resellerId, customerId, Date.now());
    if (v) return v;
  }
  if (mac) {
    const v = await db.prepare("SELECT * FROM vouchers WHERE reseller_id = ? AND UPPER(client_mac) = UPPER(?) AND status = 'active' AND expires_at > ? ORDER BY expires_at DESC LIMIT 1").get(resellerId, mac, Date.now());
    if (v) return v;
    const s = await db.prepare("SELECT username FROM active_sessions WHERE reseller_id = ? AND UPPER(mac) = UPPER(?) ORDER BY last_seen DESC LIMIT 1").get(resellerId, mac);
    if (s?.username) return db.prepare("SELECT * FROM vouchers WHERE reseller_id = ? AND username = ? AND status = 'active'").get(resellerId, s.username);
  }
  return null;
}

async function usageOf(v) {
  if (!v) return null;
  const plan = v.plan_id ? await db.prepare("SELECT name, data_mb, bandwidth, device_limit FROM plans WHERE id = ?").get(v.plan_id) : null;
  return {
    username: v.username, plan: v.source === "trial" ? "Free trial" : v.source === "referral" ? "Referral reward" : plan?.name || "WiFi",
    startedAt: Number(v.created_at), expiresAt: Number(v.expires_at), now: Date.now(),
    bytesUsed: Number(v.bytes_used || 0), dataLimitMb: Number(plan?.data_mb || 0),
    speedMbps: plan?.bandwidth || null, devices: plan?.device_limit || 1, voucherId: v.id, planId: v.plan_id,
  };
}

export function registerCustomerRoutes(router) {
  // ---- usage bar: time + data remaining for this device ---------------
  router.get("/api/portal/:resellerId/usage", async (req, res, { params, query }) => {
    const v = await activeVoucherFor(params.resellerId, { mac: query.mac });
    json(res, 200, { active: !!v, usage: await usageOf(v) });
  });

  // ---- free trial -------------------------------------------------------
  // One per phone number and per device per 24h. The phone becomes a lead
  // in the reseller's customer list.
  router.post("/api/portal/:resellerId/trial", async (req, res, { params, body }) => {
    if (await rateLimitByIp(req, res, "portal-trial", { max: 5, windowMs: 60 * 60000 })) return;
    const rid = params.resellerId;
    const r = await db.prepare("SELECT company_name, trial_enabled, trial_minutes FROM resellers WHERE id = ?").get(rid);
    if (!r) return json(res, 404, { error: "Not found" });
    if (!Number(r.trial_enabled) || !(Number(r.trial_minutes) > 0)) return json(res, 400, { error: "Free trial is not available here" });
    const phone = normalizePhone(body?.phone);
    if (!phone) return json(res, 400, { error: "Enter a valid phone number" });
    const mac = body?.clientMac ? String(body.clientMac).toUpperCase() : null;
    const dayAgo = Date.now() - 86400e3;
    const c = await upsertCustomer(rid, { phone, name: body?.name, referralCode: body?.referralCode });
    if (c.trial_used_at && Number(c.trial_used_at) > dayAgo) return json(res, 409, { error: "You've already used today's free trial. Pick a plan to keep browsing." });
    if (mac) {
      const used = await db.prepare("SELECT 1 FROM vouchers WHERE reseller_id = ? AND source = 'trial' AND UPPER(client_mac) = ? AND created_at > ?").get(rid, mac, dayAgo);
      if (used) return json(res, 409, { error: "This device already used today's free trial." });
    }
    const claimed = await db.prepare("UPDATE customers SET trial_used_at = ? WHERE id = ? AND (trial_used_at IS NULL OR trial_used_at < ?)").run(Date.now(), c.id, dayAgo);
    if (claimed.changes !== 1) return json(res, 409, { error: "Free trial already used" });
    const cheapest = await db.prepare("SELECT * FROM plans WHERE reseller_id = ? ORDER BY price ASC LIMIT 1").get(rid);
    const trialPlan = { ...(cheapest || {}), id: cheapest?.id, device_limit: 1, bandwidth: Math.min(Number(cheapest?.bandwidth || 2), 2), data_mb: 0 };
    if (!cheapest) return json(res, 400, { error: "No plans configured yet" });
    let v;
    try {
      v = await issueVoucher({ resellerId: rid, plan: trialPlan, customer: c, clientMac: mac, source: "trial", durationMs: Number(r.trial_minutes) * 60_000 });
    } catch (e) {
      await db.prepare("UPDATE customers SET trial_used_at = NULL WHERE id = ?").run(c.id); // don't burn the trial on our error
      throw e;
    }
    json(res, 200, { ok: true, minutes: Number(r.trial_minutes), voucher: { username: v.username, password: v.password, expires_at: v.expires_at } });
  });

  // ---- phone sign-in (OTP) ---------------------------------------------
  router.post("/api/portal/:resellerId/otp", async (req, res, { params, body }) => {
    if (await rateLimitByIp(req, res, "portal-otp", { max: 8, windowMs: 15 * 60000 })) return;
    const phone = normalizePhone(body?.phone);
    if (!phone) return json(res, 400, { error: "Enter a valid phone number" });
    const r = await db.prepare("SELECT company_name FROM resellers WHERE id = ?").get(params.resellerId);
    if (!r) return json(res, 404, { error: "Not found" });
    const code = String(crypto.randomInt(100000, 1000000));
    await db.prepare("DELETE FROM otp_codes WHERE reseller_id = ? AND phone = ?").run(params.resellerId, phone);
    await db.prepare("INSERT INTO otp_codes (id,reseller_id,phone,code_hash,expires_at) VALUES (?,?,?,?,?)")
      .run(id("otp"), params.resellerId, phone, hash(code), Date.now() + 10 * 60000);
    await sendMessage({ resellerId: params.resellerId, to: phone, kind: "otp", body: `${r.company_name} WiFi code: ${code}. Valid 10 minutes.` });
    // Only for local development without an SMS provider.
    const dev = !providerConfigured() && process.env.NODE_ENV !== "production";
    json(res, 200, { ok: true, ...(dev ? { devCode: code } : {}) });
  });

  router.post("/api/portal/:resellerId/otp/verify", async (req, res, { params, body }) => {
    if (await rateLimitByIp(req, res, "portal-otp-verify", { max: 20, windowMs: 15 * 60000 })) return;
    const phone = normalizePhone(body?.phone);
    const row = phone ? await db.prepare("SELECT * FROM otp_codes WHERE reseller_id = ? AND phone = ?").get(params.resellerId, phone) : null;
    if (!row || Number(row.expires_at) < Date.now() || row.attempts >= 5) return json(res, 400, { error: "Code expired. Request a new one." });
    if (row.code_hash !== hash(String(body?.code || "").trim())) {
      await db.prepare("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?").run(row.id);
      return json(res, 400, { error: "Wrong code" });
    }
    await db.prepare("DELETE FROM otp_codes WHERE id = ?").run(row.id);
    const c = await upsertCustomer(params.resellerId, { phone, name: body?.name, referralCode: body?.referralCode });
    json(res, 200, { token: signToken({ role: "customer", rid: params.resellerId, cid: c.id, sub: c.id }) });
  });

  // ---- my account ---------------------------------------------------------
  router.get("/api/portal/:resellerId/me", async (req, res, { params, query }) => {
    const a = customerAuth(req, params.resellerId);
    if (!a) return json(res, 401, { error: "Sign in" });
    const c = await db.prepare("SELECT * FROM customers WHERE id = ?").get(a.cid);
    const v = await activeVoucherFor(params.resellerId, { mac: query.mac, customerId: c.id });
    const tx = await db.prepare("SELECT amount, kind, created_at FROM wallet_tx WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10").all(c.id);
    const r = await db.prepare("SELECT loyalty_every, referral_reward_minutes FROM resellers WHERE id = ?").get(params.resellerId);
    json(res, 200, {
      phone: c.phone, name: c.name, wallet: Number(c.wallet_balance), autoRenew: !!c.auto_renew, autoRenewPlanId: c.auto_renew_plan_id,
      referralCode: c.referral_code, paidCount: c.paid_count, marketing: !c.opted_out, loyaltyEvery: Number(r?.loyalty_every || 0),
      referralRewardMinutes: Number(r?.referral_reward_minutes || 0), usage: await usageOf(v), walletTx: tx,
    });
  });

  router.post("/api/portal/:resellerId/me/auto-renew", async (req, res, { params, body }) => {
    const a = customerAuth(req, params.resellerId);
    if (!a) return json(res, 401, { error: "Sign in" });
    const on = !!body?.on;
    if (on) {
      const plan = await db.prepare("SELECT id FROM plans WHERE id = ? AND reseller_id = ?").get(body?.planId, params.resellerId);
      if (!plan) return json(res, 400, { error: "Choose the plan to renew" });
    }
    await db.prepare("UPDATE customers SET auto_renew = ?, auto_renew_plan_id = ? WHERE id = ?").run(on ? 1 : 0, on ? body.planId : null, a.cid);
    json(res, 200, { ok: true, autoRenew: on });
  });

  // Promotional messages on/off (service messages like OTP still go out).
  router.post("/api/portal/:resellerId/me/marketing", async (req, res, { params, body }) => {
    const a = customerAuth(req, params.resellerId);
    if (!a) return json(res, 401, { error: "Sign in" });
    await db.prepare("UPDATE customers SET opted_out = ? WHERE id = ?").run(body?.on ? 0 : 1, a.cid);
    json(res, 200, { ok: true, marketing: !!body?.on });
  });

  // Buy (or extend the current login) with wallet balance.
  router.post("/api/portal/:resellerId/me/buy", async (req, res, { params, body }) => {
    const a = customerAuth(req, params.resellerId);
    if (!a) return json(res, 401, { error: "Sign in" });
    const rid = params.resellerId;
    const plan = await db.prepare("SELECT * FROM plans WHERE id = ? AND reseller_id = ?").get(body?.planId, rid);
    if (!plan) return json(res, 404, { error: "Plan not found" });
    const q = await quote(rid, plan, body?.promoCode);
    if (q.promoError) return json(res, 400, { error: q.promoError });
    const ref = "WBUY-" + Date.now().toString(36);
    if (!(await walletDebit(a.cid, q.total, "purchase", ref))) return json(res, 402, { error: "Not enough wallet balance" });
    const c = await db.prepare("SELECT * FROM customers WHERE id = ?").get(a.cid);
    const current = await activeVoucherFor(rid, { mac: body?.clientMac, customerId: c.id });
    const v = current && current.plan_id === plan.id ? await extendVoucher(current, plan)
      : await issueVoucher({ resellerId: rid, plan, customer: c, clientMac: body?.clientMac, source: "wallet" });
    if (q.promo) await db.prepare("UPDATE promo_codes SET uses = uses + 1 WHERE id = ?").run(q.promo.id);
    await db.prepare(`INSERT INTO payments (id,user_type,user_id,reseller_id,amount,method,status,reference,currency,customer_name,customer_phone,plan_id,time,voucher_id,customer_id,purpose_kind,promo_code,discount)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id("p"), "end_user", rid, rid, q.total, "wallet", "paid", ref, "NGN", c.name, c.phone, plan.id, Date.now(), v.id, c.id, "voucher", q.promo?.code || null, q.discount);
    await afterPaidPurchase(rid, c, q.total, plan);
    json(res, 200, { ok: true, voucher: { username: v.username, password: v.password, expires_at: v.expires_at } });
  });

  // ---- one-tap renew link (/r/<token> on the site) -------------------------
  router.get("/api/renew/:token", async (req, res, { params }) => {
    const l = await db.prepare("SELECT * FROM renew_links WHERE token = ? AND expires_at > ?").get(params.token, Date.now());
    if (!l) return json(res, 404, { error: "This renew link has expired" });
    const v = await db.prepare("SELECT username, expires_at FROM vouchers WHERE id = ?").get(l.voucher_id);
    const c = l.customer_id ? await db.prepare("SELECT phone, name FROM customers WHERE id = ?").get(l.customer_id) : null;
    json(res, 200, { resellerId: l.reseller_id, planId: l.plan_id, token: l.token, phone: c?.phone || null, name: c?.name || null, username: v?.username || null, expiresAt: v ? Number(v.expires_at) : null });
  });
}

export { activeVoucherFor, usageOf, naira, planDurationMs };
