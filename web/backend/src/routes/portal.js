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
  // GET /api/portal/:resellerId/info — branding + where to pay
  router.get("/api/portal/:resellerId/info", async (req, res, { params }) => {
    const r = await db.prepare(`
      SELECT company_name, ssid, portal_title, color, currency, language, bank_name, bank_account_name, bank_account_number, ussd_code,
             contact_email, contact_whatsapp
      FROM resellers WHERE id = ?
    `).get(params.resellerId);
    if (!r) return json(res, 404, { error: "Reseller not found" });
    json(res, 200, {
      companyName: r.company_name, ssid: r.ssid, portalTitle: r.portal_title, color: r.color,
      currency: r.currency || "USD", language: r.language || "en",
      bankAccount: { bankName: r.bank_name, accountName: r.bank_account_name, accountNumber: r.bank_account_number },
      ussdCode: r.ussd_code,
      contactEmail: r.contact_email, contactWhatsapp: r.contact_whatsapp,
    });
  });

  // GET /api/portal/:resellerId/plans
  router.get("/api/portal/:resellerId/plans", async (req, res, { params }) => {
    const plans = await db.prepare("SELECT * FROM plans WHERE reseller_id = ? ORDER BY price ASC").all(params.resellerId);
    json(res, 200, { plans });
  });

  // POST /api/portal/:resellerId/upload-receipt — a customer attaches a
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

  // POST /api/portal/:resellerId/support/upload — a customer attaching
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

  // POST /api/portal/:resellerId/signup
  // body: { name, email, phone, business, planId, method, reference }
  // Always creates a pending_activations row — nothing is issued until
  // the reseller confirms the transfer landed.
  router.post("/api/portal/:resellerId/signup", async (req, res, { params, body }) => {
    // Deliberately generous: many real customers can share one public
    // IP at a busy location (office/cafe WiFi behind NAT) — this limit
    // exists to stop scripted pending_activations spam, not to throttle
    // a legitimately busy hotspot.
    if (await rateLimitByIp(req, res, "portal-signup", { max: 30, windowMs: 60 * 60000 })) return;
    const resellerId = params.resellerId;
    const { name, email, phone, business, planId, method, reference, receiptUrl } = body;
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
    await db.prepare(`INSERT INTO pending_activations (id,reseller_id,name,email,phone,business,plan_id,amount,method,reference,status,time,receipt_url)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(pendingId, resellerId, name, email, phone, business || name, planId, plan.price, method, reference, "pending", now, receiptUrl || null);
    await db.prepare("INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)")
      .run(id("n"), `reseller:${resellerId}`, "payment_confirmation", "Payment confirmation needed",
        `${name} submitted a ${method.toLowerCase()} receipt for ${plan.name}.`, now, 0, "pending");

    json(res, 202, {
      status: "pending", pendingActivationId: pendingId,
      message: "Submitted — waiting on your reseller to confirm the payment landed.",
    });
  });

  // POST /api/portal/:resellerId/support — an end-user (not the reseller
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
}
