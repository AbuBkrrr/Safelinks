// One place that turns "this customer may use the internet" into router
// commands. Every path that grants or revokes access (payment, voucher
// redeem, generated vouchers, trial, wallet renew, expiry, re-pairing) goes
// through here, so speed / device limit / duration / data cap can't drift.
import { db, id } from "./db.js";
import { planUptime } from "./planDuration.js";

const clean = (v, d = "-") => {
  const s = String(v ?? "").replace(/[,\r\n]/g, "").trim();
  return s.length ? s : d;
};

export function userPayload(voucher, plan) {
  // limit-uptime is a router-side backstop; wall-clock expiry is enforced by
  // the backend sweep (jobs.sweepVoucherExpiry), which disables the user.
  const msLeft = Math.max(60_000, Number(voucher.expires_at || 0) - Date.now());
  const uptime = voucher.expires_at ? `${Math.ceil(msLeft / 60_000)}m` : planUptime(plan);
  return {
    username: voucher.username,
    password: voucher.password || voucher.username,
    deviceLimit: Number(plan?.device_limit) > 0 ? Number(plan.device_limit) : 1,
    bandwidthMbps: Number(plan?.bandwidth) > 0 ? Number(plan.bandwidth) : 10,
    uptime,
    dataMb: Number(plan?.data_mb) > 0 ? Number(plan.data_mb) : 0,
  };
}

export async function queueForReseller(resellerId, type, payload) {
  const routers = await db.prepare("SELECT router_id FROM routers WHERE reseller_id = ?").all(resellerId);
  const now = Date.now();
  for (const r of routers) {
    await db.prepare("INSERT INTO router_commands (id,router_id,type,payload,status,created_at) VALUES (?,?,?,?,?,?)")
      .run(id("cmd"), r.router_id, type, JSON.stringify(payload), "pending", now);
  }
  return routers.length;
}

export async function queueVoucherOnRouters(voucher, plan) {
  if (!plan && voucher.plan_id) plan = await db.prepare("SELECT * FROM plans WHERE id = ?").get(voucher.plan_id);
  return queueForReseller(voucher.reseller_id, "create_user", userPayload(voucher, plan));
}

// Router agent wire format: one command per line, comma separated, no
// spaces, "-" for empty. C,<id>,<type>,<user>,<pass>,<devices>,<mbps>,<uptime>,<dataMB>
export function commandLine(c) {
  let p = {};
  try { p = JSON.parse(c.payload || "{}"); } catch (_) {}
  return [
    "C", c.id, c.type, clean(p.username || p.mac || p.ssid), clean(p.password),
    clean(p.deviceLimit, "1"), clean(p.bandwidthMbps, "10"), clean(p.uptime, "1d"), clean(p.dataMb, "0"),
  ].join(",");
}

// True once any of the reseller's routers has applied create_user for this
// login, so the portal can send the browser to the router's login page.
export async function userReadyOnRouter(resellerId, username) {
  const row = await db.prepare(
    `SELECT 1 FROM router_commands c JOIN routers r ON r.router_id = c.router_id
     WHERE r.reseller_id = ? AND c.type = 'create_user' AND c.status = 'executed' AND c.payload LIKE ? LIMIT 1`
  ).get(resellerId, `%"username":"${String(username).replace(/[%_"]/g, "")}"%`);
  return !!row;
}
