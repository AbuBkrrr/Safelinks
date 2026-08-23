// Two lightweight recurring sweeps — not a job queue. This system has
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
// it's claimed — no distributed lock needed for work this simple.

import { db, id, ROUTER_OFFLINE_THRESHOLD_MS } from "./db.js";
import { sendEmail } from "./email.js";

/** Routers that were 'online' but haven't checked in within the
 *  threshold get flipped to 'offline' and their reseller gets notified
 *  — once per transition, not once per sweep tick, since a row that's
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
  }
  return goneOffline.length;
}

/** Resellers whose subscription has expired get suspended AND emailed
 *  at their registered address, plus the usual in-app notifications to
 *  both them and Super Admin. Only touches currently-`active` accounts
 *  — a brand-new signup is already `pending` its first payment (not
 *  active yet), so there's nothing to "suspend" there; and an already-
 *  `suspended` account is left alone rather than re-processed forever.
 *  `notified_expiry` still tracks which expiry timestamp was last
 *  handled so renewing and later expiring again correctly re-fires,
 *  without spamming every sweep tick in between. Reinstating a
 *  suspended reseller happens the same way it already did — Super
 *  Admin confirming a license payment (PUT /api/admin/license-payments/:id)
 *  sets status back to 'active'. */
export async function sweepLicenseExpiry() {
  const now = Date.now();
  const newlyExpired = await db.prepare(`
    UPDATE resellers SET status = 'suspended', notified_expiry = subscription_expiry
    WHERE status = 'active' AND subscription_expiry < ?
      AND (notified_expiry IS NULL OR notified_expiry <> subscription_expiry)
    RETURNING id, company_name, email
  `).all(now);

  for (const r of newlyExpired) {
    await db.prepare("INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)")
      .run(id("n"), "super_admin", "alert", "Reseller license expired — account suspended",
        `${r.company_name}'s license expired and the account has been suspended pending renewal confirmation.`, now, 0, "resellers");
    await db.prepare("INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)")
      .run(id("n"), `reseller:${r.id}`, "alert", "Your license has expired — account suspended",
        `Renew from the License tab to reactivate. Vouchers stop being served until then.`, now, 0, "license");
    await sendEmail({
      to: r.email,
      subject: "Your SAFE_Links license has expired",
      text: `Hi ${r.company_name},\n\nYour SAFE_Links license expired and your account has been suspended — vouchers will stop being served to your customers until it's renewed.\n\nLog in and go to the License tab to submit a renewal payment. Once confirmed, your account is reactivated immediately.`,
    });
  }
  return newlyExpired.length;
}

/** Starts both sweeps on their own intervals and returns a stop()
 *  function (useful for tests). Router offline detection matters
 *  quickly (30s check-in window), so it runs often; license expiry is
 *  cheap to check but doesn't need to be — hourly is plenty. */
export function startScheduler({ routerSweepMs = 30_000, licenseSweepMs = 60 * 60_000 } = {}) {
  const routerTimer = setInterval(() => {
    sweepRouterOfflineStatus().catch((err) => console.error("Router offline sweep failed:", err.message));
  }, routerSweepMs);
  const licenseTimer = setInterval(() => {
    sweepLicenseExpiry().catch((err) => console.error("License expiry sweep failed:", err.message));
  }, licenseSweepMs);
  return () => { clearInterval(routerTimer); clearInterval(licenseTimer); };
}
