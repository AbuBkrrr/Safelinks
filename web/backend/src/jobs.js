// Two lightweight recurring sweeps â€” not a job queue. This system has
// no external side effects to retry with backoff (no payment gateway,
// no automated email/WhatsApp sending), so a real queue library
// (BullMQ/pg-boss + Redis) would be infrastructure for a workload that
// doesn't exist here. What it actually needs is periodic housekeeping
// that currently only happens reactively when someone loads a
// dashboard: routers should be marked offline (and someone told) even
// if nobody's looking, and an expired license should raise a
// notification without waiting for the reseller to open their license tab.
//
// Both sweeps are single UPDATE...RETURNING statements, so they stay
// correct even with multiple backend instances running behind a load
// balancer (see README "Single-process, but horizontally scalable
// now"): only one instance's UPDATE can actually claim a given row in
// any one tick, because the WHERE clause stops matching it the instant
// it's claimed â€” no distributed lock needed for work this simple.

import { db, id, ROUTER_OFFLINE_THRESHOLD_MS } from "./db.js";
import { sendEmail } from "./email.js";
import { sendMessage, naira } from "./notify.js";
import { quote, extendVoucher, walletDebit, afterPaidPurchase, createRenewLink, localHour, localDay } from "./growth.js";

/** Routers that were 'online' but haven't checked in within the
 *  threshold get flipped to 'offline' and their reseller gets notified
 *  â€” once per transition, not once per sweep tick, since a row that's
 *  already 'offline' no longer matches the WHERE clause. */
export async function sweepRouterOfflineStatus() {
  const cutoff = Date.now() - ROUTER_OFFLINE_THRESHOLD_MS;
  const goneOffline = await db.prepare(`
    UPDATE routers SET status = 'offline'
    WHERE status = 'online' AND (last_check_in IS NULL OR last_check_in < ?)
    RETURNING id, reseller_id, router_id
  `).all(cutoff);

  for (const rt of goneOffline) {
    await db.prepare("INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)")
      .run(id("n"), `reseller:${rt.reseller_id}`, "alert", "Router went offline",
        `${rt.router_id} missed its check-in window and is now showing offline.`, Date.now(), 0, "routers");
    // WhatsApp/SMS the owner: an offline router is lost sales.
    const r = await db.prepare("SELECT company_name, notify_phone FROM resellers WHERE id = ?").get(rt.reseller_id);
    if (r?.notify_phone) {
      await sendMessage({ resellerId: rt.reseller_id, to: r.notify_phone, kind: "router-down",
        body: `SAFE_Links alert: router ${rt.router_id} (${r.company_name}) went OFFLINE. Check its power and internet, or reboot it from your dashboard.` });
      await db.prepare("UPDATE routers SET alerted_offline_at = ? WHERE id = ?").run(Date.now(), rt.id);
    }
  }
  return goneOffline.length;
}

/** Resellers whose subscription has expired get suspended AND emailed
 *  at their registered address, plus the usual in-app notifications to
 *  both them and Super Admin. Only touches currently-`active` accounts
 *  â€” a brand-new signup is already `pending` its first payment (not
 *  active yet), so there's nothing to "suspend" there; and an already-
 *  `suspended` account is left alone rather than re-processed forever.
 *  `notified_expiry` still tracks which expiry timestamp was last
 *  handled so renewing and later expiring again correctly re-fires,
 *  without spamming every sweep tick in between. Reinstating a
 *  suspended reseller happens the same way it already did â€” Super
 *  Admin confirming a license payment (PUT /api/admin/license-payments/:id)
 *  sets status back to 'active'. */
export async function sweepLicenseExpiry() {
  const now = Date.now();
  const newlyExpired = await db.prepare(`
    UPDATE resellers SET status = 'suspended', notified_expiry = subscription_expiry
    WHERE status IN ('active', 'pending') AND subscription_expiry < ?
      AND (notified_expiry IS NULL OR notified_expiry <> subscription_expiry)
    RETURNING id, company_name, email
  `).all(now);

  for (const r of newlyExpired) {
    await db.prepare("INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)")
      .run(id("n"), "super_admin", "alert", "Reseller license expired â€” account suspended",
        `${r.company_name}'s license expired and the account has been suspended pending renewal confirmation.`, now, 0, "resellers");
    await db.prepare("INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)")
      .run(id("n"), `reseller:${r.id}`, "alert", "Your license has expired â€” account suspended",
        `Renew from the License tab to reactivate. Vouchers stop being served until then.`, now, 0, "license");
    await sendEmail({
      to: r.email,
      subject: "Your SAFE_Links license has expired",
      text: `Hi ${r.company_name},\n\nYour SAFE_Links license expired and your account has been suspended â€” vouchers will stop being served to your customers until it's renewed.\n\nLog in and go to the License tab to submit a renewal payment. Once confirmed, your account is reactivated immediately.`,
    });
  }
  return newlyExpired.length;
}

/** Customer vouchers past expires_at: mark expired and queue router
 *  commands that cut the device off (remove its MAC bypass + any hotspot
 *  login, disable the hotspot user). The device then falls back to the
 *  hotspot login page, which redirects to the reseller's portal where the
 *  customer can buy again. Runs here (not in a router-facing route) so it
 *  fires whichever check-in path the routers use. */
export async function sweepVoucherExpiry() {
  const now = Date.now();
  const expired = await db.prepare(
    "SELECT id, username, reseller_id, client_mac FROM vouchers WHERE status = 'active' AND expires_at < ?"
  ).all(now);
  if (expired.length === 0) return 0;
  await db.prepare("UPDATE vouchers SET status = 'expired' WHERE status = 'active' AND expires_at < ?").run(now);
  for (const v of expired) {
    const mac = v.client_mac || (/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(v.username || "") ? v.username : null);
    const routers = await db.prepare("SELECT router_id FROM routers WHERE reseller_id = ?").all(v.reseller_id);
    for (const r of routers) {
      const q = (type, payload) => db.prepare(
        "INSERT INTO router_commands (id, router_id, type, payload, status, created_at) VALUES (?,?,?,?,?,?)"
      ).run(id("cmd"), r.router_id, type, JSON.stringify(payload), "pending", now);
      if (mac) await q("unbind_mac", { username: mac });
      await q("disable_user", { username: v.username });
    }
  }
  console.log(`[voucher-expiry] expired ${expired.length} voucher(s)`);
  return expired.length;
}

/** 1 hour before a paid login expires: SMS/WhatsApp with a one-tap renew link. */
export async function sweepExpiryReminders() {
  const now = Date.now();
  const due = await db.prepare(`SELECT v.*, r.company_name FROM vouchers v JOIN resellers r ON r.id = v.reseller_id
    WHERE v.status = 'active' AND v.reminded_at IS NULL AND v.expires_at > ? AND v.expires_at <= ?
      AND COALESCE(v.source,'paid') NOT IN ('trial','referral') AND v.phone IS NOT NULL`).all(now, now + 60 * 60000);
  for (const v of due) {
    const claim = await db.prepare("UPDATE vouchers SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL").run(now, v.id);
    if (claim.changes !== 1) continue;
    const c = v.customer_id ? await db.prepare("SELECT auto_renew, opted_out FROM customers WHERE id = ?").get(v.customer_id) : null;
    if (c?.opted_out || c?.auto_renew) continue; // auto-renew customers are handled below
    const link = await createRenewLink(v);
    const mins = Math.max(1, Math.round((Number(v.expires_at) - now) / 60000));
    await sendMessage({ resellerId: v.reseller_id, to: v.phone, kind: "expiry-reminder",
      body: `${v.company_name}: your WiFi ends in ${mins} min. Renew in one tap: ${link}` });
  }
  return due.length;
}

/** Wallet auto-renew: 2 minutes before expiry, extend the same login (the
 *  customer stays connected) if the wallet covers the chosen plan. */
export async function sweepAutoRenew() {
  const now = Date.now();
  const due = await db.prepare(`SELECT v.*, c.auto_renew_plan_id, c.wallet_balance, c.phone AS cphone, c.name AS cname FROM vouchers v
    JOIN customers c ON c.id = v.customer_id
    WHERE v.status = 'active' AND c.auto_renew = 1 AND v.expires_at > ? AND v.expires_at <= ?`).all(now, now + 2 * 60000);
  for (const v of due) {
    const plan = await db.prepare("SELECT * FROM plans WHERE id = ? AND reseller_id = ?").get(v.auto_renew_plan_id || v.plan_id, v.reseller_id);
    if (!plan) continue;
    const r = await db.prepare("SELECT company_name FROM resellers WHERE id = ?").get(v.reseller_id);
    const { total } = await quote(v.reseller_id, plan, null);
    const ref = `AUTO-${v.id}-${v.expires_at}`;
    const already = await db.prepare("SELECT 1 FROM wallet_tx WHERE ref = ?").get(ref);
    if (already) continue;
    if (await walletDebit(v.customer_id, total, "auto-renew", ref)) {
      const nv = await extendVoucher(v, plan);
      await db.prepare(`INSERT INTO payments (id,user_type,user_id,reseller_id,amount,method,status,reference,currency,customer_name,customer_phone,plan_id,time,voucher_id,customer_id,purpose_kind)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id("p"), "end_user", v.reseller_id, v.reseller_id, total, "wallet", "paid", ref, "NGN", v.cname, v.cphone, plan.id, now, v.id, v.customer_id, "voucher");
      const c = await db.prepare("SELECT * FROM customers WHERE id = ?").get(v.customer_id);
      await afterPaidPurchase(v.reseller_id, c, total, plan);
      await sendMessage({ resellerId: v.reseller_id, to: v.cphone, kind: "auto-renew",
        body: `${r.company_name}: ${plan.name} renewed from your wallet (${naira(total)}). Wallet: ${naira(c.wallet_balance)}. Active until ${new Date(Number(nv.expires_at)).toLocaleString("en-NG", { timeZone: process.env.BUSINESS_TZ || "Africa/Lagos", dateStyle: "medium", timeStyle: "short" })}.` });
    } else {
      const flag = `LOW-${v.id}-${v.expires_at}`;
      if (!(await db.prepare("SELECT 1 FROM wallet_tx WHERE ref = ?").get(flag))) {
        await db.prepare("INSERT INTO wallet_tx (id,customer_id,amount,kind,ref,created_at) VALUES (?,?,?,?,?,?)").run(id("wt"), v.customer_id, 0, "auto-renew-failed", flag, now);
        const link = await createRenewLink(v);
        await sendMessage({ resellerId: v.reseller_id, to: v.cphone, kind: "auto-renew",
          body: `${r.company_name}: auto-renew needs ${naira(total)} but your wallet has ${naira(v.wallet_balance)}. Renew here: ${link}` });
      }
    }
  }
  return due.length;
}

/** Evening earnings summary to the reseller's phone (once per day). */
export async function sweepDailySummary() {
  const hour = Number(process.env.DAILY_SUMMARY_HOUR ?? 21);
  if (localHour() < hour) return 0;
  const today = localDay();
  const rows = await db.prepare("SELECT id, company_name, notify_phone FROM resellers WHERE daily_summary = 1 AND notify_phone IS NOT NULL AND (last_summary_day IS NULL OR last_summary_day <> ?)").all(today);
  const { earnings } = await import("./routes/growth.js");
  const startOfDay = Date.parse(today + "T00:00:00Z") - Number(process.env.BUSINESS_TZ_OFFSET ?? 1) * 3600e3;
  for (const r of rows) {
    const claim = await db.prepare("UPDATE resellers SET last_summary_day = ? WHERE id = ? AND (last_summary_day IS NULL OR last_summary_day <> ?)").run(today, r.id, today);
    if (claim.changes !== 1) continue;
    const e = await earnings(r.id, startOfDay);
    const best = e.byPlan[0] ? `, best plan: ${e.byPlan[0].plan}` : "";
    const online = await db.prepare("SELECT COUNT(*) AS n FROM routers WHERE reseller_id = ? AND status = 'online'").get(r.id);
    await sendMessage({ resellerId: r.id, to: r.notify_phone, kind: "daily-summary",
      body: `${r.company_name} today: ${naira(e.total)} from ${e.sales} sale${e.sales === 1 ? "" : "s"}${best}. Routers online: ${online.n}.` });
  }
  return rows.length;
}

/** Starts both sweeps on their own intervals and returns a stop()
 *  function (useful for tests). Router offline detection matters
 *  quickly (30s check-in window), so it runs often; license expiry is
 *  cheap to check but doesn't need to be â€” hourly is plenty. */
export function startScheduler({ routerSweepMs = 30_000, licenseSweepMs = 60 * 60_000 } = {}) {
  const routerTimer = setInterval(() => {
    sweepRouterOfflineStatus().catch((err) => console.error("Router offline sweep failed:", err.message));
  }, routerSweepMs);
  const licenseTimer = setInterval(() => {
    sweepLicenseExpiry().catch((err) => console.error("License expiry sweep failed:", err.message));
  }, licenseSweepMs);
  const voucherTimer = setInterval(() => {
    sweepVoucherExpiry().catch((err) => console.error("Voucher expiry sweep failed:", err.message));
  }, routerSweepMs);
  const growthTimer = setInterval(() => {
    sweepAutoRenew().catch((err) => console.error("Auto-renew sweep failed:", err.message));
    sweepExpiryReminders().catch((err) => console.error("Reminder sweep failed:", err.message));
    sweepDailySummary().catch((err) => console.error("Daily summary failed:", err.message));
  }, 60_000);
  return () => { clearInterval(routerTimer); clearInterval(licenseTimer); clearInterval(voucherTimer); clearInterval(growthTimer); };
}
