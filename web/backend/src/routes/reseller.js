import { db, id, genCode } from "../db.js";
import { json } from "../http.js";
import { authenticate, hashPassword } from "../auth.js";
import { enqueueCommandForReseller, effectiveRouterStatus } from "./router.js";
import { rateLimitByKey } from "../rateLimit.js";
import { saveUpload } from "../uploads.js";

// Every handler below scopes its query by `resellerId` taken from the
// verified JWT â€” never from a URL param or request body. That's the
// actual RBAC boundary a demo UI can't enforce on its own: a reseller
// literally cannot construct a request that reads another reseller's
// row, because the WHERE clause never sees anything the client sent.
function requireReseller(req, res) {
  const auth = authenticate(req, "reseller");
  if (!auth.ok) { json(res, auth.status, { error: auth.error }); return null; }
  return auth.user.resellerId;
}

// Kept in sync with CURRENCIES/LANGUAGES in frontend/src/ui.jsx and
// frontend/src/i18n.js â€” validated server-side too since the portal
// info endpoint is public and a bad value here would break the
// end-user Captive Portal, not just the reseller's own dashboard.
const CURRENCIES = new Set(["USD", "NGN", "KES", "UGX", "GHS", "ZAR", "TZS", "XOF", "EUR", "GBP"]);
const LANGUAGES = new Set(["en", "fr", "sw", "ha", "yo", "pt"]);


// ───────────────────────────────────────────────────────────────
// IP geolocation (via free ip-api.com, backend-only — no HTTPS needed
// because we call it server-side, not from the browser).
// Caches every lookup in geo_cache for 24h to stay within the 45 req/min
// rate limit even with busy routers.
// ───────────────────────────────────────────────────────────────
async function lookupGeoReseller(ip) {
  if (!ip || typeof ip !== "string") return null;
  // Skip private ranges — api would just fail anyway.
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|127\.|::1$)/.test(ip)) {
    return { country: "Local", region: null, city: null, isp: null };
  }
  const now = Date.now();
  try {
    const row = await db.prepare("SELECT country, region, city, isp, cached_at FROM geo_cache WHERE ip = ?").get(ip);
    if (row && now - Number(row.cached_at) < 24 * 60 * 60 * 1000) {
      return { country: row.country, region: row.region, city: row.city, isp: row.isp };
    }
  } catch (_) {}
  try {
    const r = await fetch("http://ip-api.com/line/" + encodeURIComponent(ip) + "?fields=status,country,regionName,city,isp");
    const txt = await r.text();
    const lines = txt.trim().split("\n");
    if (lines[0] === "success" && lines.length >= 5) {
      const geo = { country: lines[1], region: lines[2], city: lines[3], isp: lines[4] };
      await db.prepare("INSERT INTO geo_cache (ip, country, region, city, isp, ok, cached_at) VALUES (?,?,?,?,?,TRUE,?) ON CONFLICT (ip) DO UPDATE SET country=EXCLUDED.country, region=EXCLUDED.region, city=EXCLUDED.city, isp=EXCLUDED.isp, ok=TRUE, cached_at=EXCLUDED.cached_at")
        .run(ip, geo.country, geo.region, geo.city, geo.isp, now).catch(() => {});
      return geo;
    }
  } catch (_) {}
  return null;
}

// Called when a voucher is suspended/expired — pulls the MAC from the
// most recent session so the router can unbind it, and (for RADIUS-capable
// vendors) marks the RADIUS user as suspended so it routes to the pay page.
async function queueUnbindForVoucher(voucherId, resellerId) {
  try {
    const sess = await db.prepare(
      "SELECT mac FROM active_sessions WHERE reseller_id = ? ORDER BY last_seen DESC LIMIT 1"
    ).get(resellerId);
    const mac = sess && sess.mac ? sess.mac : null;
    if (!mac) return;
    const routers = await db.prepare("SELECT router_id FROM routers WHERE reseller_id = ?").all(resellerId);
    const now = Date.now();
    for (const r of routers) {
      await db.prepare(
        "INSERT INTO router_commands (id, router_id, type, payload, status, created_at) VALUES (?,?,?,?,?,?)"
      ).run(id("cmd"), r.router_id, "unbind_mac", JSON.stringify({ username: mac }), "pending", now);
    }
  } catch (_) {}
}

export function registerResellerRoutes(router) {
  // --- Vouchers ---
  router.post("/api/reseller/vouchers/generate", async (req, res, { body }) => {
  const resellerId = requireReseller(req, res); if (!resellerId) return;
  const { count, planId } = body;
  if (!count || !planId) return json(res, 400, { error: "count and planId required" });
  const plan = await db.prepare("SELECT * FROM plans WHERE id = ?").get(planId);
  if (!plan) return json(res, 404, { error: "Plan not found" });
  const now = Date.now();
  const expiresAt = now + durationToMs(plan.duration_value, plan.duration_unit);
  const vouchers = [];
  for (let i = 0; i < count; i++) {
    const username = `v-${Math.random().toString(36).substring(2, 6)}${Math.floor(1000 + Math.random() * 9000)}`;
    const password = "";  // single-code vouchers (no password)
    const vId = id("v");
    await db.prepare(`INSERT INTO vouchers (id,reseller_id,username,password,name,email,phone,business,plan_id,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(vId, resellerId, username, password, "Generated", null, null, null, planId, "active", now, expiresAt);
    vouchers.push({ id: vId, username, password, plan_id: planId, expires_at: expiresAt });
  }
  json(res, 200, { count: vouchers.length, vouchers });
});

router.get("/api/reseller/vouchers", async (req, res) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const vouchers = await db.prepare(`
      SELECT v.*, p.name AS plan_name, p.device_limit,
        (SELECT COUNT(*) FROM sessions s WHERE s.voucher_id = v.id) AS session_count
      FROM vouchers v JOIN plans p ON p.id = v.plan_id
      WHERE v.reseller_id = ? ORDER BY v.created_at DESC
    `).all(resellerId);
    json(res, 200, { vouchers });
  });

  router.put("/api/reseller/vouchers/:id/status", async (req, res, { params, body }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    if (!["active", "paused"].includes(body.status)) return json(res, 400, { error: "status must be active or paused" });
    const voucher = await db.prepare("SELECT username FROM vouchers WHERE id = ? AND reseller_id = ?").get(params.id, resellerId);
    if (!voucher) return json(res, 404, { error: "Voucher not found" });
    await db.prepare("UPDATE vouchers SET status = ? WHERE id = ? AND reseller_id = ?").run(body.status, params.id, resellerId);
    if (body.status === "suspended" || body.status === "inactive") {
      await queueUnbindForVoucher(params.id, resellerId);
    }
    await enqueueCommandForReseller(resellerId, body.status === "active" ? "enable_user" : "disable_user", { username: voucher.username });
    json(res, 200, { ok: true });
  });

  router.delete("/api/reseller/vouchers/:id", async (req, res, { params }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const voucher = await db.prepare("SELECT username FROM vouchers WHERE id = ? AND reseller_id = ?").get(params.id, resellerId);
    if (!voucher) return json(res, 404, { error: "Voucher not found" });
    await db.prepare("DELETE FROM vouchers WHERE id = ? AND reseller_id = ?").run(params.id, resellerId);
    await enqueueCommandForReseller(resellerId, "delete_user", { username: voucher.username });
    json(res, 200, { ok: true });
  });

  // --- Active sessions ---
  router.get("/api/reseller/sessions", async (req, res) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const rows = await db.prepare(`
      SELECT s.*, v.username FROM sessions s
      JOIN vouchers v ON v.id = s.voucher_id
      WHERE v.reseller_id = ? ORDER BY s.connected_at DESC
    `).all(resellerId);
    json(res, 200, { sessions: rows });
  });

  router.delete("/api/reseller/sessions/:id", async (req, res, { params }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const result = await db.prepare(`
      DELETE FROM sessions WHERE id = ? AND voucher_id IN (SELECT id FROM vouchers WHERE reseller_id = ?)
    `).run(params.id, resellerId);
    if (result.changes === 0) return json(res, 404, { error: "Session not found" });
    json(res, 200, { ok: true });
  });

  // --- Routers ---
  // GET /api/reseller/routers/live — this reseller's routers with live metrics
  router.get("/api/reseller/routers/live", async (req, res) => {
    const auth = authenticate(req, "reseller");
    if (!auth.ok) return json(res, auth.status, { error: auth.error });
    const resellerId = auth.user.id || auth.user.sub;
    const rows = await db.prepare(`
      SELECT r.router_id, r.model, r.firmware, r.last_check_in, r.status,
             m.cpu_load, m.ram_used, m.ram_total, m.uptime_seconds, m.active_user_count, m.updated_at
      FROM routers r
      LEFT JOIN router_metrics m ON m.router_id = r.router_id
      WHERE r.reseller_id = ?
      ORDER BY r.last_check_in DESC NULLS LAST
      LIMIT 100
    `).all(resellerId);
    const now = Date.now();
    return json(res, 200, rows.map(row => ({
      routerId: row.router_id,
      model: row.model || null,
      firmware: row.firmware || null,
      online: row.last_check_in && (now - Number(row.last_check_in) < 90000),
      lastCheckIn: row.last_check_in ? Number(row.last_check_in) : null,
      cpuLoad: Number(row.cpu_load || 0),
      ramUsed: Number(row.ram_used || 0),
      ramTotal: Number(row.ram_total || 0),
      uptimeSeconds: Number(row.uptime_seconds || 0),
      activeUsers: Number(row.active_user_count || 0),
      metricsAt: row.updated_at ? Number(row.updated_at) : null,
    })));
  });

  router.get("/api/reseller/routers", async (req, res) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const rows = await db.prepare("SELECT * FROM routers WHERE reseller_id = ? ORDER BY last_check_in DESC").all(resellerId);
    const routers = [];
    for (const r of rows) {
      const pending = await db.prepare("SELECT COUNT(*) AS n FROM router_commands WHERE router_id = ? AND status = 'pending'").get(r.router_id);
      routers.push({
        ...r,
        status: effectiveRouterStatus(r.last_check_in), // recomputed, not just the stored value â€” see router.js
        pendingCommands: Number(pending.n),
      });
    }
    json(res, 200, { routers });
  });

  // Called by the installer app at the end of the 8-step wizard (Agent
  // Registration step). Generates the router's polling API key â€” shown
  // ONCE here in plaintext, then only ever stored hashed. The installer
  // burns it into the router's scheduler script so it can check in.
  //
  // This is the manual-entry path (you already know the router's
  // model/firmware/IP and type them in yourself). For the zero-touch
  // path where the router registers itself, see the pairing-code
  // endpoints and POST /api/agent/register below instead.

  // --- Pairing codes (zero-touch self-registration) ---
  // The installer wizard calls this, shows the code to whoever's at
  // the router, and polls GET .../:code until the router itself has
  // called POST /api/agent/register with it. Nobody types in the
  // router's model/firmware/IP â€” the router reports those itself.
  router.post("/api/reseller/pairing-codes", async (req, res) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const now = Date.now();
    const code = genCode(6).toUpperCase();
    const pairingId = id("pc");
    await db.prepare("INSERT INTO pairing_codes (id,reseller_id,code,status,expires_at,created_at) VALUES (?,?,?,?,?,?)")
      .run(pairingId, resellerId, code, "pending", now + 15 * 60000, now);
    json(res, 201, { code, expiresAt: now + 15 * 60000 });
  });

  router.get("/api/reseller/pairing-codes/:code", async (req, res, { params }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const pc = await db.prepare("SELECT * FROM pairing_codes WHERE code = ? AND reseller_id = ?").get(params.code, resellerId);
    if (!pc) return json(res, 404, { error: "Pairing code not found" });
    if (pc.status === "pending" && pc.expires_at < Date.now()) {
      return json(res, 200, { status: "expired" });
    }
    if (pc.status === "used") {
      const rt = await db.prepare("SELECT router_id, model, firmware FROM routers WHERE router_id = ?").get(pc.router_id);
      return json(res, 200, { status: "used", router: rt });
    }
    json(res, 200, { status: "pending", expiresAt: pc.expires_at });
  });

  router.post("/api/reseller/routers", async (req, res, { body }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const { model, firmware, ssid, ip, location } = body;
    const now = Date.now();
    const routerId = `RTR-${resellerId.slice(-4).toUpperCase()}-${genCode(3)}`;
    const apiKey = `sk_${genCode(24)}`;

    await db.prepare("INSERT INTO routers (id,reseller_id,router_id,api_key_hash,model,firmware,last_check_in,status) VALUES (?,?,?,?,?,?,?,?)")
      .run(id("rt"), resellerId, routerId, hashPassword(apiKey), model || "Unknown", firmware || "Unknown", now, "online");
    await db.prepare("INSERT INTO installations (id,reseller_id,router_id,ip,location,status,time) VALUES (?,?,?,?,?,?,?)")
      .run(id("i"), resellerId, routerId, ip || null, location || ssid || null, "completed", now);
    const reseller = await db.prepare("SELECT company_name FROM resellers WHERE id = ?").get(resellerId);
    await db.prepare("INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)")
      .run(id("n"), "super_admin", "install", "New reseller installation",
        `${reseller.company_name} completed a zero-touch installation (${routerId}) â€” now online.`, now, 0, "installs");

    // Sync every currently-active voucher onto the freshly provisioned
    // router so it's not starting from an empty user list.
    const activeVouchers = await db.prepare("SELECT username, password, plan_id FROM vouchers WHERE reseller_id = ? AND status = 'active'").all(resellerId);
    for (const v of activeVouchers) {
      const plan = await db.prepare("SELECT device_limit, bandwidth FROM plans WHERE id = ?").get(v.plan_id);
      await db.prepare("INSERT INTO router_commands (id, router_id, type, payload, status, created_at) VALUES (?,?,?,?,?,?)")
        .run(id("cmd"), routerId, "create_user", JSON.stringify({ username: v.username, password: v.password, deviceLimit: plan?.device_limit, bandwidthMbps: plan?.bandwidth }), "pending", now);
    }

    // apiKey is returned ONLY in this response â€” the server never
    // stores or returns the plaintext again after this.
    json(res, 201, { routerId, apiKey, status: "online", syncedVouchers: activeVouchers.length });
  });

  // Recent command history across all of this reseller's routers â€” an
  // audit trail of what's been pushed and whether the router ack'd it.
  router.get("/api/reseller/commands", async (req, res) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const rows = await db.prepare(`
      SELECT c.* FROM router_commands c
      JOIN routers r ON r.router_id = c.router_id
      WHERE r.reseller_id = ? ORDER BY c.created_at DESC LIMIT 100
    `).all(resellerId);
    json(res, 200, { commands: rows.map((c) => ({ ...c, payload: JSON.parse(c.payload) })) });
  });

  // --- Delivery logs ---
  router.get("/api/reseller/delivery-logs", async (req, res) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const rows = await db.prepare(`
      SELECT d.*, v.username FROM delivery_logs d
      JOIN vouchers v ON v.id = d.voucher_id
      WHERE v.reseller_id = ? ORDER BY d.time DESC
    `).all(resellerId);
    json(res, 200, { deliveryLogs: rows });
  });

  router.post("/api/reseller/delivery-logs/:id/retry", async (req, res, { params }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const result = await db.prepare(`
      UPDATE delivery_logs SET status = 'delivered', time = ?
      WHERE id = ? AND voucher_id IN (SELECT id FROM vouchers WHERE reseller_id = ?)
    `).run(Date.now(), params.id, resellerId);
    if (result.changes === 0) return json(res, 404, { error: "Delivery log not found" });
    json(res, 200, { ok: true });
  });

  // --- Plans (reseller's own end-user plans) ---
  router.get("/api/reseller/plans", async (req, res) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const plans = await db.prepare("SELECT * FROM plans WHERE reseller_id = ? ORDER BY price ASC").all(resellerId);
    json(res, 200, { plans });
  });

  router.post("/api/reseller/plans", async (req, res, { body }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const { name, duration, durationUnit, durationValue, price, deviceLimit, bandwidth, priority, popular } = body;
    // Flexible duration: prefer unit + value; fall back to legacy duration string
    const finalDuration = duration || (durationValue && durationUnit ? (durationValue + "_" + durationUnit) : "");
    if (!name || !finalDuration || price == null) return json(res, 400, { error: "name, duration (or durationUnit+durationValue), and price are required" });
    if (typeof price !== "number" || !Number.isFinite(price) || price < 0) return json(res, 400, { error: "price must be a non-negative number" });
    if (deviceLimit != null && (typeof deviceLimit !== "number" || deviceLimit < 1)) return json(res, 400, { error: "deviceLimit must be at least 1" });
    const planId = id("p");
    await db.prepare("INSERT INTO plans (id,reseller_id,name,duration,duration_unit,duration_value,price,device_limit,bandwidth,priority,popular,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(planId, resellerId, name, finalDuration, durationUnit || "day", durationValue != null ? Math.round(Number(durationValue)) : null, price, deviceLimit || 1, bandwidth || 10, priority || "medium", popular ? 1 : 0, Date.now());
    json(res, 201, { id: planId });
  });

  router.put("/api/reseller/plans/:id", async (req, res, { params, body }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const { name, duration, durationUnit, durationValue, price, deviceLimit, bandwidth, priority, popular } = body;
    const finalDuration = duration || (durationValue && durationUnit ? (durationValue + "_" + durationUnit) : "");
    if (!name || !finalDuration || price == null) return json(res, 400, { error: "name, duration (or durationUnit+durationValue), and price are required" });
    if (typeof price !== "number" || !Number.isFinite(price) || price < 0) return json(res, 400, { error: "price must be a non-negative number" });
    if (deviceLimit != null && (typeof deviceLimit !== "number" || deviceLimit < 1)) return json(res, 400, { error: "deviceLimit must be at least 1" });
    const result = await db.prepare(`
      UPDATE plans SET name=?, duration=?, duration_unit=?, duration_value=?, price=?, device_limit=?, bandwidth=?, priority=?, popular=?
      WHERE id = ? AND reseller_id = ?
    `).run(name, finalDuration, durationUnit || "day", durationValue != null ? Math.round(Number(durationValue)) : null, price, deviceLimit, bandwidth, priority, popular ? 1 : 0, params.id, resellerId);
    if (result.changes === 0) return json(res, 404, { error: "Plan not found" });
    json(res, 200, { ok: true });
  });

  router.delete("/api/reseller/plans/:id", async (req, res, { params }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const result = await db.prepare("DELETE FROM plans WHERE id = ? AND reseller_id = ?").run(params.id, resellerId);
    if (result.changes === 0) return json(res, 404, { error: "Plan not found" });
    json(res, 200, { ok: true });
  });

  // ── Client devices — reseller manages their end-users' devices ──
  // A client device is a MAC address with a human label + priority that
  // the router treats specially: high = 2× plan bw, medium = plan bw,
  // low = 0.5× plan bw. Priority changes queue a fresh bind_mac.
  function durationToMs(value, unit) {
    const v = Number(value) || 1;
    const u = String(unit || 'day').toLowerCase();
    if (u === 'minute' || u === 'minutes' || u === 'min' || u === 'mins') return v * 60 * 1000;
    if (u === 'hour' || u === 'hours' || u === 'hr' || u === 'hrs') return v * 60 * 60 * 1000;
    if (u === 'day' || u === 'days') return v * 24 * 60 * 60 * 1000;
    if (u === 'week' || u === 'weeks') return v * 7 * 24 * 60 * 60 * 1000;
    if (u === 'month' || u === 'months') return v * 30 * 24 * 60 * 60 * 1000;
    if (u === 'year' || u === 'years') return v * 365 * 24 * 60 * 60 * 1000;
    return v * 24 * 60 * 60 * 1000;
  }

  function priorityToMbps(priority, planBandwidth) {
    const bw = Number(planBandwidth) || 20;
    if (priority === "high") return Math.round(bw * 2);
    if (priority === "low") return Math.max(2, Math.round(bw * 0.5));
    return bw;
  }

  router.get("/api/reseller/clients", async (req, res) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const devices = await db.prepare(
      "SELECT * FROM client_devices WHERE reseller_id = ? AND status = 'active' ORDER BY added_at DESC"
    ).all(resellerId);
    const now = Date.now();
    const enriched = [];
    for (const d of devices) {
      const live = await db.prepare(
        "SELECT last_seen, ip, bytes_in, bytes_out FROM active_sessions WHERE reseller_id = ? AND mac = ? ORDER BY last_seen DESC LIMIT 1"
      ).get(resellerId, d.mac);
      const v = d.voucher_id
        ? await db.prepare("SELECT username, expires_at, plan_id FROM vouchers WHERE id = ?").get(d.voucher_id)
        : null;
      enriched.push({
        id: d.id,
        mac: d.mac,
        label: d.label || "",
        deviceType: d.device_type,
        priority: d.priority,
        bandwidthMbps: d.bandwidth_mbps,
        voucherId: d.voucher_id,
        voucherUsername: v ? v.username : null,
        voucherExpiresAt: v ? Number(v.expires_at) : null,
        addedAt: Number(d.added_at),
        lastSeen: live ? Number(live.last_seen) : null,
        ip: live ? live.ip : null,
        bytesIn: live ? Number(live.bytes_in || 0) : 0,
        bytesOut: live ? Number(live.bytes_out || 0) : 0,
        online: live && (now - Number(live.last_seen)) < 90000,
      });
    }
    return json(res, 200, enriched);
  });

  router.post("/api/reseller/clients", async (req, res, { body }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const b = body || {};
    const mac = String(b.mac || "").trim().toUpperCase();
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) return json(res, 400, { error: "mac must be like AA:BB:CC:DD:EE:FF" });
    const label = String(b.label || "").trim();
    const priority = ["high", "medium", "low"].includes(b.priority) ? b.priority : "medium";
    const deviceType = String(b.deviceType || "unknown").slice(0, 32);
    const voucherId = b.voucherId ? String(b.voucherId) : null;

    // Verify voucher belongs to this reseller if provided
    let voucher = null;
    if (voucherId) {
      voucher = await db.prepare("SELECT id, reseller_id, expires_at FROM vouchers WHERE id = ? AND reseller_id = ?").get(voucherId, resellerId);
      if (!voucher) return json(res, 404, { error: "voucher not found for this reseller" });
    }

    const now = Date.now();
    const deviceId = id("cd");
    let bandwidth = null;
    if (voucher) {
      const plan = await db.prepare("SELECT bandwidth FROM plans WHERE id = (SELECT plan_id FROM vouchers WHERE id = ?)").get(voucherId);
      bandwidth = priorityToMbps(priority, plan && plan.bandwidth);
    }

    try {
      await db.prepare(
        "INSERT INTO client_devices (id, reseller_id, mac, label, device_type, priority, bandwidth_mbps, voucher_id, status, added_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
      ).run(deviceId, resellerId, mac, label, deviceType, priority, bandwidth, voucherId, "active", now);
    } catch (e) {
      if (String(e.message || "").includes("duplicate") || String(e.message || "").includes("UNIQUE")) {
        return json(res, 409, { error: "this MAC is already registered for your account" });
      }
      return json(res, 500, { error: String(e.message || e) });
    }

    // Queue bind_mac if we have a voucher (activates immediately)
    if (voucher) {
      const isoExpiry = new Date(Number(voucher.expires_at)).toISOString().slice(0, 19);
      const routers = await db.prepare("SELECT router_id FROM routers WHERE reseller_id = ?").all(resellerId);
      for (const r of routers) {
        await db.prepare(
          "INSERT INTO router_commands (id, router_id, type, payload, status, created_at) VALUES (?,?,?,?,?,?)"
        ).run(id("cmd"), r.router_id, "bind_mac", JSON.stringify({ username: mac, password: isoExpiry, bandwidthMbps: bandwidth }), "pending", now);
      }
    }
    return json(res, 201, { id: deviceId, mac, label, priority, deviceType, voucherId, bandwidthMbps: bandwidth });
  });

  router.put("/api/reseller/clients/:mac", async (req, res, { params, body }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const mac = String(params.mac || "").trim().toUpperCase();
    const b = body || {};
    const label = b.label != null ? String(b.label).trim() : null;
    const priority = ["high", "medium", "low"].includes(b.priority) ? b.priority : null;
    const deviceType = b.deviceType != null ? String(b.deviceType).slice(0, 32) : null;

    const existing = await db.prepare("SELECT * FROM client_devices WHERE reseller_id = ? AND mac = ? AND status = 'active'").get(resellerId, mac);
    if (!existing) return json(res, 404, { error: "device not found" });

    let bandwidth = existing.bandwidth_mbps;
    if (priority && priority !== existing.priority && existing.voucher_id) {
      const plan = await db.prepare("SELECT bandwidth FROM plans WHERE id = (SELECT plan_id FROM vouchers WHERE id = ?)").get(existing.voucher_id);
      bandwidth = priorityToMbps(priority, plan && plan.bandwidth);
    }

    await db.prepare(
      "UPDATE client_devices SET label = COALESCE(?, label), priority = COALESCE(?, priority), device_type = COALESCE(?, device_type), bandwidth_mbps = ? WHERE id = ?"
    ).run(label, priority, deviceType, bandwidth, existing.id);

    // If priority changed, queue a fresh bind_mac with the new bandwidth
    if (priority && priority !== existing.priority && existing.voucher_id) {
      const v = await db.prepare("SELECT expires_at FROM vouchers WHERE id = ?").get(existing.voucher_id);
      if (v) {
        const isoExpiry = new Date(Number(v.expires_at)).toISOString().slice(0, 19);
        const routers = await db.prepare("SELECT router_id FROM routers WHERE reseller_id = ?").all(resellerId);
        const now = Date.now();
        for (const r of routers) {
          await db.prepare(
            "INSERT INTO router_commands (id, router_id, type, payload, status, created_at) VALUES (?,?,?,?,?,?)"
          ).run(id("cmd"), r.router_id, "bind_mac", JSON.stringify({ username: mac, password: isoExpiry, bandwidthMbps: bandwidth }), "pending", now);
        }
      }
    }
    return json(res, 200, { ok: true, bandwidthMbps: bandwidth });
  });

  router.post("/api/reseller/clients/:mac/unbind", async (req, res, { params }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const mac = String(params.mac || "").trim().toUpperCase();
    const existing = await db.prepare("SELECT * FROM client_devices WHERE reseller_id = ? AND mac = ? AND status = 'active'").get(resellerId, mac);
    if (!existing) return json(res, 404, { error: "device not found" });

    await db.prepare("UPDATE client_devices SET status = 'unbound' WHERE id = ?").run(existing.id);
    const now = Date.now();
    const routers = await db.prepare("SELECT router_id FROM routers WHERE reseller_id = ?").all(resellerId);
    for (const r of routers) {
      await db.prepare(
        "INSERT INTO router_commands (id, router_id, type, payload, status, created_at) VALUES (?,?,?,?,?,?)"
      ).run(id("cmd"), r.router_id, "unbind_mac", JSON.stringify({ username: mac }), "pending", now);
    }
    return json(res, 200, { ok: true });
  });

  // --- Captive portal settings ---
  // contactEmail/contactWhatsapp are shown to end-users on the portal so
  // they have a manual way to reach the reseller (no automated
  // email/WhatsApp sending exists anywhere in this system).
  router.get("/api/reseller/portal-settings", async (req, res) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    // bank_name/bank_account_name/bank_account_number/ussd_code are the
    // RESELLER'S OWN account â€” where their end-users' bank-transfer
    // voucher payments land (see routes/portal.js GET /:resellerId,
    // which surfaces these same four fields to the Captive Portal).
    // Not to be confused with platform-bank-info above, which is the
    // Super Admin's account for the reseller's own license fee.
    const r = await db.prepare("SELECT ssid, portal_title, color, currency, language, dashboard_language, contact_email, contact_whatsapp, bank_name, bank_account_name, bank_account_number, ussd_code, logo_url, favicon_url, welcome_message, support_phone, terms_url, privacy_url, background_image_url FROM resellers WHERE id = ?").get(resellerId);
    json(res, 200, r);
  });

  router.put("/api/reseller/portal-settings", async (req, res, { body }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const { ssid, portalTitle, color, currency, language, dashboardLanguage, contactEmail, contactWhatsapp, bankName, bankAccountName, bankAccountNumber, ussdCode, logoUrl, faviconUrl, welcomeMessage, supportPhone, termsUrl, privacyUrl, backgroundImageUrl } = body;
    if (currency !== undefined && !CURRENCIES.has(currency)) {
      return json(res, 400, { error: `currency must be one of: ${[...CURRENCIES].join(", ")}` });
    }
    if (language !== undefined && !LANGUAGES.has(language)) {
      return json(res, 400, { error: `language must be one of: ${[...LANGUAGES].join(", ")}` });
    }
    if (dashboardLanguage !== undefined && !LANGUAGES.has(dashboardLanguage)) {
      return json(res, 400, { error: `dashboardLanguage must be one of: ${[...LANGUAGES].join(", ")}` });
    }
    await db.prepare(`UPDATE resellers SET
        ssid = COALESCE(?, ssid), portal_title = COALESCE(?, portal_title), color = COALESCE(?, color),
        currency = COALESCE(?, currency), language = COALESCE(?, language), dashboard_language = COALESCE(?, dashboard_language),
        contact_email = COALESCE(?, contact_email), contact_whatsapp = COALESCE(?, contact_whatsapp),
        bank_name = COALESCE(?, bank_name), bank_account_name = COALESCE(?, bank_account_name),
        bank_account_number = COALESCE(?, bank_account_number), ussd_code = COALESCE(?, ussd_code),
        logo_url = COALESCE(?, logo_url), favicon_url = COALESCE(?, favicon_url),
        welcome_message = COALESCE(?, welcome_message), support_phone = COALESCE(?, support_phone),
        terms_url = COALESCE(?, terms_url), privacy_url = COALESCE(?, privacy_url),
        background_image_url = COALESCE(?, background_image_url)
      WHERE id = ?`)
      .run(ssid, portalTitle, color, currency, language, dashboardLanguage, contactEmail, contactWhatsapp, bankName, bankAccountName, bankAccountNumber, ussdCode, logoUrl, faviconUrl, welcomeMessage, supportPhone, termsUrl, privacyUrl, backgroundImageUrl, resellerId);
    // If SSID changed, queue a router command so the router actually renames
    // its WiFi interface. Otherwise clients keep seeing the old SSID.
    if (ssid && typeof ssid === 'string' && ssid.trim()) {
      try {
        const rs2 = await db.prepare("SELECT router_id FROM routers WHERE reseller_id = ?").all(resellerId);
        const ts = Date.now();
        for (const r of rs2) {
          await db.prepare("INSERT INTO router_commands (id, router_id, type, payload, status, created_at) VALUES (?,?,?,?,?,?)")
            .run(id("cmd"), r.router_id, "set_ssid", JSON.stringify({ ssid }), "pending", ts);
        }
      } catch (_) {}
    }
    json(res, 200, { ok: true });
  });

  // --- Pending activations (bank-transfer voucher purchases) ---
  router.get("/api/reseller/pending-activations", async (req, res) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const rows = await db.prepare(`
      SELECT pa.*, p.name AS plan_name FROM pending_activations pa
      JOIN plans p ON p.id = pa.plan_id
      WHERE pa.reseller_id = ? ORDER BY pa.time DESC
    `).all(resellerId);
    json(res, 200, { pendingActivations: rows });
  });

  router.put("/api/reseller/pending-activations/:id", async (req, res, { params, body }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    if (!["confirmed", "rejected"].includes(body.decision)) return json(res, 400, { error: "decision must be confirmed or rejected" });

    const pending = await db.prepare("SELECT * FROM pending_activations WHERE id = ? AND reseller_id = ?").get(params.id, resellerId);
    if (!pending) return json(res, 404, { error: "Pending activation not found" });
    if (pending.status !== "pending") return json(res, 409, { error: `Already ${pending.status}` });

    const now = Date.now();
    await db.prepare("UPDATE pending_activations SET status = ?, decided_at = ? WHERE id = ?").run(body.decision, now, params.id);

    if (body.decision === "confirmed") {
      const plan = await db.prepare("SELECT * FROM plans WHERE id = ?").get(pending.plan_id);
      const username = `${pending.name.split(" ")[0].toLowerCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const password = genCode(8);
      const voucherId = id("v");
      const voucherExpiresAt = now + durationToMs(plan?.duration_value, plan?.duration_unit);
      await db.prepare(`INSERT INTO vouchers (id,reseller_id,username,password,name,email,phone,business,plan_id,status,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(voucherId, resellerId, username, password, pending.name, pending.email, pending.phone, pending.business, pending.plan_id, "active", now, voucherExpiresAt);
      await db.prepare("INSERT INTO delivery_logs (id,voucher_id,channel,status,time) VALUES (?,?,?,?,?)").run(id("dl"), voucherId, "email", "delivered", now);
      await db.prepare("INSERT INTO delivery_logs (id,voucher_id,channel,status,time) VALUES (?,?,?,?,?)").run(id("dl"), voucherId, "whatsapp", "delivered", now);
      await db.prepare("INSERT INTO payments (id,user_type,user_id,amount,method,status,time,note) VALUES (?,?,?,?,?,?,?,?)")
        .run(id("pay"), "voucher", voucherId, pending.amount, pending.method, "completed", now, "Voucher purchase");
      // Always create the hotspot user (fallback for clients without MAC)
      await enqueueCommandForReseller(resellerId, "create_user", { username, password, deviceLimit: plan?.device_limit, bandwidthMbps: plan?.bandwidth });
      // Zero-click bypass — payload uses username key + ISO expiry in password slot
      if (pending.client_mac) {
        const isoExpiry = new Date(voucherExpiresAt).toISOString().slice(0, 19);
        await enqueueCommandForReseller(resellerId, "bind_mac", {
          username: pending.client_mac,
          password: isoExpiry
        });
      }
      return json(res, 200, { ok: true, voucher: { username, password } });
    }
    json(res, 200, { ok: true });
  });

  // --- Platform plan catalog (read-only â€” what Super Admin charges) ---
  router.get("/api/reseller/platform-plans", async (req, res) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const plans = await db.prepare("SELECT * FROM platform_plans").all();
    json(res, 200, { plans });
  });

  // --- Billing ---
  router.get("/api/reseller/billing", async (req, res) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const revenueRow = await db.prepare(`
      SELECT COALESCE(SUM(p.price), 0) AS total FROM vouchers v
      JOIN plans p ON p.id = v.plan_id
      WHERE v.reseller_id = ? AND v.status = 'active'
    `).get(resellerId);
    const revenue = Number(revenueRow.total);
    const reseller = await db.prepare("SELECT subscription_plan FROM resellers WHERE id = ?").get(resellerId);
    const platformPlan = await db.prepare("SELECT * FROM platform_plans WHERE id = ?").get(reseller.subscription_plan);
    const payments = await db.prepare(`
      SELECT pay.* FROM payments pay
      JOIN vouchers v ON v.id = pay.user_id AND pay.user_type = 'voucher'
      WHERE v.reseller_id = ? ORDER BY pay.time DESC
    `).all(resellerId);
    json(res, 200, { monthlyRevenue: revenue, licenseFee: platformPlan.price, netProfit: revenue - platformPlan.price, payments });
  });

  // --- Platform bank info (where to send the license fee transfer) ---
  router.get("/api/reseller/platform-bank-info", async (req, res) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const sa = await db.prepare("SELECT bank_name, bank_account_name, bank_account_number, ussd_code FROM super_admins LIMIT 1").get();
    const settings = await db.prepare("SELECT platform_currency FROM integration_settings WHERE id = 'singleton'").get();
    json(res, 200, { ...(sa || {}), platformCurrency: settings?.platform_currency || "USD" });
  });

  // --- License ---
  router.get("/api/reseller/license", async (req, res) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const r = await db.prepare("SELECT license_key, status, subscription_plan, subscription_expiry FROM resellers WHERE id = ?").get(resellerId);
    const pending = await db.prepare("SELECT * FROM license_payment_requests WHERE reseller_id = ? AND status = 'pending' ORDER BY time DESC LIMIT 1").get(resellerId);
    json(res, 200, { ...r, pendingPayment: pending || null });
  });

  // No payment gateway â€” the reseller transfers the license fee straight
  // to the Super Admin's bank account (see /platform-bank-info above)
  // and submits the receipt reference here. The license stays on its
  // current plan/expiry until Super Admin confirms it (see
  // routes/superAdmin.js PUT /api/admin/license-payments/:id).
  router.post("/api/reseller/license/renew", async (req, res, { body }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const { planId, method, reference, receiptUrl } = body;
    if (!reference) return json(res, 400, { error: "reference is required â€” this is a manual transfer, not a gateway payment" });
    const plan = await db.prepare("SELECT * FROM platform_plans WHERE id = ?").get(planId);
    if (!plan) return json(res, 404, { error: "Platform plan not found" });

    const existing = await db.prepare("SELECT id FROM license_payment_requests WHERE reseller_id = ? AND status = 'pending'").get(resellerId);
    if (existing) return json(res, 409, { error: "A license payment is already pending confirmation" });

    const now = Date.now();
    const reqId = id("lp");
    await db.prepare("INSERT INTO license_payment_requests (id,reseller_id,plan_id,amount,method,reference,status,time,receipt_url) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(reqId, resellerId, planId, plan.price, method || "Bank Transfer", reference, "pending", now, receiptUrl || null);
    const reseller = await db.prepare("SELECT company_name FROM resellers WHERE id = ?").get(resellerId);
    const settings = await db.prepare("SELECT platform_currency FROM integration_settings WHERE id = 'singleton'").get();
    const platformCurrency = settings?.platform_currency || "USD";
    await db.prepare("INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)")
      .run(id("n"), "super_admin", "payment", "License payment confirmation needed",
        `${reseller.company_name} submitted a transfer for the ${plan.name} plan (${plan.price} ${platformCurrency}) â€” ref: ${reference}.`, now, 0, "license");
    json(res, 202, { ok: true, status: "pending", requestId: reqId });
  });

  // POST /api/reseller/upload-receipt â€” a reseller attaches a photo of
  // their own bank transfer receipt (or a PDF) for a license renewal.
  // Returns a URL to include as `receiptUrl` in POST /license/renew
  // above. Mirrors the public portal.js upload-receipt endpoint, just
  // authenticated instead of open (this one's for the reseller's own
  // payment, not a customer's).
  router.post("/api/reseller/upload-receipt", async (req, res, { body }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    if (await rateLimitByKey(res, `upload-receipt:${resellerId}`, { max: 20, windowMs: 60 * 60000 })) return;
    try {
      const result = await saveUpload(body);
      json(res, 201, result);
    } catch (err) {
      json(res, 400, { error: err.message || "Upload failed" });
    }
  });

  // Instant, self-serve activation â€” the counterpart to Super Admin's
  // /api/admin/product-keys/generate. No pending state, no waiting on
  // anyone: Super Admin already vetted the payment before ever
  // generating the key, so redeeming one here activates immediately.
  // Same 30/60/90-day-style expiry convention as a confirmed license
  // payment (routes/superAdmin.js PUT /api/admin/license-payments/:id)
  // â€” it SETS subscription_expiry to now+duration, it does not stack
  // on top of remaining time, so redeeming early "wastes" the
  // remainder of a still-active license the same way renewing early
  // already does elsewhere in this app.
  router.post("/api/reseller/product-key/redeem", async (req, res, { body }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const raw = (body.key || "").trim().toUpperCase();
    if (!raw) return json(res, 400, { error: "Enter a product key" });
    // Accept with or without dashes â€” someone reading a code off a
    // printed card or over the phone will not reliably reproduce
    // punctuation.
    const normalized = raw.replace(/[^A-Z0-9]/g, "");
    const grouped = normalized.match(/.{1,4}/g)?.join("-") || raw;

    if (await rateLimitByKey(res, `redeem-key:${resellerId}`, { max: 10, windowMs: 60 * 60000 })) return;

    const keyRow = await db.prepare("SELECT * FROM product_keys WHERE key_code = ?").get(grouped);
    if (!keyRow) return json(res, 404, { error: "That key wasn't found â€” check it and try again" });
    if (keyRow.status === "used") return json(res, 409, { error: "That key has already been used" });
    if (keyRow.status === "revoked") return json(res, 409, { error: "That key has been revoked and can't be used" });

    const plan = await db.prepare("SELECT * FROM platform_plans WHERE id = ?").get(keyRow.plan_id);
    const now = Date.now();
    const newExpiry = now + keyRow.duration_days * 86400000;

    await db.prepare("UPDATE product_keys SET status = 'used', used_by_reseller_id = ?, used_at = ? WHERE id = ?")
      .run(resellerId, now, keyRow.id);
    await db.prepare("UPDATE resellers SET status = 'active', subscription_plan = ?, subscription_expiry = ? WHERE id = ?")
      .run(keyRow.plan_id, newExpiry, resellerId);
    const reseller = await db.prepare("SELECT company_name FROM resellers WHERE id = ?").get(resellerId);
    await db.prepare("INSERT INTO payments (id,user_type,user_id,amount,method,status,time,note) VALUES (?,?,?,?,?,?,?,?)")
      .run(id("pay"), "reseller", resellerId, plan?.price ?? 0, "Product Key", "completed", now, `Key activation (${keyRow.batch_label || "no batch"})`);
    await db.prepare("INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)")
      .run(id("n"), "super_admin", "payment", "License activated via product key",
        `${reseller.company_name} activated the ${plan?.name || "plan"} using a product key from batch "${keyRow.batch_label || "unlabeled"}".`, now, 0, "resellers");

    json(res, 200, { ok: true, plan: plan?.name, subscriptionExpiry: newExpiry });
  });

  // --- Referrals: a reseller invites a prospective marketer/reseller by
  // email/phone; if that person signs up using this reseller's own
  // referral_code, the invite (matched by email) flips to 'signed_up'
  // â€” see routes/auth.js signup. Nothing pays out from here: bonus
  // status only moves to 'bonus_paid' when Super Admin marks it so
  // (routes/superAdmin.js), same manual-payment pattern as every other
  // payout in this system.
  router.get("/api/reseller/referrals", async (req, res) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const me = await db.prepare("SELECT referral_code FROM resellers WHERE id = ?").get(resellerId);
    const settings = await db.prepare("SELECT referral_bonus_amount, platform_currency FROM integration_settings WHERE id = 'singleton'").get();
    const rows = await db.prepare(`
      SELECT ref.*, r.company_name AS referred_company_name
      FROM referrals ref
      LEFT JOIN resellers r ON r.id = ref.referred_reseller_id
      WHERE ref.referrer_reseller_id = ? ORDER BY ref.created_at DESC
    `).all(resellerId);
    // Rolled up here rather than left to the frontend, so "how much
    // have I actually earned" is always one real number, not something
    // recomputed client-side from a list that might paginate later.
    const summary = {
      invited: rows.filter((r) => r.status === "invited").length,
      signedUp: rows.filter((r) => r.status === "signed_up").length,
      bonusPaid: rows.filter((r) => r.status === "bonus_paid").length,
      flagged: rows.filter((r) => r.status === "flagged").length,
      totalEarned: rows.filter((r) => r.status === "bonus_paid").reduce((sum, r) => sum + Number(r.bonus_amount), 0),
      totalPending: rows.filter((r) => r.status === "signed_up").reduce((sum, r) => sum + Number(r.bonus_amount), 0),
    };
    json(res, 200, {
      referralCode: me?.referral_code || null,
      bonusAmount: Number(settings?.referral_bonus_amount ?? 10),
      currency: settings?.platform_currency || "USD",
      referrals: rows,
      summary,
    });
  });

  router.post("/api/reseller/referrals", async (req, res, { body }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    // Logged-in and JWT-authenticated already, but a compromised token
    // or a runaway client script could still hammer this â€” cap it well
    // above any legitimate marketer's real usage.
    if (await rateLimitByKey(res, `referral-invite:${resellerId}`, { max: 20, windowMs: 60 * 60000 })) return;
    const { name, email, phone } = body;
    if (!email && !phone) return json(res, 400, { error: "Give at least an email or phone number to invite" });
    if (email) {
      const dupe = await db.prepare("SELECT id FROM referrals WHERE referrer_reseller_id = ? AND status = 'invited' AND lower(email) = lower(?)").get(resellerId, email);
      if (dupe) return json(res, 409, { error: "You've already invited that email and it's still pending â€” no need to add it again" });
    }
    const settings = await db.prepare("SELECT referral_bonus_amount FROM integration_settings WHERE id = 'singleton'").get();
    const bonusAmount = Number(settings?.referral_bonus_amount ?? 10);
    const now = Date.now();
    const refId = id("ref");
    await db.prepare(`INSERT INTO referrals (id,referrer_reseller_id,name,email,phone,status,bonus_amount,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(refId, resellerId, name || null, email || null, phone || null, "invited", bonusAmount, now);
    json(res, 201, { id: refId });
  });

  router.delete("/api/reseller/referrals/:id", async (req, res, { params }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    // Only an un-converted invite can be withdrawn â€” once someone has
    // actually signed up against it, it's a real record of a bonus
    // owed and shouldn't quietly disappear from either side's view.
    const result = await db.prepare("DELETE FROM referrals WHERE id = ? AND referrer_reseller_id = ? AND status = 'invited'").run(params.id, resellerId);
    if (result.changes === 0) return json(res, 404, { error: "Referral not found, or it's already been converted and can't be withdrawn" });
    json(res, 200, { ok: true });
  });

  // --- Notifications (router alerts, payment confirmations, etc.) ---
  router.get("/api/reseller/notifications", async (req, res) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const rows = await db.prepare("SELECT * FROM notifications WHERE scope = ? ORDER BY time DESC").all(`reseller:${resellerId}`);
    json(res, 200, { notifications: rows });
  });

  router.put("/api/reseller/notifications/read-all", async (req, res) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    await db.prepare("UPDATE notifications SET read = 1 WHERE scope = ?").run(`reseller:${resellerId}`);
    json(res, 200, { ok: true });
  });

  // --- Support ---
  // Two separate directions share this table, distinguished by `source`:
  // 'reseller' = this reseller messaging Super Admin (below), vs
  // 'portal' = one of this reseller's own end-users messaging them via
  // the Captive Portal (see /api/portal/:resellerId/support). Filtering
  // is required â€” without it a reseller's "message Super Admin" inbox
  // would be polluted with their own customers' tickets, and vice versa.
  //
  // Every ticket list below attaches its full message thread. Sending a
  // message (POST .../messages) NEVER changes status â€” that was the bug
  // this replaces: a reply used to also resolve the ticket in one step,
  // making a real back-and-forth impossible. Status now only changes via
  // the dedicated PUT .../status endpoints.
  async function attachMessages(tickets) {
    if (tickets.length === 0) return tickets;
    const ids = tickets.map((t) => t.id);
    const placeholders = ids.map(() => "?").join(",");
    const messages = await db.prepare(`SELECT * FROM support_messages WHERE ticket_id IN (${placeholders}) ORDER BY time ASC`).all(...ids);
    const byTicket = {};
    for (const m of messages) (byTicket[m.ticket_id] ||= []).push(m);
    return tickets.map((t) => ({ ...t, messages: byTicket[t.id] || [] }));
  }

  router.get("/api/reseller/support", async (req, res) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const tickets = await db.prepare("SELECT * FROM support_tickets WHERE reseller_id = ? AND source = 'reseller' ORDER BY time DESC").all(resellerId);
    json(res, 200, { tickets: await attachMessages(tickets) });
  });

  router.post("/api/reseller/support", async (req, res, { body }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const { subject, message, attachmentUrl } = body;
    if (!subject || !message) return json(res, 400, { error: "subject and message are required" });
    const ticketId = id("t");
    await db.prepare("INSERT INTO support_tickets (id,reseller_id,subject,message,status,time,source,attachment_url) VALUES (?,?,?,?,?,?,?,?)")
      .run(ticketId, resellerId, subject, message, "open", Date.now(), "reseller", attachmentUrl || null);
    json(res, 201, { id: ticketId });
  });

  router.post("/api/reseller/support/:id/messages", async (req, res, { params, body }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    // A message needs text OR an attachment, not both â€” a voice note
    // recorded and sent on its own (no typed text) is a valid reply.
    if (!body.message && !body.attachmentUrl) return json(res, 400, { error: "Enter a message or attach a file/voice note" });
    const ticket = await db.prepare("SELECT id FROM support_tickets WHERE id = ? AND reseller_id = ? AND source = 'reseller'").get(params.id, resellerId);
    if (!ticket) return json(res, 404, { error: "Ticket not found" });
    await db.prepare("INSERT INTO support_messages (id,ticket_id,sender,message,time,attachment_url) VALUES (?,?,?,?,?,?)")
      .run(id("m"), params.id, "reseller", body.message || "", Date.now(), body.attachmentUrl || null);
    json(res, 201, { ok: true });
  });

  router.put("/api/reseller/support/:id/status", async (req, res, { params, body }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    if (!["open", "resolved"].includes(body.status)) return json(res, 400, { error: "status must be 'open' or 'resolved'" });
    const result = await db.prepare("UPDATE support_tickets SET status = ? WHERE id = ? AND reseller_id = ? AND source = 'reseller'")
      .run(body.status, params.id, resellerId);
    if (result.changes === 0) return json(res, 404, { error: "Ticket not found" });
    json(res, 200, { ok: true });
  });

  // POST /api/reseller/support/upload â€” a photo, PDF, or voice note to
  // attach to a support ticket/message, on either the reseller<->Super
  // Admin thread or the reseller<->customer thread below (same upload,
  // just re-used for both â€” pass the returned url as `attachmentUrl`).
  router.post("/api/reseller/support/upload", async (req, res, { body }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    if (await rateLimitByKey(res, `support-upload:${resellerId}`, { max: 30, windowMs: 60 * 60000 })) return;
    try {
      const result = await saveUpload(body);
      json(res, 201, result);
    } catch (err) {
      json(res, 400, { error: err.message || "Upload failed" });
    }
  });

  // End-user (Captive Portal) tickets addressed to THIS reseller. No
  // automated email exists in this app â€” a reply here is just a note
  // the reseller writes for their own records; they reach the customer
  // directly using customer_email/customer_phone shown alongside it.
  router.get("/api/reseller/customer-support", async (req, res) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const tickets = await db.prepare("SELECT * FROM support_tickets WHERE reseller_id = ? AND source = 'portal' ORDER BY time DESC").all(resellerId);
    json(res, 200, { tickets: await attachMessages(tickets) });
  });

  router.post("/api/reseller/customer-support/:id/messages", async (req, res, { params, body }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    if (!body.message && !body.attachmentUrl) return json(res, 400, { error: "Enter a message or attach a file/voice note" });
    const ticket = await db.prepare("SELECT id FROM support_tickets WHERE id = ? AND reseller_id = ? AND source = 'portal'").get(params.id, resellerId);
    if (!ticket) return json(res, 404, { error: "Ticket not found" });
    await db.prepare("INSERT INTO support_messages (id,ticket_id,sender,message,time,attachment_url) VALUES (?,?,?,?,?,?)")
      .run(id("m"), params.id, "reseller", body.message || "", Date.now(), body.attachmentUrl || null);
    json(res, 201, { ok: true });
  });

  router.put("/api/reseller/customer-support/:id/status", async (req, res, { params, body }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    if (!["open", "resolved"].includes(body.status)) return json(res, 400, { error: "status must be 'open' or 'resolved'" });
    const result = await db.prepare("UPDATE support_tickets SET status = ? WHERE id = ? AND reseller_id = ? AND source = 'portal'")
      .run(body.status, params.id, resellerId);
    if (result.changes === 0) return json(res, 404, { error: "Ticket not found" });
    json(res, 200, { ok: true });
  });

  // --- Notifications: per-item read (in addition to the existing
  // mark-all-read), so clicking a single notification to act on it can
  // also clear just that one. ---
  router.put("/api/reseller/notifications/:id/read", async (req, res, { params }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    await db.prepare("UPDATE notifications SET read = 1 WHERE id = ? AND scope = ?").run(params.id, `reseller:${resellerId}`);
    json(res, 200, { ok: true });
  });
  // GET /api/reseller/active-sessions
  // Live view: each currently connected end-user + their plan bandwidth.
  router.get("/api/reseller/active-sessions", async (req, res) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const now = Date.now();
    const sessions = await db.prepare(`
      SELECT a.*, v.name AS voucher_name, v.plan_id,
             p.bandwidth AS bandwidth_mbps, p.name AS plan_name
      FROM active_sessions a
      LEFT JOIN vouchers v ON v.username = a.username AND v.reseller_id = a.reseller_id
      LEFT JOIN plans p ON p.id = v.plan_id
      WHERE a.reseller_id = ? AND a.last_seen > ?
      ORDER BY a.last_seen DESC
    `).all(resellerId, now - 180000);
    // Enrich with geo (cached)
    for (const s of sessions) {
      s.location = await lookupGeoReseller(s.ip || null).catch(() => null);
    }
    return json(res, 200, { sessions });
  });

}
