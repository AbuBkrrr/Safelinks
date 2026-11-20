// Customer-side business logic shared by payments, the portal and jobs:
// pricing (promo codes, happy hour), customer records, issuing/extending
// vouchers, wallet, loyalty and referral rewards, one-tap renew links.
import crypto from "node:crypto";
import { db, id } from "./db.js";
import { planDurationMs } from "./planDuration.js";
import { queueVoucherOnRouters, queueForReseller, userPayload } from "./routerCommands.js";
import { normalizePhone, sendMessage, naira } from "./notify.js";

const TZ_OFFSET_H = Number(process.env.BUSINESS_TZ_OFFSET ?? 1); // Africa/Lagos
export const localHour = (t = Date.now()) => new Date(t + TZ_OFFSET_H * 3600e3).getUTCHours();
export const localDay = (t = Date.now()) => new Date(t + TZ_OFFSET_H * 3600e3).toISOString().slice(0, 10);
const appUrl = () => (process.env.APP_URL || "https://www.safelinks.name.ng").replace(/\/$/, "");
const randCode = (n) => crypto.randomBytes(n).toString("hex").toUpperCase().slice(0, n);

// ---------- pricing -----------------------------------------------------
function happyHourActive(r, t = Date.now()) {
  const s = r?.happy_hour_start, e = r?.happy_hour_end, pct = Number(r?.happy_hour_pct || 0);
  if (s == null || e == null || pct <= 0 || s === e) return false;
  const h = localHour(t);
  return s < e ? h >= s && h < e : h >= s || h < e; // supports 22 -> 2
}

/** Price for this plan right now, with optional promo code. Never throws on a
 *  bad code: returns promoError instead so checkout can show it. */
export async function quote(resellerId, plan, promoCode) {
  const r = await db.prepare("SELECT happy_hour_start, happy_hour_end, happy_hour_pct FROM resellers WHERE id = ?").get(resellerId);
  let price = Number(plan.price), discount = 0, notes = [];
  if (happyHourActive(r)) {
    const d = Math.round(price * Number(r.happy_hour_pct)) / 100;
    discount += d; notes.push(`Happy hour -${r.happy_hour_pct}%`);
  }
  let promo = null, promoError = null;
  if (promoCode) {
    promo = await db.prepare("SELECT * FROM promo_codes WHERE reseller_id = ? AND UPPER(code) = UPPER(?) AND active = 1").get(resellerId, String(promoCode).trim());
    if (!promo) promoError = "Promo code not found";
    else if (promo.expires_at && Number(promo.expires_at) < Date.now()) { promoError = "Promo code expired"; promo = null; }
    else if (promo.max_uses > 0 && promo.uses >= promo.max_uses) { promoError = "Promo code fully used"; promo = null; }
    if (promo) {
      const base = price - discount;
      const d = Number(promo.amount_off) > 0 ? Number(promo.amount_off) : Math.round(base * Number(promo.percent_off)) / 100;
      discount += Math.min(base, d); notes.push(`Code ${promo.code}`);
    }
  }
  const total = Math.max(0, Math.round((price - discount) * 100) / 100);
  return { price, discount: Math.round(discount * 100) / 100, total, notes, promo, promoError };
}

// ---------- customers ---------------------------------------------------
export async function upsertCustomer(resellerId, { phone, name, email, referralCode } = {}) {
  const p = normalizePhone(phone);
  if (!p) return null;
  let c = await db.prepare("SELECT * FROM customers WHERE reseller_id = ? AND phone = ?").get(resellerId, p);
  if (!c) {
    let referredBy = null;
    if (referralCode) {
      const ref = await db.prepare("SELECT id FROM customers WHERE reseller_id = ? AND referral_code = ?").get(resellerId, String(referralCode).trim().toUpperCase());
      if (ref) referredBy = ref.id;
    }
    const cid = id("cu");
    await db.prepare(`INSERT INTO customers (id,reseller_id,phone,name,email,referral_code,referred_by,created_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (reseller_id, phone) DO NOTHING`)
      .run(cid, resellerId, p, name || null, email || null, randCode(6), referredBy, Date.now());
    c = await db.prepare("SELECT * FROM customers WHERE reseller_id = ? AND phone = ?").get(resellerId, p);
  } else if ((name && !c.name) || (email && !c.email)) {
    await db.prepare("UPDATE customers SET name = COALESCE(name, ?), email = COALESCE(email, ?) WHERE id = ?").run(name || null, email || null, c.id);
  }
  return c;
}

// ---------- vouchers ----------------------------------------------------
/** Create a voucher + router logins. durationMs overrides the plan length
 *  (trials, referral rewards). Returns the voucher row. */
export async function issueVoucher({ resellerId, plan, customer = null, clientMac = null, source = "paid", durationMs = null, agentId = null, name = null, email = null, phone = null }) {
  const now = Date.now();
  const v = {
    id: id("v"), reseller_id: resellerId,
    username: `U${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
    password: crypto.randomBytes(6).toString("base64url"),
    plan_id: plan?.id || null, created_at: now,
    expires_at: now + (durationMs || planDurationMs(plan)),
  };
  await db.prepare(`INSERT INTO vouchers (id,reseller_id,username,password,name,email,phone,plan_id,status,created_at,expires_at,client_mac,customer_id,source,agent_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    v.id, resellerId, v.username, v.password, name || customer?.name || null, email || customer?.email || null,
    phone || customer?.phone || null, v.plan_id, "active", now, v.expires_at, clientMac ? String(clientMac).toUpperCase() : null,
    customer?.id || null, source, agentId);
  await queueVoucherOnRouters(v, plan);
  return v;
}

/** Extend an existing login (renewal): same username, no re-login needed. */
export async function extendVoucher(voucher, plan) {
  const base = Math.max(Date.now(), Number(voucher.expires_at || 0));
  const expires = base + planDurationMs(plan);
  await db.prepare("UPDATE vouchers SET expires_at = ?, status = 'active', reminded_at = NULL WHERE id = ?").run(expires, voucher.id);
  const v = { ...voucher, expires_at: expires };
  // extend_user keeps a live session up; create_user covers a router that
  // lost the user (e.g. reset) since the last purchase.
  await queueForReseller(voucher.reseller_id, "extend_user", userPayload(v, plan));
  return v;
}

// ---------- wallet ------------------------------------------------------
export async function walletCredit(customerId, amount, kind, ref = null) {
  await db.prepare("UPDATE customers SET wallet_balance = wallet_balance + ? WHERE id = ?").run(amount, customerId);
  await db.prepare("INSERT INTO wallet_tx (id,customer_id,amount,kind,ref,created_at) VALUES (?,?,?,?,?,?)").run(id("wt"), customerId, amount, kind, ref, Date.now());
}

/** Atomic debit; false when the balance is too low. */
export async function walletDebit(customerId, amount, kind, ref = null) {
  const r = await db.prepare("UPDATE customers SET wallet_balance = wallet_balance - ? WHERE id = ? AND wallet_balance >= ?").run(amount, customerId, amount);
  if (r.changes !== 1) return false;
  await db.prepare("INSERT INTO wallet_tx (id,customer_id,amount,kind,ref,created_at) VALUES (?,?,?,?,?,?)").run(id("wt"), customerId, -amount, kind, ref, Date.now());
  return true;
}

// ---------- after every paid purchase -----------------------------------
/** Loyalty (every Nth purchase refunded to wallet) and referral (referrer
 *  gets a free-hour login by SMS on the friend's first purchase). */
export async function afterPaidPurchase(resellerId, customer, amountPaid, plan) {
  if (!customer) return;
  await db.prepare("UPDATE customers SET paid_count = paid_count + 1, total_spent = total_spent + ?, last_purchase_at = ? WHERE id = ?")
    .run(Number(amountPaid || 0), Date.now(), customer.id);
  const c = await db.prepare("SELECT * FROM customers WHERE id = ?").get(customer.id);
  const r = await db.prepare("SELECT company_name, loyalty_every, referral_reward_minutes FROM resellers WHERE id = ?").get(resellerId);
  const every = Number(r?.loyalty_every || 0);
  if (every > 0 && c.paid_count % every === 0 && Number(amountPaid) > 0) {
    await walletCredit(c.id, Number(amountPaid), "loyalty", `purchase#${c.paid_count}`);
    await sendMessage({ resellerId, to: c.phone, kind: "loyalty",
      body: `${r.company_name}: thank you! Purchase #${c.paid_count} is on us - ${naira(amountPaid)} added to your WiFi wallet.` });
  }
  if (c.paid_count === 1 && c.referred_by && Number(r?.referral_reward_minutes) > 0) {
    const referrer = await db.prepare("SELECT * FROM customers WHERE id = ?").get(c.referred_by);
    if (referrer) {
      const v = await issueVoucher({ resellerId, plan, customer: referrer, source: "referral", durationMs: Number(r.referral_reward_minutes) * 60_000 });
      await sendMessage({ resellerId, to: referrer.phone, kind: "referral",
        body: `${r.company_name}: your friend just joined! Free ${r.referral_reward_minutes} min WiFi. Code: ${v.username} Password: ${v.password}` });
    }
  }
}

// ---------- one-tap renew links ------------------------------------------
export async function createRenewLink(voucher) {
  const token = crypto.randomBytes(9).toString("base64url");
  await db.prepare("INSERT INTO renew_links (token,reseller_id,customer_id,voucher_id,plan_id,created_at,expires_at) VALUES (?,?,?,?,?,?,?)")
    .run(token, voucher.reseller_id, voucher.customer_id || null, voucher.id, voucher.plan_id, Date.now(), Date.now() + 7 * 86400e3);
  return `${appUrl()}/r/${token}`;
}
