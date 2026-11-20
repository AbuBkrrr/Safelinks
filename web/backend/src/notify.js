// SMS / WhatsApp to resellers and customers.
// Provider: Termii (Nigeria; SMS + WhatsApp) when TERMII_API_KEY is set.
//   TERMII_API_KEY, TERMII_SENDER_ID (default "SafeLinks"),
//   TERMII_CHANNEL: "generic" | "dnd" | "whatsapp" (default "generic")
// Every message is recorded in `messages` (the reseller's outbox) whether or
// not a provider is configured, so nothing is lost and the dashboard can
// show what was sent.
import { db, id } from "./db.js";

const TERMII_URL = "https://api.ng.termii.com/api/sms/send";

// Nigerian numbers to E.164 without "+": 08031234567 -> 2348031234567.
export function normalizePhone(raw) {
  let p = String(raw || "").replace(/[^\d+]/g, "");
  if (p.startsWith("+")) p = p.slice(1);
  if (/^0\d{10}$/.test(p)) p = "234" + p.slice(1);
  if (/^[789]\d{9}$/.test(p)) p = "234" + p;
  return /^\d{10,15}$/.test(p) ? p : null;
}

export function providerConfigured() {
  return Boolean(process.env.TERMII_API_KEY);
}

async function sendViaTermii(to, body, channel) {
  const r = await fetch(TERMII_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: process.env.TERMII_API_KEY,
      to, from: process.env.TERMII_SENDER_ID || "SafeLinks",
      sms: body, type: "plain", channel,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.code && j.code !== "ok")) throw new Error(j.message || `HTTP ${r.status}`);
  return j.message_id || "sent";
}

/** Send one message. Never throws: failures are recorded and returned. */
export async function sendMessage({ resellerId = null, to, body, kind = "info" }) {
  const phone = normalizePhone(to);
  const channel = process.env.TERMII_CHANNEL || "generic";
  const row = { id: id("msg"), status: "queued", error: null };
  if (!phone) { row.status = "failed"; row.error = "invalid phone"; }
  else if (!providerConfigured()) { row.status = "logged"; row.error = "no SMS provider configured"; }
  else {
    try { await sendViaTermii(phone, body, channel); row.status = "sent"; }
    catch (e) { row.status = "failed"; row.error = String(e.message || e).slice(0, 200); }
  }
  await db.prepare("INSERT INTO messages (id,reseller_id,to_phone,channel,kind,body,status,error,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(row.id, resellerId, phone || String(to || ""), channel, kind, body, row.status, row.error, Date.now());
  if (row.status !== "sent") console.log(`[notify] ${row.status} ${kind} -> ${phone || to}: ${body}`);
  return row;
}

export function naira(n) {
  return "₦" + Number(n || 0).toLocaleString("en-NG", { maximumFractionDigits: 2 });
}
