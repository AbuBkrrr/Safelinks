// Real email sending — but optional, with a safe fallback baked in.
//
// This is a genuine change of direction from the rest of the system
// ("no automated sending anywhere, by design" is stated repeatedly
// elsewhere in this codebase and its docs) — made deliberately, because
// two flows actually need it: password reset can't be secure without
// an out-of-band channel, and license-expiry needs to reach a reseller
// who might not be checking the dashboard. Everything else in the
// system (voucher delivery, contact info) is still 100% manual.
//
// If SMTP_HOST isn't set, sendEmail() doesn't fail — it falls back to
// creating a Super Admin notification containing the full message, so
// a human can send it by hand, same pattern as the rest of the system.
// That means this backend works out of the box with zero mail
// configuration; SMTP is an upgrade, not a requirement.
//
// Dependency: nodemailer (add to package.json — not installed in the
// sandbox this was built in; see README "Email sending" section for
// why that couldn't be verified end-to-end here).

import { db, id } from "./db.js";

let transporter = null;
function getTransporter() {
  if (transporter !== null) return transporter; // cached, including the "false" (unconfigured) case
  if (!process.env.SMTP_HOST) {
    transporter = false;
    return transporter;
  }
  // Lazy import so a deployment that never configures SMTP never even
  // needs `nodemailer` installed.
  return import("nodemailer").then((nodemailer) => {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
    return transporter;
  });
}

/** Sends an email if SMTP is configured; otherwise files a Super Admin
 *  notification with the full content so it can be sent by hand. Never
 *  throws — a misconfigured or down mail server should degrade to the
 *  manual fallback, not break the flow that was trying to notify someone. */
export async function sendEmail({ to, subject, text }) {
  try {
    const t = await getTransporter();
    if (t) {
      await t.sendMail({ from: process.env.SMTP_FROM || "SAFE_Links <aibrainsventures@gmail.com>", to, subject, text });
      return { sent: true, method: "smtp" };
    }
  } catch (err) {
    console.error(`sendEmail: SMTP send failed (falling back to manual notification): ${err.message}`);
  }

  // Manual fallback — same shape as every other "someone needs to act
  // on this by hand" notification in the system.
  await db.prepare("INSERT INTO notifications (id,scope,type,title,message,time,read) VALUES (?,?,?,?,?,?,?)")
    .run(id("n"), "super_admin", "alert", `Email needs to be sent manually: ${subject}`,
      `To: ${to}\n\n${text}`, Date.now(), 0);
  return { sent: false, method: "manual_fallback" };
}
