import { db, id, genCode } from "../db.js";
import { json } from "../http.js";
import { authenticate, hashPassword } from "../auth.js";
import { enqueueCommandForReseller, effectiveRouterStatus } from "./router.js";
import { rateLimitByKey } from "../rateLimit.js";
import { saveUpload } from "../uploads.js";

// Every handler below scopes its query by `resellerId` taken from the
// verified JWT — never from a URL param or request body. That's the
// actual RBAC boundary a demo UI can't enforce on its own: a reseller
// literally cannot construct a request that reads another reseller's
// row, because the WHERE clause never sees anything the client sent.
function requireReseller(req, res) {
  const auth = authenticate(req, "reseller");
  if (!auth.ok) { json(res, auth.status, { error: auth.error }); return null; }
  return auth.user.resellerId;
}

// Kept in sync with CURRENCIES/LANGUAGES in frontend/src/ui.jsx and
// frontend/src/i18n.js — validated server-side too since the portal
// info endpoint is public and a bad value here would break the
// end-user Captive Portal, not just the reseller's own dashboard.
const CURRENCIES = new Set(["USD", "NGN", "KES", "UGX", "GHS", "ZAR", "TZS", "XOF", "EUR", "GBP"]);
const LANGUAGES = new Set(["en", "fr", "sw", "ha", "yo", "pt"]);

export function registerResellerRoutes(router) {
  // --- Vouchers ---
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
  router.get("/api/reseller/routers", async (req, res) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const rows = await db.prepare("SELECT * FROM routers WHERE reseller_id = ? ORDER BY last_check_in DESC").all(resellerId);
    const routers = [];
    for (const r of rows) {
      const pending = await db.prepare("SELECT COUNT(*) AS n FROM router_commands WHERE router_id = ? AND status = 'pending'").get(r.router_id);
      routers.push({
        ...r,
        status: effectiveRouterStatus(r.last_check_in), // recomputed, not just the stored value — see router.js
        pendingCommands: Number(pending.n),
      });
    }
    json(res, 200, { routers });
  });

  // Called by the installer app at the end of the 8-step wizard (Agent
  // Registration step). Generates the router's polling API key — shown
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
  // router's model/firmware/IP — the router reports those itself.
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
        `${reseller.company_name} completed a zero-touch installation (${routerId}) — now online.`, now, 0, "installs");

    // Sync every currently-active voucher onto the freshly provisioned
    // router so it's not starting from an empty user list.
    const activeVouchers = await db.prepare("SELECT username, password, plan_id FROM vouchers WHERE reseller_id = ? AND status = 'active'").all(resellerId);
    for (const v of activeVouchers) {
      const plan = await db.prepare("SELECT device_limit, bandwidth FROM plans WHERE id = ?").get(v.plan_id);
      await db.prepare("INSERT INTO router_commands (id, router_id, type, payload, status, created_at) VALUES (?,?,?,?,?,?)")
        .run(id("cmd"), routerId, "create_user", JSON.stringify({ username: v.username, password: v.password, deviceLimit: plan?.device_limit, bandwidthMbps: plan?.bandwidth }), "pending", now);
    }

    // apiKey is returned ONLY in this response — the server never
    // stores or returns the plaintext again after this.
    json(res, 201, { routerId, apiKey, status: "online", syncedVouchers: activeVouchers.length });
  });

  // Recent command history across all of this reseller's routers — an
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
    const { name, duration, price, deviceLimit, bandwidth, priority, popular } = body;
    if (!name || !duration || price == null) return json(res, 400, { error: "name, duration, and price are required" });
    if (typeof price !== "number" || !Number.isFinite(price) || price < 0) return json(res, 400, { error: "price must be a non-negative number" });
    if (deviceLimit != null && (typeof deviceLimit !== "number" || deviceLimit < 1)) return json(res, 400, { error: "deviceLimit must be at least 1" });
    const planId = id("p");
    await db.prepare("INSERT INTO plans (id,reseller_id,name,duration,price,device_limit,bandwidth,priority,popular,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(planId, resellerId, name, duration, price, deviceLimit || 1, bandwidth || 10, priority || "medium", popular ? 1 : 0, Date.now());
    json(res, 201, { id: planId });
  });

  router.put("/api/reseller/plans/:id", async (req, res, { params, body }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const { name, duration, price, deviceLimit, bandwidth, priority, popular } = body;
    if (!name || !duration || price == null) return json(res, 400, { error: "name, duration, and price are required" });
    if (typeof price !== "number" || !Number.isFinite(price) || price < 0) return json(res, 400, { error: "price must be a non-negative number" });
    if (deviceLimit != null && (typeof deviceLimit !== "number" || deviceLimit < 1)) return json(res, 400, { error: "deviceLimit must be at least 1" });
    const result = await db.prepare(`
      UPDATE plans SET name=?, duration=?, price=?, device_limit=?, bandwidth=?, priority=?, popular=?
      WHERE id = ? AND reseller_id = ?
    `).run(name, duration, price, deviceLimit, bandwidth, priority, popular ? 1 : 0, params.id, resellerId);
    if (result.changes === 0) return json(res, 404, { error: "Plan not found" });
    json(res, 200, { ok: true });
  });

  router.delete("/api/reseller/plans/:id", async (req, res, { params }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const result = await db.prepare("DELETE FROM plans WHERE id = ? AND reseller_id = ?").run(params.id, resellerId);
    if (result.changes === 0) return json(res, 404, { error: "Plan not found" });
    json(res, 200, { ok: true });
  });

  // --- Captive portal settings ---
  // contactEmail/contactWhatsapp are shown to end-users on the portal so
  // they have a manual way to reach the reseller (no automated
  // email/WhatsApp sending exists anywhere in this system).
  router.get("/api/reseller/portal-settings", async (req, res) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const r = await db.prepare("SELECT ssid, portal_title, color, currency, language, dashboard_language, contact_email, contact_whatsapp FROM resellers WHERE id = ?").get(resellerId);
    json(res, 200, r);
  });

  router.put("/api/reseller/portal-settings", async (req, res, { body }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const { ssid, portalTitle, color, currency, language, dashboardLanguage, contactEmail, contactWhatsapp } = body;
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
        contact_email = COALESCE(?, contact_email), contact_whatsapp = COALESCE(?, contact_whatsapp)
      WHERE id = ?`)
      .run(ssid, portalTitle, color, currency, language, dashboardLanguage, contactEmail, contactWhatsapp, resellerId);
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
      await db.prepare(`INSERT INTO vouchers (id,reseller_id,username,password,name,email,phone,business,plan_id,status,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(voucherId, resellerId, username, password, pending.name, pending.email, pending.phone, pending.business, pending.plan_id, "active", now, now + 7 * 86400000);
      await db.prepare("INSERT INTO delivery_logs (id,voucher_id,channel,status,time) VALUES (?,?,?,?,?)").run(id("dl"), voucherId, "email", "delivered", now);
      await db.prepare("INSERT INTO delivery_logs (id,voucher_id,channel,status,time) VALUES (?,?,?,?,?)").run(id("dl"), voucherId, "whatsapp", "delivered", now);
      await db.prepare("INSERT INTO payments (id,user_type,user_id,amount,method,status,time,note) VALUES (?,?,?,?,?,?,?,?)")
        .run(id("pay"), "voucher", voucherId, pending.amount, pending.method, "completed", now, "Voucher purchase");
      await enqueueCommandForReseller(resellerId, "create_user", { username, password, deviceLimit: plan?.device_limit, bandwidthMbps: plan?.bandwidth });
      return json(res, 200, { ok: true, voucher: { username, password } });
    }
    json(res, 200, { ok: true });
  });

  // --- Platform plan catalog (read-only — what Super Admin charges) ---
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

  // No payment gateway — the reseller transfers the license fee straight
  // to the Super Admin's bank account (see /platform-bank-info above)
  // and submits the receipt reference here. The license stays on its
  // current plan/expiry until Super Admin confirms it (see
  // routes/superAdmin.js PUT /api/admin/license-payments/:id).
  router.post("/api/reseller/license/renew", async (req, res, { body }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const { planId, method, reference, receiptUrl } = body;
    if (!reference) return json(res, 400, { error: "reference is required — this is a manual transfer, not a gateway payment" });
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
        `${reseller.company_name} submitted a transfer for the ${plan.name} plan (${plan.price} ${platformCurrency}) — ref: ${reference}.`, now, 0, "license");
    json(res, 202, { ok: true, status: "pending", requestId: reqId });
  });

  // POST /api/reseller/upload-receipt — a reseller attaches a photo of
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

  // Instant, self-serve activation — the counterpart to Super Admin's
  // /api/admin/product-keys/generate. No pending state, no waiting on
  // anyone: Super Admin already vetted the payment before ever
  // generating the key, so redeeming one here activates immediately.
  // Same 30/60/90-day-style expiry convention as a confirmed license
  // payment (routes/superAdmin.js PUT /api/admin/license-payments/:id)
  // — it SETS subscription_expiry to now+duration, it does not stack
  // on top of remaining time, so redeeming early "wastes" the
  // remainder of a still-active license the same way renewing early
  // already does elsewhere in this app.
  router.post("/api/reseller/product-key/redeem", async (req, res, { body }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const raw = (body.key || "").trim().toUpperCase();
    if (!raw) return json(res, 400, { error: "Enter a product key" });
    // Accept with or without dashes — someone reading a code off a
    // printed card or over the phone will not reliably reproduce
    // punctuation.
    const normalized = raw.replace(/[^A-Z0-9]/g, "");
    const grouped = normalized.match(/.{1,4}/g)?.join("-") || raw;

    if (await rateLimitByKey(res, `redeem-key:${resellerId}`, { max: 10, windowMs: 60 * 60000 })) return;

    const keyRow = await db.prepare("SELECT * FROM product_keys WHERE key_code = ?").get(grouped);
    if (!keyRow) return json(res, 404, { error: "That key wasn't found — check it and try again" });
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
  // — see routes/auth.js signup. Nothing pays out from here: bonus
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
    // or a runaway client script could still hammer this — cap it well
    // above any legitimate marketer's real usage.
    if (await rateLimitByKey(res, `referral-invite:${resellerId}`, { max: 20, windowMs: 60 * 60000 })) return;
    const { name, email, phone } = body;
    if (!email && !phone) return json(res, 400, { error: "Give at least an email or phone number to invite" });
    if (email) {
      const dupe = await db.prepare("SELECT id FROM referrals WHERE referrer_reseller_id = ? AND status = 'invited' AND lower(email) = lower(?)").get(resellerId, email);
      if (dupe) return json(res, 409, { error: "You've already invited that email and it's still pending — no need to add it again" });
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
    // Only an un-converted invite can be withdrawn — once someone has
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
  // is required — without it a reseller's "message Super Admin" inbox
  // would be polluted with their own customers' tickets, and vice versa.
  //
  // Every ticket list below attaches its full message thread. Sending a
  // message (POST .../messages) NEVER changes status — that was the bug
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
    if (!body.message) return json(res, 400, { error: "message is required" });
    const ticket = await db.prepare("SELECT id FROM support_tickets WHERE id = ? AND reseller_id = ? AND source = 'reseller'").get(params.id, resellerId);
    if (!ticket) return json(res, 404, { error: "Ticket not found" });
    await db.prepare("INSERT INTO support_messages (id,ticket_id,sender,message,time,attachment_url) VALUES (?,?,?,?,?,?)")
      .run(id("m"), params.id, "reseller", body.message, Date.now(), body.attachmentUrl || null);
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

  // POST /api/reseller/support/upload — a photo, PDF, or voice note to
  // attach to a support ticket/message, on either the reseller<->Super
  // Admin thread or the reseller<->customer thread below (same upload,
  // just re-used for both — pass the returned url as `attachmentUrl`).
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
  // automated email exists in this app — a reply here is just a note
  // the reseller writes for their own records; they reach the customer
  // directly using customer_email/customer_phone shown alongside it.
  router.get("/api/reseller/customer-support", async (req, res) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    const tickets = await db.prepare("SELECT * FROM support_tickets WHERE reseller_id = ? AND source = 'portal' ORDER BY time DESC").all(resellerId);
    json(res, 200, { tickets: await attachMessages(tickets) });
  });

  router.post("/api/reseller/customer-support/:id/messages", async (req, res, { params, body }) => {
    const resellerId = requireReseller(req, res); if (!resellerId) return;
    if (!body.message) return json(res, 400, { error: "message is required" });
    const ticket = await db.prepare("SELECT id FROM support_tickets WHERE id = ? AND reseller_id = ? AND source = 'portal'").get(params.id, resellerId);
    if (!ticket) return json(res, 404, { error: "Ticket not found" });
    await db.prepare("INSERT INTO support_messages (id,ticket_id,sender,message,time,attachment_url) VALUES (?,?,?,?,?,?)")
      .run(id("m"), params.id, "reseller", body.message, Date.now(), body.attachmentUrl || null);
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
}
