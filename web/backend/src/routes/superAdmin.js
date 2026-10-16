import { db, id, genCode } from "../db.js";
import { json } from "../http.js";
import { authenticate } from "../auth.js";
import { effectiveRouterStatus } from "./router.js";
import { saveUpload } from "../uploads.js";

function requireSuperAdmin(req, res) {
  const auth = authenticate(req, "super_admin");
  if (!auth.ok) { json(res, auth.status, { error: auth.error }); return null; }
  return auth.user;
}

// Kept in sync with the same sets in routes/reseller.js and
// frontend/src/ui.jsx + frontend/src/i18n.js.
const CURRENCIES = new Set(["USD", "NGN", "KES", "UGX", "GHS", "ZAR", "TZS", "XOF", "EUR", "GBP"]);
const LANGUAGES = new Set(["en", "fr", "sw", "ha", "yo", "pt"]);


// ───────────────────────────────────────────────────────────────
// IP geolocation (via free ip-api.com, backend-only — no HTTPS needed
// because we call it server-side, not from the browser).
// Caches every lookup in geo_cache for 24h to stay within the 45 req/min
// rate limit even with busy routers.
// ───────────────────────────────────────────────────────────────
async function lookupGeo(ip) {
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

export function registerSuperAdminRoutes(router) {
  // ── License plans CRUD — Super Admin manages tier features + limits ──
  router.get("/api/admin/plans", async (req, res) => {
    const rows = await db.prepare("SELECT * FROM platform_plans ORDER BY id ASC").all();
    return json(res, 200, {
      plans: rows.map(r => ({
        ...r,
        price: r.monthly_price_ngn,
        maxClients: r.max_clients,
        maxDevicesPerClient: r.max_devices ?? r.max_devices_per_client,
        maxRouters: r.max_routers,
        maxVouchers: r.max_vouchers,
        bandwidthCapMbps: r.bandwidth_cap_mbps,
        features: r.features || {},
      })),
    });
  });

  router.put("/api/admin/plans/:id", async (req, res, { params, body }) => {
    const b = body || {};
    try {
      await db.prepare(`UPDATE platform_plans SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
            max_devices = COALESCE(?, max_devices),
        max_clients = COALESCE(?, max_clients),
        max_routers = COALESCE(?, max_routers),
        max_vouchers = COALESCE(?, max_vouchers),
        bandwidth_cap_mbps = COALESCE(?, bandwidth_cap_mbps),
        features = COALESCE(?::jsonb, features)
        WHERE id = ?`).run(
        b.name || null, b.description || null,
        b.maxDevices == null ? null : Number(b.maxDevices),
        b.maxClients == null ? null : Number(b.maxClients),
        b.maxRouters == null ? null : Number(b.maxRouters),
        b.maxVouchers == null ? null : Number(b.maxVouchers),
        b.bandwidthCapMbps == null ? null : Number(b.bandwidthCapMbps),
        b.features ? JSON.stringify(b.features) : null,
        params.id);
      return json(res, 200, { ok: true });
    } catch (e) {
      console.error('[admin/plans PUT] update failed:', e && e.message, e);
      return json(res, 500, { error: String((e && e.message) || e) });
    }
  });

  router.post("/api/admin/plans", async (req, res, { body }) => {
    const b = body || {};
    if (!b.id || !b.name) return json(res, 400, { error: "id and name required" });
    await db.prepare(`INSERT INTO platform_plans (id, name, description, monthly_price_ngn, yearly_price_ngn, max_devices, max_clients, max_routers, max_vouchers, bandwidth_cap_mbps, features)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      b.id, b.name, b.description || "",
      Number(b.monthlyPriceNgn || 0), Number(b.yearlyPriceNgn || 0),
      Number(b.maxDevices || 5), Number(b.maxClients || 100), Number(b.maxRouters || 1),
      Number(b.maxVouchers || 200), Number(b.bandwidthCapMbps || 50),
      JSON.stringify(b.features || {}));
    return json(res, 201, { ok: true, id: b.id });
  });

  // Reseller license usage vs their plan limits
  router.get("/api/reseller/license-usage", async (req, res) => {
    const auth = authenticate(req, "reseller");
    if (!auth.ok) return json(res, auth.status, { error: auth.error });
    const rid = auth.user.id || auth.user.sub;
    const r = await db.prepare("SELECT subscription_plan FROM resellers WHERE id = ?").get(rid);
    if (!r) return json(res, 404, { error: "reseller not found" });
    const plan = await db.prepare("SELECT * FROM platform_plans WHERE id = ?").get(r.subscription_plan);
    const used = {};
    used.vouchers = (await db.prepare("SELECT COUNT(*) AS c FROM vouchers WHERE reseller_id = ?").get(rid)).c;
    used.routers = (await db.prepare("SELECT COUNT(*) AS c FROM routers WHERE reseller_id = ?").get(rid)).c;
    used.clients = (await db.prepare("SELECT COUNT(*) AS c FROM active_sessions WHERE reseller_id = ?").get(rid)).c;
    return json(res, 200, {
      plan: plan ? {
        id: plan.id, name: plan.name, description: plan.description || "",
        maxDevices: plan.max_devices, maxClients: plan.max_clients, maxRouters: plan.max_routers,
        maxVouchers: plan.max_vouchers, bandwidthCapMbps: plan.bandwidth_cap_mbps,
        features: plan.features || {},
      } : null,
      used,
    });
  });

  // GET /api/admin/routers/live — per-router metrics + connection status
  router.get("/api/admin/routers/live", async (req, res) => {
    const rows = await db.prepare(`
      SELECT r.router_id, r.reseller_id, r.model, r.firmware, r.last_check_in, r.status,
             m.cpu_load, m.ram_used, m.ram_total, m.uptime_seconds, m.active_user_count, m.updated_at,
             rs.company_name AS reseller_name
      FROM routers r
      LEFT JOIN router_metrics m ON m.router_id = r.router_id
      LEFT JOIN resellers rs ON rs.id = r.reseller_id
      ORDER BY r.last_check_in DESC NULLS LAST
      LIMIT 200
    `).all();
    const now = Date.now();
    return json(res, 200, rows.map(row => ({
      routerId: row.router_id,
      resellerId: row.reseller_id,
      resellerName: row.reseller_name || null,
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

  router.get("/api/admin/resellers", async (req, res) => {
    if (!requireSuperAdmin(req, res)) return;
    const rows = await db.prepare("SELECT * FROM resellers").all();
    const resellers = [];
    for (const r of rows) {
      const voucherCount = await db.prepare("SELECT COUNT(*) AS n FROM vouchers WHERE reseller_id = ?").get(r.id);
      resellers.push({
        id: r.id, companyName: r.company_name, email: r.email, licenseKey: r.license_key,
        status: r.status, subscriptionPlan: r.subscription_plan, subscriptionExpiry: r.subscription_expiry,
        voucherCount: Number(voucherCount.n),
      });
    }
    json(res, 200, { resellers });
  });

  router.put("/api/admin/resellers/:id/status", async (req, res, { params, body }) => {
    if (!requireSuperAdmin(req, res)) return;
    if (!["active", "suspended"].includes(body.status)) return json(res, 400, { error: "status must be active or suspended" });
    const result = await db.prepare("UPDATE resellers SET status = ? WHERE id = ?").run(body.status, params.id);
    if (result.changes === 0) return json(res, 404, { error: "Reseller not found" });
    json(res, 200, { ok: true });
  });

  router.get("/api/admin/platform-plans", async (req, res) => {
    if (!requireSuperAdmin(req, res)) return;
    const plans = await db.prepare("SELECT * FROM platform_plans").all();
    json(res, 200, { plans });
  });

  router.put("/api/admin/platform-plans/:id", async (req, res, { params, body }) => {
    if (!requireSuperAdmin(req, res)) return;

    // Accept any subset of editable fields. Each is validated
    // individually; invalid fields are silently ignored (client
    // would not normally send garbage).
    const updates = [];
    const vals = [];

    if (typeof body.name === "string" && body.name.trim()) {
      updates.push("name = ?"); vals.push(body.name.trim());
    }
    if (typeof body.price === "number" && body.price >= 0) {
      updates.push("price = ?"); vals.push(body.price);
    }
    if (typeof body.pool_start === "string" && body.pool_start.trim()) {
      updates.push("pool_start = ?"); vals.push(body.pool_start.trim());
    }
    if (typeof body.pool_end === "string" && body.pool_end.trim()) {
      updates.push("pool_end = ?"); vals.push(body.pool_end.trim());
    }
    if (typeof body.bandwidth_percent === "number" && body.bandwidth_percent >= 1 && body.bandwidth_percent <= 100) {
      updates.push("bandwidth_percent = ?"); vals.push(Math.round(body.bandwidth_percent));
      // Recompute the denormalized Mbps value from the platform-wide uplink.
      // 100 Mbps baseline is a documented constant; the installer reads
      // bandwidth_mbps_per_user directly to configure the router hotspot.
      const TOTAL_BANDWIDTH_MBPS = 100;
      const mbps = Math.max(1, Math.round(TOTAL_BANDWIDTH_MBPS * body.bandwidth_percent / 100));
      updates.push("bandwidth_mbps_per_user = ?"); vals.push(mbps);
    }

    if (updates.length === 0) return json(res, 400, { error: "No valid fields to update" });

    vals.push(params.id);
    const result = await db.prepare(
      `UPDATE platform_plans SET ${updates.join(", ")} WHERE id = ?`
    ).run(...vals);

    if (result.changes === 0) return json(res, 404, { error: "Plan not found" });
    json(res, 200, { ok: true });
  });

  router.get("/api/admin/installations", async (req, res) => {
    if (!requireSuperAdmin(req, res)) return;
    const rows = await db.prepare(`
      SELECT i.*, r.company_name FROM installations i
      JOIN resellers r ON r.id = i.reseller_id
      ORDER BY i.time DESC
    `).all();
    json(res, 200, { installations: rows });
  });

  // Global active sessions across every reseller
  router.get("/api/admin/sessions", async (req, res) => {
    if (!requireSuperAdmin(req, res)) return;
    const rows = await db.prepare(`
      SELECT s.*, v.username, r.company_name FROM sessions s
      JOIN vouchers v ON v.id = s.voucher_id
      JOIN resellers r ON r.id = v.reseller_id
      ORDER BY s.connected_at DESC
    `).all();
    json(res, 200, { sessions: rows });
  });

  // System monitoring — mock health figures alongside real router-fleet data
  router.get("/api/admin/monitoring", async (req, res) => {
    if (!requireSuperAdmin(req, res)) return;
    const routersRaw = await db.prepare("SELECT r.*, rs.company_name FROM routers r JOIN resellers rs ON rs.id = r.reseller_id").all();
    const routers = routersRaw.map((r) => ({ ...r, status: effectiveRouterStatus(r.last_check_in) }));
    const online = routers.filter((r) => r.status === "online").length;
    const failedDeliveriesRow = await db.prepare("SELECT COUNT(*) AS n FROM delivery_logs WHERE status = 'failed'").get();
    const pendingCommandsRow = await db.prepare("SELECT COUNT(*) AS n FROM router_commands WHERE status = 'pending'").get();
    json(res, 200, {
      apiHealth: "operational",
      routerUptimePct: routers.length ? Math.round((online / routers.length) * 1000) / 10 : 100,
      onlineRouters: online,
      totalRouters: routers.length,
      deliveryQueuePending: Number(failedDeliveriesRow.n),
      commandQueuePending: Number(pendingCommandsRow.n),
      avgApiResponseMs: 118,
      routers,
    });
  });

  // --- License payment confirmations (reseller -> platform, manual transfer) ---
  router.get("/api/admin/license-payments", async (req, res) => {
    if (!requireSuperAdmin(req, res)) return;
    const rows = await db.prepare(`
      SELECT lp.*, r.company_name, pp.name AS plan_name FROM license_payment_requests lp
      JOIN resellers r ON r.id = lp.reseller_id
      JOIN platform_plans pp ON pp.id = lp.plan_id
      ORDER BY lp.time DESC
    `).all();
    json(res, 200, { licensePayments: rows });
  });

  router.put("/api/admin/license-payments/:id", async (req, res, { params, body }) => {
    if (!requireSuperAdmin(req, res)) return;
    if (!["confirmed", "rejected"].includes(body.decision)) return json(res, 400, { error: "decision must be confirmed or rejected" });

    const reqRow = await db.prepare("SELECT * FROM license_payment_requests WHERE id = ?").get(params.id);
    if (!reqRow) return json(res, 404, { error: "License payment request not found" });
    if (reqRow.status !== "pending") return json(res, 409, { error: `Already ${reqRow.status}` });

    const now = Date.now();
    await db.prepare("UPDATE license_payment_requests SET status = ?, decided_at = ? WHERE id = ?").run(body.decision, now, params.id);

    if (body.decision === "confirmed") {
      await db.prepare("UPDATE resellers SET status = 'active', subscription_plan = ?, subscription_expiry = ? WHERE id = ?")
        .run(reqRow.plan_id, now + 30 * 86400000, reqRow.reseller_id);
      await db.prepare("INSERT INTO payments (id,user_type,user_id,amount,method,status,time,note) VALUES (?,?,?,?,?,?,?,?)")
        .run(id("pay"), "reseller", reqRow.reseller_id, reqRow.amount, reqRow.method, "completed", now, "License renewal");
      return json(res, 200, { ok: true, subscriptionExpiry: now + 30 * 86400000 });
    }
    json(res, 200, { ok: true });
  });

  // --- Referrals: platform-wide view of every reseller's invites.
  // Marking a bonus paid is the only write here — same manual-by-hand
  // pattern as license payments (see above): Super Admin actually sends
  // the money outside this system, then records that it happened.
  router.get("/api/admin/referrals", async (req, res) => {
    if (!requireSuperAdmin(req, res)) return;
    const rows = await db.prepare(`
      SELECT ref.*, r.company_name AS referrer_company_name, r.email AS referrer_email,
        rd.company_name AS referred_company_name
      FROM referrals ref
      JOIN resellers r ON r.id = ref.referrer_reseller_id
      LEFT JOIN resellers rd ON rd.id = ref.referred_reseller_id
      ORDER BY ref.created_at DESC
    `).all();
    const summary = {
      invited: rows.filter((r) => r.status === "invited").length,
      signedUp: rows.filter((r) => r.status === "signed_up").length,
      bonusPaid: rows.filter((r) => r.status === "bonus_paid").length,
      flagged: rows.filter((r) => r.status === "flagged").length,
      totalPending: rows.filter((r) => r.status === "signed_up").reduce((sum, r) => sum + Number(r.bonus_amount), 0),
      totalPaidOut: rows.filter((r) => r.status === "bonus_paid").reduce((sum, r) => sum + Number(r.bonus_amount), 0),
    };
    json(res, 200, { referrals: rows, summary });
  });

  // Lets Super Admin adjust a single referral's bonus up or down before
  // paying it — e.g. a manually-negotiated amount for a particularly
  // valuable referral. Only while still 'signed_up': once
  // mark-paid records the payout amount into the payments ledger, the
  // number needs to stay fixed to match what was actually sent.
  router.put("/api/admin/referrals/:id", async (req, res, { params, body }) => {
    if (!requireSuperAdmin(req, res)) return;
    const { bonusAmount } = body;
    if (typeof bonusAmount !== "number" || bonusAmount < 0) return json(res, 400, { error: "bonusAmount must be a non-negative number" });
    const ref = await db.prepare("SELECT status FROM referrals WHERE id = ?").get(params.id);
    if (!ref) return json(res, 404, { error: "Referral not found" });
    if (ref.status === "bonus_paid") return json(res, 409, { error: "Already paid out — the amount is locked to what was actually sent" });
    await db.prepare("UPDATE referrals SET bonus_amount = ? WHERE id = ?").run(bonusAmount, params.id);
    json(res, 200, { ok: true });
  });

  router.put("/api/admin/referrals/:id/mark-paid", async (req, res, { params }) => {
    if (!requireSuperAdmin(req, res)) return;
    const ref = await db.prepare("SELECT * FROM referrals WHERE id = ?").get(params.id);
    if (!ref) return json(res, 404, { error: "Referral not found" });
    if (ref.status === "flagged") return json(res, 409, { error: "This referral is flagged as a likely self-referral and can't be paid out — review it manually first" });
    if (ref.status !== "signed_up") return json(res, 409, { error: "Only a referral whose referred reseller has already signed up can be marked paid" });

    const now = Date.now();
    await db.prepare("UPDATE referrals SET status = 'bonus_paid', paid_at = ? WHERE id = ?").run(now, params.id);
    await db.prepare("INSERT INTO payments (id,user_type,user_id,amount,method,status,time,note) VALUES (?,?,?,?,?,?,?,?)")
      .run(id("pay"), "reseller", ref.referrer_reseller_id, ref.bonus_amount, "Manual", "completed", now, "Referral bonus");
    await db.prepare("INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)")
      .run(id("n"), `reseller:${ref.referrer_reseller_id}`, "referral", "Referral bonus paid",
        `Your referral bonus for ${ref.name || ref.email || "your referral"} has been marked as paid.`, now, 0, "referrals");
    json(res, 200, { ok: true });
  });

  // --- Product keys: offline/manual activation, independent of the
  // bank-transfer-then-confirm license flow above. Super Admin
  // generates a batch here, hands the codes out through whatever
  // channel fits (this is aimed squarely at non-internet-facing
  // deployments), and a reseller redeems one themselves for instant
  // activation — see POST /api/reseller/product-key/redeem in
  // routes/reseller.js. The vetting happens BEFORE generation (Super
  // Admin only generates keys for payments they've already received),
  // not after, which is the inverse of the license-payment-request
  // flow and the whole point of this feature.
  function formatKeyCode(raw) {
    // genCode's alphabet already excludes visually-ambiguous
    // characters (0/O, 1/l/I) — see db.js — which matters more here
    // than almost anywhere else in this app: these get read aloud
    // over a phone or typed off a printed card, not copy-pasted.
    // Uppercased for the same reason referral codes and pairing codes
    // are (see routes/auth.js, routes/reseller.js) — genCode's
    // alphabet is mixed-case by default, and the redeem endpoint
    // below normalizes whatever the reseller types to uppercase
    // before comparing, so the stored key MUST be uppercase too or
    // no key would ever match.
    return raw.toUpperCase().match(/.{1,4}/g).join("-");
  }

  router.post("/api/admin/product-keys/generate", async (req, res, { body }) => {
    if (!requireSuperAdmin(req, res)) return;
    const { count, planId, durationDays, batchLabel } = body;
    if (!Number.isInteger(count) || count < 1 || count > 5000) {
      return json(res, 400, { error: "count must be an integer between 1 and 5000 (generate in multiple batches for more)" });
    }
    const plan = await db.prepare("SELECT id FROM platform_plans WHERE id = ?").get(planId);
    if (!plan) return json(res, 404, { error: "Platform plan not found" });
    const days = Number.isInteger(durationDays) && durationDays > 0 ? durationDays : 30;

    const now = Date.now();
    const label = (batchLabel && batchLabel.trim()) || `${new Date(now).toISOString().slice(0, 10)} batch`;
    const keys = [];
    // Uniqueness is enforced by the DB's UNIQUE constraint on key_code;
    // a collision is astronomically unlikely at this alphabet/length
    // (a few dozen bits of entropy per key) but retried defensively
    // rather than assumed away.
    for (let i = 0; i < count; i++) {
      let inserted = false;
      for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
        const code = formatKeyCode(genCode(16));
        try {
          await db.prepare("INSERT INTO product_keys (id,key_code,plan_id,duration_days,batch_label,status,created_at) VALUES (?,?,?,?,?,?,?)")
            .run(id("pk"), code, planId, days, label, "unused", now);
          keys.push(code);
          inserted = true;
        } catch {
          // UNIQUE violation on key_code — retry with a fresh code.
        }
      }
      if (!inserted) return json(res, 500, { error: `Could not generate a unique key after several attempts (generated ${i} of ${count} so far) — try again` });
    }
    json(res, 201, { batchLabel: label, count: keys.length, keys });
  });

  router.get("/api/admin/product-keys/summary", async (req, res) => {
    if (!requireSuperAdmin(req, res)) return;
    const rows = await db.prepare(`
      SELECT batch_label,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'unused') AS unused,
        COUNT(*) FILTER (WHERE status = 'used') AS used,
        COUNT(*) FILTER (WHERE status = 'revoked') AS revoked,
        MIN(created_at) AS created_at
      FROM product_keys GROUP BY batch_label ORDER BY MIN(created_at) DESC
    `).all();
    json(res, 200, { batches: rows });
  });

  router.get("/api/admin/product-keys", async (req, res, { query }) => {
    if (!requireSuperAdmin(req, res)) return;
    const status = ["unused", "used", "revoked"].includes(query?.status) ? query.status : null;
    const batchLabel = query?.batchLabel || null;
    const limit = Math.min(Number(query?.limit) || 500, 2000);
    const rows = await db.prepare(`
      SELECT pk.*, pp.name AS plan_name, r.company_name AS used_by_company
      FROM product_keys pk
      JOIN platform_plans pp ON pp.id = pk.plan_id
      LEFT JOIN resellers r ON r.id = pk.used_by_reseller_id
      WHERE (?::text IS NULL OR pk.status = ?) AND (?::text IS NULL OR pk.batch_label = ?)
      ORDER BY pk.created_at DESC LIMIT ?
    `).all(status, status, batchLabel, batchLabel, limit);
    json(res, 200, { keys: rows });
  });

  // Plain-text export, one key per line — meant to be copy-pasted into
  // whatever the actual distribution channel is (a print layout, a
  // spreadsheet, individual messages), not consumed by this app again.
  router.get("/api/admin/product-keys/export", async (req, res, { query }) => {
    if (!requireSuperAdmin(req, res)) return;
    const status = ["unused", "used", "revoked"].includes(query?.status) ? query.status : "unused";
    const batchLabel = query?.batchLabel || null;
    const rows = await db.prepare(`
      SELECT key_code FROM product_keys
      WHERE status = ? AND (?::text IS NULL OR batch_label = ?)
      ORDER BY created_at ASC
    `).all(status, batchLabel, batchLabel);
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="SAFELINKS-keys-${batchLabel || "all"}-${status}.txt"`,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    });
    res.end(rows.map((r) => r.key_code).join("\n"));
  });

  router.put("/api/admin/product-keys/:id/revoke", async (req, res, { params }) => {
    if (!requireSuperAdmin(req, res)) return;
    const result = await db.prepare("UPDATE product_keys SET status = 'revoked' WHERE id = ? AND status = 'unused'").run(params.id);
    if (result.changes === 0) return json(res, 409, { error: "Only an unused key can be revoked — it may already be used or revoked" });
    json(res, 200, { ok: true });
  });

  // Bulk revoke — e.g. a whole printed batch of cards got lost or a
  // batch was generated by mistake. Only touches still-unused keys in
  // that batch; anything already redeemed stays redeemed.
  router.put("/api/admin/product-keys/revoke-batch", async (req, res, { body }) => {
    if (!requireSuperAdmin(req, res)) return;
    if (!body.batchLabel) return json(res, 400, { error: "batchLabel is required" });
    const result = await db.prepare("UPDATE product_keys SET status = 'revoked' WHERE batch_label = ? AND status = 'unused'").run(body.batchLabel);
    json(res, 200, { ok: true, revoked: result.changes });
  });

  // --- Settings: a plain manual contact email + WhatsApp number, plus
  // platform bank info. There is no automated sending anywhere in this
  // system — a reseller (or an end-user the reseller forwards to) reaches
  // this address/number by hand when they need the platform.
  router.get("/api/admin/settings", async (req, res) => {
    if (!requireSuperAdmin(req, res)) return;
    const settings = await db.prepare("SELECT * FROM integration_settings WHERE id = 'singleton'").get();
    const bank = await db.prepare("SELECT bank_name, bank_account_name, bank_account_number, ussd_code FROM super_admins LIMIT 1").get();
    json(res, 200, { ...settings, ...bank });
  });

  router.put("/api/admin/settings", async (req, res, { body }) => {
    if (!requireSuperAdmin(req, res)) return;
    const { contactEmail, contactWhatsapp, bankName, bankAccountName, bankAccountNumber, ussdCode, platformCurrency, dashboardLanguage, referralBonusAmount } = body;
    if (platformCurrency !== undefined && !CURRENCIES.has(platformCurrency)) {
      return json(res, 400, { error: `platformCurrency must be one of: ${[...CURRENCIES].join(", ")}` });
    }
    if (dashboardLanguage !== undefined && !LANGUAGES.has(dashboardLanguage)) {
      return json(res, 400, { error: `dashboardLanguage must be one of: ${[...LANGUAGES].join(", ")}` });
    }
    if (referralBonusAmount !== undefined && (typeof referralBonusAmount !== "number" || referralBonusAmount < 0)) {
      return json(res, 400, { error: "referralBonusAmount must be a non-negative number" });
    }
    await db.prepare(`UPDATE integration_settings SET
        contact_email = COALESCE(?, contact_email),
        contact_whatsapp = COALESCE(?, contact_whatsapp),
        platform_currency = COALESCE(?, platform_currency),
        dashboard_language = COALESCE(?, dashboard_language),
        referral_bonus_amount = COALESCE(?, referral_bonus_amount),
        updated_at = ?
      WHERE id = 'singleton'`)
      .run(contactEmail, contactWhatsapp, platformCurrency, dashboardLanguage, referralBonusAmount, Date.now());

    if (bankName || bankAccountName || bankAccountNumber || ussdCode) {
      // Scoped to the single super_admins row (there's exactly one) so
      // this can never silently touch more rows than intended.
      const sa = await db.prepare("SELECT id FROM super_admins LIMIT 1").get();
      if (sa) {
        await db.prepare(`UPDATE super_admins SET
            bank_name = COALESCE(?, bank_name),
            bank_account_name = COALESCE(?, bank_account_name),
            bank_account_number = COALESCE(?, bank_account_number),
            ussd_code = COALESCE(?, ussd_code)
          WHERE id = ?`)
          .run(bankName, bankAccountName, bankAccountNumber, ussdCode, sa.id);
      }
    }
    json(res, 200, { ok: true });
  });

  async function attachMessages(tickets) {
    if (tickets.length === 0) return tickets;
    const ids = tickets.map((t) => t.id);
    const placeholders = ids.map(() => "?").join(",");
    const messages = await db.prepare(`SELECT * FROM support_messages WHERE ticket_id IN (${placeholders}) ORDER BY time ASC`).all(...ids);
    const byTicket = {};
    for (const m of messages) (byTicket[m.ticket_id] ||= []).push(m);
    return tickets.map((t) => ({ ...t, messages: byTicket[t.id] || [] }));
  }

  router.get("/api/admin/support", async (req, res) => {
    if (!requireSuperAdmin(req, res)) return;
    const rows = await db.prepare(`
      SELECT t.*, r.company_name, r.email AS reseller_email, r.contact_whatsapp AS reseller_whatsapp
      FROM support_tickets t
      JOIN resellers r ON r.id = t.reseller_id
      WHERE t.source = 'reseller'
      ORDER BY t.time DESC
    `).all();
    json(res, 200, { tickets: await attachMessages(rows) });
  });

  // Sending a message never changes status on its own — that was the
  // bug (reply == resolve, in one step, with no way to keep talking).
  // Status now only moves via the dedicated .../status endpoint below.
  router.post("/api/admin/support/:id/messages", async (req, res, { params, body }) => {
    if (!requireSuperAdmin(req, res)) return;
    if (!body.message && !body.attachmentUrl) return json(res, 400, { error: "Enter a message or attach a file/voice note" });
    const ticket = await db.prepare("SELECT id FROM support_tickets WHERE id = ? AND source = 'reseller'").get(params.id);
    if (!ticket) return json(res, 404, { error: "Ticket not found" });
    await db.prepare("INSERT INTO support_messages (id,ticket_id,sender,message,time,attachment_url) VALUES (?,?,?,?,?,?)")
      .run(id("m"), params.id, "admin", body.message || "", Date.now(), body.attachmentUrl || null);
    json(res, 201, { ok: true });
  });

  // POST /api/admin/support/upload — a photo, PDF, or voice note to
  // attach to a reply on a reseller's support ticket (see
  // POST /:id/messages above, `attachmentUrl`). Same storage/validation
  // as the reseller- and portal-side upload endpoints.
  router.post("/api/admin/support/upload", async (req, res, { body }) => {
    if (!requireSuperAdmin(req, res)) return;
    try {
      const result = await saveUpload(body);
      json(res, 201, result);
    } catch (err) {
      json(res, 400, { error: err.message || "Upload failed" });
    }
  });

  router.put("/api/admin/support/:id/status", async (req, res, { params, body }) => {
    if (!requireSuperAdmin(req, res)) return;
    if (!["open", "resolved"].includes(body.status)) return json(res, 400, { error: "status must be 'open' or 'resolved'" });
    const result = await db.prepare("UPDATE support_tickets SET status = ? WHERE id = ? AND source = 'reseller'").run(body.status, params.id);
    if (result.changes === 0) return json(res, 404, { error: "Ticket not found" });
    json(res, 200, { ok: true });
  });

  router.get("/api/admin/notifications", async (req, res) => {
    if (!requireSuperAdmin(req, res)) return;
    const rows = await db.prepare("SELECT * FROM notifications WHERE scope = 'super_admin' ORDER BY time DESC").all();
    json(res, 200, { notifications: rows });
  });

  router.put("/api/admin/notifications/read-all", async (req, res) => {
    if (!requireSuperAdmin(req, res)) return;
    await db.prepare("UPDATE notifications SET read = 1 WHERE scope = 'super_admin'").run();
    json(res, 200, { ok: true });
  });

  router.put("/api/admin/notifications/:id/read", async (req, res, { params }) => {
    if (!requireSuperAdmin(req, res)) return;
    await db.prepare("UPDATE notifications SET read = 1 WHERE id = ? AND scope = 'super_admin'").run(params.id);
    json(res, 200, { ok: true });
  });
  // GET /api/admin/active-sessions
  // Live view: each reseller with their connected routers, current user
  // counts, last IP + location (if we've seen their requests recently),
  // and the router hardware health.
  router.get("/api/admin/active-sessions", async (req, res) => {
    if (!requireSuperAdmin(req, res)) return;
    const now = Date.now();
    const ONLINE_MS = 90000;

    const rows = await db.prepare(`
      SELECT r.id AS reseller_id, r.company_name, r.email,
             rt.router_id, rt.model, rt.firmware, rt.last_check_in,
             rm.cpu_load, rm.ram_used, rm.ram_total, rm.uptime_seconds, rm.updated_at,
             (SELECT COUNT(*) FROM active_sessions a WHERE a.reseller_id = r.id) AS user_count
      FROM resellers r
      LEFT JOIN routers rt ON rt.reseller_id = r.id
      LEFT JOIN router_metrics rm ON rm.router_id = rt.router_id
      WHERE rt.router_id IS NOT NULL
      ORDER BY rm.updated_at DESC NULLS LAST
    `).all();

    const sessions = rows.map((row) => {
      const online = row.last_check_in && (now - row.last_check_in) < ONLINE_MS;
      const ramPct = row.ram_total ? Math.round(100 * Number(row.ram_used) / Number(row.ram_total)) : null;
      const uptimeDays = row.uptime_seconds ? Math.floor(Number(row.uptime_seconds) / 86400) : null;
      return {
        resellerId: row.reseller_id,
        resellerName: row.company_name || row.email,
        routerId: row.router_id,
        routerModel: row.model || "unknown",
        routerFirmware: row.firmware || "",
        online,
        lastCheckIn: row.last_check_in,
        cpuLoad: row.cpu_load,
        ramPct,
        uptimeDays,
        activeUsers: Number(row.user_count || 0),
      };
    });

    // Backend health from api_stats (last 5 min)
    const win = await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_calls),0) AS calls, COALESCE(SUM(error_calls),0) AS errs, COALESCE(MAX(max_ms),0) AS p99 FROM api_stats WHERE window_start > ?`).get(now - 5 * 60 * 1000);

    // Enrich each row with geo (cached; safe for private IPs)
    for (const s of sessions) {
      s.location = await lookupGeo(s.resellerIp || null).catch(() => null);
    }
    return json(res, 200, {
      sessions,
      backend: {
        calls: Number(win.calls || 0),
        errors: Number(win.errs || 0),
        errorRate: win.calls ? (Number(win.errs) / Number(win.calls)) : 0,
        p99Ms: Number(win.p99 || 0),
      },
    });
  });

}
