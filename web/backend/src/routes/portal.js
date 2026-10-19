import { db, id } from "../db.js";
import { json } from "../http.js";
import { rateLimitByIp } from "../rateLimit.js";
import { saveUpload } from "../uploads.js";

// No payment gateway integration by design: every voucher purchase is a
// manual transfer straight from the end-user's bank to the RESELLER's
// own account (or a USSD push), confirmed by the reseller against their
// account before a voucher is issued. There is no instant path.
const MANUAL_METHODS = new Set(["Bank Transfer", "USSD"]);

export function registerPortalRoutes(router) {
  // GET /api/portal/:resellerId/info â€” branding + where to pay
  router.get("/api/portal/:resellerId/info", async (req, res, { params }) => {
    const r = await db.prepare(`
      SELECT company_name, ssid, portal_title, color, currency, language, bank_name, bank_account_name, bank_account_number, ussd_code,
             contact_email, contact_whatsapp,
             logo_url, favicon_url, welcome_message, support_phone, terms_url, privacy_url, background_image_url
      FROM resellers WHERE id = ?
    `).get(params.resellerId);
    if (!r) return json(res, 404, { error: "Reseller not found" });
    json(res, 200, {
      companyName: r.company_name, ssid: r.ssid, portalTitle: r.portal_title, color: r.color,
      currency: r.currency || "USD", language: r.language || "en",
      bankAccount: { bankName: r.bank_name, accountName: r.bank_account_name, accountNumber: r.bank_account_number },
      bankName: r.bank_name,
      bankAccountName: r.bank_account_name,
      bankAccountNumber: r.bank_account_number,
      ussdCode: r.ussd_code,
      contactEmail: r.contact_email, contactWhatsapp: r.contact_whatsapp,
      logo_url: r.logo_url, logoUrl: r.logo_url,
      favicon_url: r.favicon_url, faviconUrl: r.favicon_url,
      welcome_message: r.welcome_message, welcomeMessage: r.welcome_message,
      support_phone: r.support_phone, supportPhone: r.support_phone,
      terms_url: r.terms_url, termsUrl: r.terms_url,
      privacy_url: r.privacy_url, privacyUrl: r.privacy_url,
      background_image_url: r.background_image_url, backgroundImageUrl: r.background_image_url,
    });
  });

  // GET /api/portal/:resellerId/status?mac=<MAC>
// Returns the voucher status for the given client MAC so the portal can
// auto-show the "access paused" card without needing ?suspended=1 in URL.
//   active | suspended | expired | none
router.get("/api/portal/:resellerId/status", async (req, res, { params }) => {
  const url = new URL(req.url, "http://x");
  const mac = String(url.searchParams.get("mac") || "").trim();
  if (!mac) return json(res, 400, { error: "mac required" });
  const rid = params.resellerId;
  let status = "none";
  try {
    const sess = await db.prepare(
      "SELECT username FROM active_sessions WHERE mac = ? AND reseller_id = ? ORDER BY last_seen DESC LIMIT 1"
    ).get(mac, rid);
    if (sess && sess.username) {
      const v = await db.prepare(
        "SELECT status, expires_at FROM vouchers WHERE username = ? AND reseller_id = ?"
      ).get(sess.username, rid);
      if (v) {
        const now = Date.now();
        const expired = v.expires_at && Number(v.expires_at) < now;
        if (v.status === "suspended") status = "suspended";
        else if (expired) status = "expired";
        else if (v.status === "active") status = "active";
      }
    }
  } catch (e) {
    console.log("[portal/status] error rid=" + rid + " mac=" + mac + ": " + (e && e.message));
  }
  console.log("[portal/status] rid=" + rid + " mac=" + mac + " -> " + status);
  return json(res, 200, { status });
});

// GET /api/portal/:resellerId/plans
  router.get("/api/portal/:resellerId/plans", async (req, res, { params }) => {
    const plans = await db.prepare("SELECT * FROM plans WHERE reseller_id = ? ORDER BY price ASC").all(params.resellerId);
    json(res, 200, { plans });
  });

  // POST /api/portal/:resellerId/upload-receipt â€” a customer attaches a
  // photo of their bank transfer receipt (or a PDF) before/while
  // submitting their signup. Returns a URL to include as `receiptUrl`
  // in the POST /signup body above; the text `reference` field is
  // still required too (this is additive proof, not a replacement).
  router.post("/api/portal/:resellerId/upload-receipt", async (req, res, { params, body }) => {
    if (await rateLimitByIp(req, res, "portal-upload-receipt", { max: 20, windowMs: 60 * 60000 })) return;
    const reseller = await db.prepare("SELECT id FROM resellers WHERE id = ?").get(params.resellerId);
    if (!reseller) return json(res, 404, { error: "Reseller not found" });
    try {
      const result = await saveUpload(body);
      json(res, 201, result);
    } catch (err) {
      json(res, 400, { error: err.message || "Upload failed" });
    }
  });

  // POST /api/portal/:resellerId/support/upload â€” a customer attaching
  // a photo, PDF, or voice note to their support request (see
  // POST /support below, `attachmentUrl`). Same storage/validation as
  // upload-receipt above, just a separate rate-limit bucket so a burst
  // of support attachments doesn't eat into the receipt-upload budget.
  router.post("/api/portal/:resellerId/support/upload", async (req, res, { params, body }) => {
    if (await rateLimitByIp(req, res, "portal-support-upload", { max: 20, windowMs: 60 * 60000 })) return;
    const reseller = await db.prepare("SELECT id FROM resellers WHERE id = ?").get(params.resellerId);
    if (!reseller) return json(res, 404, { error: "Reseller not found" });
    try {
      const result = await saveUpload(body);
      json(res, 201, result);
    } catch (err) {
      json(res, 400, { error: err.message || "Upload failed" });
    }
  });

  // POST /api/portal/:resellerId/redeem — allows a client to enter a voucher code directly
  router.post("/api/portal/:resellerId/redeem", async (req, res, { params, body }) => {
    const resellerId = params.resellerId;
    const { voucherCode, clientMac } = body || {};
    if (!voucherCode) return json(res, 400, { error: "Voucher code is required" });
    if (!clientMac) return json(res, 400, { error: "Missing device MAC. Please reconnect to the WiFi." });

    const vCode = String(voucherCode).trim().toUpperCase();
    const voucher = await db.prepare("SELECT * FROM vouchers WHERE UPPER(username) = ? AND reseller_id = ?").get(vCode, resellerId);
    if (!voucher) return json(res, 404, { error: "Voucher code not found. Please check for typos." });
    if (voucher.status !== 'active') return json(res, 400, { error: "This voucher is currently " + voucher.status + "." });
    if (Number(voucher.expires_at) < Date.now()) return json(res, 400, { error: "This voucher has expired. Please contact the reseller." });

    // Bind the client's MAC if provided
    if (clientMac) {
      const isoExpiry = new Date(Number(voucher.expires_at)).toISOString().slice(0, 19);
      const routers = await db.prepare("SELECT router_id FROM routers WHERE reseller_id = ?").all(resellerId);
      const now = Date.now();
      for (const r of routers) {
        await db.prepare("INSERT INTO router_commands (id, router_id, type, payload, status, created_at) VALUES (?,?,?,?,?,?)")
          .run(id("cmd"), r.router_id, "bind_mac", JSON.stringify({ username: clientMac, password: isoExpiry }), "pending", now);
      }
    }
    
    // Also create the hotspot user so they can log in manually if needed
    const routers2 = await db.prepare("SELECT router_id FROM routers WHERE reseller_id = ?").all(resellerId);
    for (const r of routers2) {
      await db.prepare("INSERT INTO router_commands (id, router_id, type, payload, status, created_at) VALUES (?,?,?,?,?,?)")
        .run(id("cmd"), r.router_id, "create_user", JSON.stringify({ username: voucher.username, password: voucher.password || voucher.username }), "pending", Date.now());
    }

    return json(res, 200, { ok: true, voucher });
  });

  // POST /api/portal/:resellerId/signup
  // body: { name, email, phone, business, planId, method, reference }
  // Always creates a pending_activations row â€” nothing is issued until
  // the reseller confirms the transfer landed.
  router.post("/api/portal/:resellerId/signup", async (req, res, { params, body }) => {
    // Deliberately generous: many real customers can share one public
    // IP at a busy location (office/cafe WiFi behind NAT) â€” this limit
    // exists to stop scripted pending_activations spam, not to throttle
    // a legitimately busy hotspot.
    if (await rateLimitByIp(req, res, "portal-signup", { max: 30, windowMs: 60 * 60000 })) return;
    const resellerId = params.resellerId;
    const { name, email, phone, business, planId, method, reference, receiptUrl, clientMac, clientIp } = body;
    if (!name || !email || !phone || !planId || !method) {
      return json(res, 400, { error: "name, email, phone, planId, and method are required" });
    }
    if (!MANUAL_METHODS.has(method)) {
      return json(res, 400, { error: `method must be one of: ${[...MANUAL_METHODS].join(", ")}` });
    }
    if (!reference) return json(res, 400, { error: "reference is required (receipt filename or USSD confirmation code)" });

    const plan = await db.prepare("SELECT * FROM plans WHERE id = ? AND reseller_id = ?").get(planId, resellerId);
    if (!plan) return json(res, 404, { error: "Plan not found for this reseller" });

    const now = Date.now();
    const pendingId = id("pa");
    await db.prepare(`INSERT INTO pending_activations (id,reseller_id,name,email,phone,business,plan_id,amount,method,reference,status,time,receipt_url,client_mac,client_ip)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(pendingId, resellerId, name, email, phone, business || name, planId, plan.price, method, reference, "pending", now, receiptUrl || null, clientMac || null, clientIp || null);
    await db.prepare("INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)")
      .run(id("n"), `reseller:${resellerId}`, "payment_confirmation", "Payment confirmation needed",
        `${name} submitted a ${method.toLowerCase()} receipt for ${plan.name}.`, now, 0, "pending");

    json(res, 202, {
      status: "pending", pendingActivationId: pendingId,
      message: "Submitted â€” waiting on your reseller to confirm the payment landed.",
    });
  });

  // POST /api/portal/:resellerId/support â€” an end-user (not the reseller
  // themselves) raising an issue from the Captive Portal. No auth: these
  // visitors never get a login, just a name/email/phone to be reached at.
  // Notifies the reseller the same way a payment confirmation does; the
  // reseller answers it from their own Support tab.
  router.post("/api/portal/:resellerId/support", async (req, res, { params, body }) => {
    if (await rateLimitByIp(req, res, "portal-support", { max: 10, windowMs: 60 * 60000 })) return;
    const resellerId = params.resellerId;
    const { name, email, phone, subject, message, attachmentUrl } = body;
    if (!name || !subject || !message || (!email && !phone)) {
      return json(res, 400, { error: "name, subject, message, and at least one of email/phone are required" });
    }
    const reseller = await db.prepare("SELECT id, company_name FROM resellers WHERE id = ?").get(resellerId);
    if (!reseller) return json(res, 404, { error: "Reseller not found" });

    const now = Date.now();
    const ticketId = id("t");
    await db.prepare(`INSERT INTO support_tickets
        (id,reseller_id,subject,message,status,time,source,customer_name,customer_email,customer_phone,attachment_url)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(ticketId, resellerId, subject, message, "open", now, "portal", name, email || null, phone || null, attachmentUrl || null);
    await db.prepare("INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)")
      .run(id("n"), `reseller:${resellerId}`, "support_ticket", "New support request from a customer",
        `${name}: ${subject}`, now, 0, "support");

    json(res, 201, { id: ticketId, message: `Sent to ${reseller.company_name}. They'll reach you at the contact you gave.` });
  });
  // GET /api/portal/:resellerId/activation-status/:pendingId
  // Polled by the Captive Portal every 3s while waiting for reseller confirm.
  router.get("/api/portal/:resellerId/activation-status/:pendingId", async (req, res, { params }) => {
    const resellerId = params.resellerId;
    const pendingId = params.pendingId;
    const row = await db.prepare("SELECT id,status,email,phone FROM pending_activations WHERE id=? AND reseller_id=?").get(pendingId, resellerId);
    if (!row) return json(res, 404, { error: "Not found" });
    if (row.status === "pending") return json(res, 200, { status: "pending" });
    if (row.status === "rejected") return json(res, 200, { status: "rejected" });
    // confirmed OR activated: fetch voucher matching this customer
    let v = null;
    if (row.email) v = await db.prepare("SELECT username,password FROM vouchers WHERE reseller_id=? AND email=? ORDER BY created_at DESC LIMIT 1").get(resellerId, row.email);
    if (!v && row.phone) v = await db.prepare("SELECT username,password FROM vouchers WHERE reseller_id=? AND phone=? ORDER BY created_at DESC LIMIT 1").get(resellerId, row.phone);
    if (!v) v = await db.prepare("SELECT username,password FROM vouchers WHERE reseller_id=? ORDER BY created_at DESC LIMIT 1").get(resellerId);
    return json(res, 200, { status: "confirmed", voucher: v || null });
  });

  // POST /api/portal/:resellerId/card-checkout
  // Creates pending_activation + initiates Flutterwave payment. Returns checkoutUrl.
  router.post("/api/portal/:resellerId/card-checkout", async (req, res, { params, body }) => {
    if (await rateLimitByIp(req, res, "portal-card", { max: 10, windowMs: 15 * 60000 })) return;
    const resellerId = params.resellerId;
    const { name, email, phone, business, planId, provider, clientMac, clientIp } = body || {};
    if (!name || !email || !phone || !planId) return json(res, 400, { error: "name,email,phone,planId required" });
    const plan = await db.prepare("SELECT * FROM plans WHERE id=? AND reseller_id=?").get(planId, resellerId);
    if (!plan) return json(res, 404, { error: "Plan not found" });
    const rrow = await db.prepare("SELECT currency FROM resellers WHERE id=?").get(resellerId);
    const cur = (rrow && rrow.currency) || "NGN";
    const reference = "VOU-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const pendingId = id("pa");
    const now = Date.now();
    await db.prepare(`INSERT INTO pending_activations (id,reseller_id,name,email,phone,business,plan_id,amount,method,reference,status,time)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      pendingId, resellerId, name, email, phone, business || name,
      planId, plan.price, "Card", reference, "pending", now
    );
    const apiUrl = process.env.APP_URL || "https://www.safelinks.name.ng";
    try {
      const r = await fetch(apiUrl + "/api/payments/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: provider || "flutterwave",
          purpose: "voucher",
          amountMajor: plan.price,
          currency: cur,
          email,
          reference,
          paymentOptions: "card,banktransfer,ussd,mobilemoney,bankaccount,paypal",
          metadata: { reseller_id: resellerId, user_id: resellerId, plan_id: planId, customer_name: name, customer_email: email, customer_phone: phone },
        }),
      });
      const j = await r.json();
      if (!r.ok) return json(res, 400, { error: j.error || "Payment initiation failed" });
      const checkoutUrl = j.authorizationUrl || j.checkoutUrl || j.url;
      if (!checkoutUrl) return json(res, 500, { error: "No checkout URL returned" });
      return json(res, 200, { ok: true, checkoutUrl, reference, pendingActivationId: pendingId });
    } catch (e) {
      return json(res, 500, { error: e.message || "Payment initiation failed" });
    }
  });

}
