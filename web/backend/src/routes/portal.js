import { db, id } from "../db.js";
import { json } from "../http.js";
import { rateLimitByIp } from "../rateLimit.js";
import { saveUpload } from "../uploads.js";
import * as paystack from "../payments/paystack.js";
import { verifyPayment as verifyProviderPayment, listEnabledProviders, initiatePayment as initiateProviderPayment } from "../payments/index.js";
import { fulfillVoucherPayment } from "./payments.js";
import crypto from "node:crypto";
import { quote } from "../growth.js";
import { planDurationMs } from "../planDuration.js";
import { normalizePhone } from "../notify.js";
import { queueVoucherOnRouters, userReadyOnRouter } from "../routerCommands.js";

// No payment gateway integration by design: every voucher purchase is a
// manual transfer straight from the end-user's bank to the RESELLER's
// own account (or a USSD push), confirmed by the reseller against their
// account before a voucher is issued. There is no instant path.
const MANUAL_METHODS = new Set(["Bank Transfer", "USSD"]);


// Builds the pending payment for any checkout: a plan purchase (with promo /
// happy hour / referral), a one-tap renewal of an existing login, or a
// wallet top-up. A 100%-discounted purchase is fulfilled immediately.
async function prepareCheckout(resellerId, b, method) {
  const purpose = b.purpose === "wallet" ? "wallet" : "voucher";
  const phone = normalizePhone(b.phone);
  if (!phone) return { error: "Enter a valid phone number" };
  const name = String(b.name || "").trim() || "Customer";
  const email = String(b.email || "").trim() || `${phone}@wifi.safelinks`;
  let plan = null, amount = 0, q = null, extendId = null;
  if (purpose === "wallet") {
    amount = Math.round(Number(b.amount) * 100) / 100;
    if (!(amount >= 100 && amount <= 500000)) return { error: "Top-up must be between 100 and 500,000" };
  } else {
    if (b.renewToken) {
      const link = await db.prepare("SELECT * FROM renew_links WHERE token = ? AND reseller_id = ? AND expires_at > ?").get(String(b.renewToken), resellerId, Date.now());
      if (link) { extendId = link.voucher_id; if (!b.planId) b.planId = link.plan_id; }
    }
    plan = await db.prepare("SELECT * FROM plans WHERE id=? AND reseller_id=?").get(b.planId, resellerId);
    if (!plan) return { error: "Plan not found", status: 404 };
    q = await quote(resellerId, plan, b.promoCode);
    if (q.promoError) return { error: q.promoError };
    amount = q.total;
  }
  const reference = (purpose === "wallet" ? "WAL-" : "VTR-") + Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex").toUpperCase();
  const now = Date.now();
  const pendingId = id("pa");
  const mac = b.clientMac ? String(b.clientMac).toUpperCase() : null;
  if (plan) {
    await db.prepare(`INSERT INTO pending_activations (id,reseller_id,name,email,phone,business,plan_id,amount,method,reference,status,time,client_mac,client_ip)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(pendingId, resellerId, name, email, phone, name, plan.id, amount, method, reference, "pending", now, mac, b.clientIp || null);
  }
  await db.prepare(`INSERT INTO payments (id,user_type,user_id,reseller_id,amount,method,status,reference,currency,
      customer_name,customer_email,customer_phone,plan_id,time,client_mac,promo_code,discount,purpose_kind,extend_voucher_id,referral_code)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id("p"), "end_user", resellerId, resellerId, amount, `online:paystack-${method === "Card" ? "card" : "transfer"}`, "pending", reference, "NGN",
    name, email, phone, plan?.id || null, now, mac, q?.promo ? q.promo.code : null, q?.discount || 0, purpose, extendId,
    b.referralCode ? String(b.referralCode).trim().toUpperCase() : null);
  const out = { purpose, phone, name, email, amount, reference, pendingId, planId: plan?.id || null, quote: q ? { price: q.price, discount: q.discount, total: q.total, notes: q.notes } : null };
  if (purpose === "voucher" && amount === 0) {
    const row = await db.prepare("SELECT * FROM payments WHERE reference = ?").get(reference);
    await db.prepare("UPDATE payments SET status='paid', paid_at=? WHERE id=?").run(now, row.id);
    await fulfillVoucherPayment(row);
    out.free = true;
  }
  return out;
}

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
      // Instant (gateway) payments available to this portal.
      gateways: listEnabledProviders(),
      instantTransfer: paystack.isEnabled() && String(r.currency || "NGN").toUpperCase() === "NGN",
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
    {
      const v = await db.prepare(
        "SELECT status, expires_at FROM vouchers WHERE (username = ? OR UPPER(client_mac) = UPPER(?)) AND reseller_id = ? ORDER BY created_at DESC LIMIT 1"
      ).get(sess && sess.username ? sess.username : "", mac, rid);
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

    const vCode = String(voucherCode).trim().toUpperCase();
    const voucher = await db.prepare("SELECT * FROM vouchers WHERE UPPER(username) = ? AND reseller_id = ?").get(vCode, resellerId);
    if (!voucher) return json(res, 404, { error: "Voucher code not found. Please check for typos." });
    // Printed cards start their plan time on first use.
    if (voucher.status === "unused") {
      const plan = voucher.plan_id ? await db.prepare("SELECT * FROM plans WHERE id = ?").get(voucher.plan_id) : null;
      const exp = Date.now() + planDurationMs(plan);
      const claim = await db.prepare("UPDATE vouchers SET status='active', expires_at=?, redeemed_at=? WHERE id=? AND status='unused'").run(exp, Date.now(), voucher.id);
      if (claim.changes === 1) { voucher.status = "active"; voucher.expires_at = exp; }
    }
    if (voucher.status !== 'active') return json(res, 400, { error: "This voucher is currently " + voucher.status + "." });
    if (Number(voucher.expires_at) < Date.now()) return json(res, 400, { error: "This voucher has expired. Please contact the reseller." });
    if (!voucher.redeemed_at) await db.prepare("UPDATE vouchers SET redeemed_at=? WHERE id=?").run(Date.now(), voucher.id);

    if (clientMac && !voucher.client_mac) {
      await db.prepare("UPDATE vouchers SET client_mac = ? WHERE id = ?").run(String(clientMac).toUpperCase(), voucher.id);
    }
    // Make sure every router has this login, then the portal logs the
    // device in through the router's login page.
    await queueVoucherOnRouters(voucher);
    return json(res, 200, { ok: true, voucher: { username: voucher.username, password: voucher.password || voucher.username, expires_at: voucher.expires_at } });
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
    // No match → return nothing. (Previously fell back to the reseller's most
    // recent voucher, which handed another customer's credentials to this one.)
    return json(res, 200, { status: "confirmed", voucher: v || null });
  });

  // GET /api/portal/:resellerId/ready/:username
  // true once a router has applied this login; the portal then sends the
  // browser to the router's login URL with the credentials.
  router.get("/api/portal/:resellerId/ready/:username", async (req, res, { params }) => {
    json(res, 200, { ready: await userReadyOnRouter(params.resellerId, params.username) });
  });

  // POST /api/portal/:resellerId/transfer-checkout
  // Instant bank transfer: Paystack issues a one-time account number for
  // this plan's price. When the transfer lands, Paystack's charge.success
  // webhook (or the polling below) issues the voucher and lets the device
  // online. No reseller confirmation step.
  router.post("/api/portal/:resellerId/transfer-checkout", async (req, res, { params, body }) => {
    if (await rateLimitByIp(req, res, "portal-transfer", { max: 10, windowMs: 15 * 60000 })) return;
    if (!paystack.isEnabled()) return json(res, 400, { error: "Instant transfer is not available" });
    const resellerId = params.resellerId;
    const rrow = await db.prepare("SELECT currency, paystack_subaccount FROM resellers WHERE id=?").get(resellerId);
    if (!rrow) return json(res, 404, { error: "Reseller not found" });
    if (String(rrow.currency || "NGN").toUpperCase() !== "NGN") return json(res, 400, { error: "Instant transfer is only available in NGN" });
    const ck = await prepareCheckout(resellerId, body || {}, "Instant Transfer");
    if (ck.error) return json(res, ck.status || 400, { error: ck.error });
    if (ck.free) return json(res, 200, { ok: true, free: true, reference: ck.reference, ...ck.quote });
    try {
      const t = await paystack.chargeBankTransfer({
        amountMajor: ck.amount, email: ck.email, reference: ck.reference,
        subaccount: rrow.paystack_subaccount || undefined,
        metadata: { purpose: ck.purpose, reseller_id: resellerId, plan_id: ck.planId, customer_name: ck.name, customer_phone: ck.phone },
      });
      return json(res, 200, { ok: true, reference: ck.reference, pendingActivationId: ck.pendingId, amount: ck.amount, currency: "NGN", quote: ck.quote, ...t });
    } catch (e) {
      await db.prepare("UPDATE payments SET status='failed' WHERE reference=?").run(ck.reference);
      return json(res, 502, { error: e.message || "Could not create transfer account" });
    }
  });

  // GET /api/portal/:resellerId/quote?planId=&promo=  -> live price for the checkout screen
  router.get("/api/portal/:resellerId/quote", async (req, res, { params, query }) => {
    const plan = await db.prepare("SELECT * FROM plans WHERE id=? AND reseller_id=?").get(query.planId, params.resellerId);
    if (!plan) return json(res, 404, { error: "Plan not found" });
    const q = await quote(params.resellerId, plan, query.promo);
    json(res, 200, { price: q.price, discount: q.discount, total: q.total, notes: q.notes, promoError: q.promoError });
  });

  // GET /api/portal/:resellerId/transfer-status/:reference
  // Polled by the portal every few seconds. If the webhook has not arrived
  // yet, asks Paystack directly so a lost webhook never strands a customer.
  router.get("/api/portal/:resellerId/transfer-status/:reference", async (req, res, { params }) => {
    if (await rateLimitByIp(req, res, "portal-transfer-status", { max: 400, windowMs: 15 * 60000 })) return;
    let row = await db.prepare("SELECT * FROM payments WHERE reference=? AND reseller_id=?").get(params.reference, params.resellerId);
    if (!row) return json(res, 404, { error: "Not found" });
    if (row.status === "pending" && paystack.isEnabled()) {
      try {
        const v = await verifyProviderPayment("paystack", row.reference);
        if (v.paid && Number(v.amountMajor) + 1e-9 >= Number(row.amount)) {
          const claim = await db.prepare("UPDATE payments SET status='paid', paid_at=? WHERE id=? AND status <> 'paid'").run(Date.now(), row.id);
          if (claim.changes === 1) await fulfillVoucherPayment(row, v);
          row = await db.prepare("SELECT * FROM payments WHERE id=?").get(row.id);
        }
      } catch (_) { /* gateway hiccup: keep polling */ }
    }
    if (row.status !== "paid") return json(res, 200, { status: row.status });
    const v = row.voucher_id ? await db.prepare("SELECT username, password, expires_at FROM vouchers WHERE id=?").get(row.voucher_id) : null;
    return json(res, 200, { status: "paid", voucher: v || null });
  });

  // POST /api/portal/:resellerId/card-checkout
  // Creates pending_activation + initiates Flutterwave payment. Returns checkoutUrl.
  router.post("/api/portal/:resellerId/card-checkout", async (req, res, { params, body }) => {
    if (await rateLimitByIp(req, res, "portal-card", { max: 10, windowMs: 15 * 60000 })) return;
    const resellerId = params.resellerId;
    const rrow = await db.prepare("SELECT currency, paystack_subaccount FROM resellers WHERE id=?").get(resellerId);
    if (!rrow) return json(res, 404, { error: "Reseller not found" });
    const ck = await prepareCheckout(resellerId, body || {}, "Card");
    if (ck.error) return json(res, ck.status || 400, { error: ck.error });
    if (ck.free) return json(res, 200, { ok: true, free: true, reference: ck.reference });
    const gws = listEnabledProviders();
    const provider = gws.includes("paystack") ? "paystack" : gws[0];
    if (!provider) return json(res, 400, { error: "No payment gateway configured" });
    await db.prepare("UPDATE payments SET method=? WHERE reference=?").run(`online:${provider}`, ck.reference);
    try {
      const init = await initiateProviderPayment(provider, {
        amountMajor: ck.amount, currency: rrow.currency || "NGN", email: ck.email, reference: ck.reference,
        callbackUrl: `${(process.env.APP_URL || "https://www.safelinks.name.ng").replace(/\/$/, "")}/payment-callback`,
        subaccount: provider === "paystack" ? rrow.paystack_subaccount || undefined : undefined,
        metadata: { purpose: ck.purpose, reseller_id: resellerId, plan_id: ck.planId, customer_name: ck.name, customer_phone: ck.phone },
      });
      return json(res, 200, { ok: true, checkoutUrl: init.authorizationUrl, reference: ck.reference, pendingActivationId: ck.pendingId });
    } catch (e) {
      await db.prepare("UPDATE payments SET status='failed' WHERE reference=?").run(ck.reference);
      return json(res, 502, { error: e.message || "Payment initiation failed" });
    }
  });

}
