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

export function registerSuperAdminRoutes(router) {
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
    if (typeof body.price !== "number") return json(res, 400, { error: "price must be a number" });
    const result = await db.prepare("UPDATE platform_plans SET price = ? WHERE id = ?").run(body.price, params.id);
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
      "Content-Disposition": `attachment; filename="reslink-keys-${batchLabel || "all"}-${status}.txt"`,
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
}
