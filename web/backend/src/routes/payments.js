// Payment routes — initiate, verify, webhooks, and provider listing.
// Works with the custom router (http.js) — same shape as routes/portal.js.

import { db, id } from "../db.js";
import { json } from "../http.js";
import { rateLimitByIp } from "../rateLimit.js";
import {
  initiatePayment as initiateProviderPayment,
  verifyPayment as verifyProviderPayment,
  verifyWebhook,
  listEnabledProviders,
} from "../payments/index.js";
import { enqueueCommandForReseller } from "./router.js";

// Helper: generate a short unique reference for a payment intent.
function makeReference(prefix = "SL") {
  const rand = Math.random().toString(36).slice(2, 10).toUpperCase();
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

// Helper: after a payment is confirmed, activate the voucher + queue a router command.
async function fulfillVoucherPayment(paymentRow, verified) {
  const now = Date.now();
  // Look up any pending activation created at signup time
  const pending = await db.prepare(
    "SELECT * FROM pending_activations WHERE reseller_id = ? AND reference = ? LIMIT 1"
  ).get(paymentRow.reseller_id || paymentRow.user_id, paymentRow.reference);

  // Generate credentials (username/password) for the end-user
  const username = `u${Math.random().toString(36).slice(2, 8)}`;
  const password = Math.random().toString(36).slice(2, 10);
  const voucherId = id("v");

  const plan = paymentRow.plan_id
    ? await db.prepare("SELECT * FROM plans WHERE id = ?").get(paymentRow.plan_id)
    : null;

  const durationDays = plan?.duration_days || 30;
  const expiresAt = now + durationDays * 24 * 60 * 60 * 1000;

  await db.prepare(
    `INSERT INTO vouchers (id,reseller_id,username,password,name,email,phone,plan_id,status,created_at,expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    voucherId,
    paymentRow.reseller_id,
    username,
    password,
    paymentRow.customer_name || pending?.name || null,
    paymentRow.customer_email || pending?.email || null,
    paymentRow.customer_phone || pending?.phone || null,
    paymentRow.plan_id,
    "active",
    now,
    expiresAt
  );

  // Mark the pending activation as completed (if it existed)
  if (pending) {
    await db.prepare("UPDATE pending_activations SET status = 'activated' WHERE id = ?").run(pending.id);
  }

  // Queue a router command to create the hotspot user
  const routers = await db.prepare("SELECT router_id FROM routers WHERE reseller_id = ?").all(paymentRow.reseller_id);
  for (const r of routers) {
    await db.prepare(
      "INSERT INTO router_commands (id,router_id,type,payload,status,created_at) VALUES (?,?,?,?,?,?)"
    ).run(
      id("cmd"),
      r.router_id,
      "create_user",
      JSON.stringify({
        username,
        password,
        deviceLimit: plan?.device_limit || 5,
        bandwidthMbps: plan?.bandwidth_mbps || 100,
      }),
      "pending",
      now
    );
  }

  // Notify the reseller
  await db.prepare(
    "INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)"
  ).run(
    id("n"),
    `reseller:${paymentRow.reseller_id}`,
    "payment",
    "Instant voucher activated",
    `New voucher issued to ${paymentRow.customer_email || "customer"} for ${plan?.name || "plan"}.`,
    now,
    0,
    "vouchers"
  );

  return { voucherId, username, password, expiresAt };
}

// Helper: after a license payment is confirmed, activate the reseller license.
async function fulfillLicensePayment(paymentRow) {
  const now = Date.now();
  const plan = paymentRow.plan_id
    ? await db.prepare("SELECT * FROM platform_plans WHERE id = ?").get(paymentRow.plan_id)
    : null;
  const durationDays = plan?.duration_days || 30;
  const expiresAt = now + durationDays * 24 * 60 * 60 * 1000;

  await db.prepare(
    "UPDATE resellers SET subscription_plan = ?, subscription_expiry = ?, status = 'active' WHERE id = ?"
  ).run(plan?.id || "basic", expiresAt, paymentRow.reseller_id);

  await db.prepare(
    "INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)"
  ).run(
    id("n"),
    `reseller:${paymentRow.reseller_id}`,
    "payment",
    "License activated",
    `Your ${plan?.name || "license"} has been activated until ${new Date(expiresAt).toLocaleDateString()}.`,
    now,
    0,
    "license"
  );

  return { expiresAt, planId: plan?.id || "basic" };
}

export function registerPaymentRoutes(router) {
  // GET /api/payments/providers — which gateways are enabled?
  router.get("/api/payments/providers", async (req, res) => {
    json(res, 200, { providers: listEnabledProviders() });
  });

  // POST /api/payments/initiate
  // Body: { provider, purpose: 'voucher'|'license', amountMajor, currency,
  //         email, reference?, metadata? }
  router.post("/api/payments/initiate", async (req, res, { body }) => {
    if (await rateLimitByIp(req, res, "payment-init", { max: 30, windowMs: 15 * 60000 })) return;

    const { provider, purpose, amountMajor, currency, email, reference: suppliedRef, metadata } = body || {};
    if (!provider || !purpose || !amountMajor) {
      return json(res, 400, { error: "provider, purpose, amountMajor are required" });
    }
    if (!["voucher", "license"].includes(purpose)) {
      return json(res, 400, { error: "purpose must be 'voucher' or 'license'" });
    }

    const reference = suppliedRef || makeReference(purpose === "license" ? "LIC" : "VOU");
    const callbackUrl = `${process.env.APP_URL || "https://www.safelinks.name.ng"}/payment-callback`;

    // Pre-create a pending payment row so webhooks can match it.
    await db.prepare(
      `INSERT INTO payments (id,user_type,user_id,reseller_id,amount,method,status,reference,currency,
                              customer_name,customer_email,customer_phone,plan_id,router_id,time,note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id("p"),
      purpose === "license" ? "reseller" : "end_user",
      metadata?.user_id || null,
      metadata?.reseller_id || null,
      Number(amountMajor),
      `online:${provider}`,
      "pending",
      reference,
      currency || "NGN",
      metadata?.customer_name || null,
      email || null,
      metadata?.customer_phone || null,
      metadata?.plan_id || null,
      metadata?.router_id || null,
      Date.now(),
      null
    );

    try {
      const init = await initiateProviderPayment(provider, {
        amountMajor,
        currency,
        email,
        reference,
        callbackUrl,
        metadata: { ...metadata, purpose },
      });
      json(res, 200, {
        ok: true,
        provider,
        reference: init.reference,
        authorizationUrl: init.authorizationUrl,
      });
    } catch (err) {
      json(res, 400, { error: err.message || "Payment initiation failed" });
    }
  });

  // GET /api/payments/verify/:provider/:reference
  // Client-side verification after redirect from the gateway.
  router.get("/api/payments/verify/:provider/:reference", async (req, res, { params }) => {
    const { provider, reference } = params;
    try {
      const result = await verifyProviderPayment(provider, reference);
      if (!result.paid) {
        return json(res, 200, { ok: false, paid: false, reason: result.error || "Not paid yet" });
      }

      // Mark the payment row paid and fulfil it.
      const row = await db.prepare("SELECT * FROM payments WHERE reference = ?").get(reference);
      if (!row) return json(res, 404, { error: "Payment not found" });

      if (row.status !== "paid") {
        await db.prepare("UPDATE payments SET status = 'paid', paid_at = ? WHERE id = ?").run(Date.now(), row.id);
        // Figure out fulfillment by purpose encoded in the metadata at creation time.
        // We stored "note" field — reuse it, or infer from plan_id/user_type.
        const purpose = row.user_type === "reseller" ? "license" : "voucher";
        if (purpose === "voucher") await fulfillVoucherPayment(row, result);
        else await fulfillLicensePayment(row);
      }

      json(res, 200, { ok: true, paid: true, reference, amountMajor: result.amountMajor });
    } catch (err) {
      json(res, 400, { error: err.message || "Verification failed" });
    }
  });

  // --- Webhooks ---------------------------------------------------------
  // These accept JSON bodies. Signature verification happens per provider.

  // POST /api/payments/webhook/paystack
  router.post("/api/payments/webhook/paystack", async (req, res, { body, rawBody, headers }) => {
    const sig = headers["x-paystack-signature"];
    const raw = rawBody || JSON.stringify(body);
    if (!verifyWebhook("paystack", raw, sig)) {
      return json(res, 401, { error: "Invalid signature" });
    }
    const reference = body?.data?.reference;
    if (!reference) return json(res, 200, { ok: true }); // ack regardless to stop retries
    const row = await db.prepare("SELECT * FROM payments WHERE reference = ?").get(reference);
    if (row && row.status !== "paid") {
      await db.prepare("UPDATE payments SET status = 'paid', paid_at = ? WHERE id = ?").run(Date.now(), row.id);
      const purpose = row.user_type === "reseller" ? "license" : "voucher";
      if (purpose === "voucher") await fulfillVoucherPayment(row);
      else await fulfillLicensePayment(row);
    }
    json(res, 200, { ok: true });
  });

  // POST /api/payments/webhook/flutterwave
  router.post("/api/payments/webhook/flutterwave", async (req, res, { body, headers }) => {
    const sig = headers["verif-hash"];
    if (!verifyWebhook("flutterwave", null, sig)) {
      return json(res, 401, { error: "Invalid hash" });
    }
    const reference = body?.data?.tx_ref;
    if (!reference) return json(res, 200, { ok: true });
    const row = await db.prepare("SELECT * FROM payments WHERE reference = ?").get(reference);
    if (row && row.status !== "paid") {
      await db.prepare("UPDATE payments SET status = 'paid', paid_at = ? WHERE id = ?").run(Date.now(), row.id);
      const purpose = row.user_type === "reseller" ? "license" : "voucher";
      if (purpose === "voucher") await fulfillVoucherPayment(row);
      else await fulfillLicensePayment(row);
    }
    json(res, 200, { ok: true });
  });

  // POST /api/payments/webhook/stripe
  router.post("/api/payments/webhook/stripe", async (req, res, { body, rawBody, headers }) => {
    const sig = headers["stripe-signature"];
    const raw = rawBody || JSON.stringify(body);
    if (!verifyWebhook("stripe", raw, sig)) {
      return json(res, 401, { error: "Invalid signature" });
    }
    const reference = body?.data?.object?.metadata?.reference || body?.data?.object?.client_reference_id;
    if (!reference) return json(res, 200, { ok: true });
    const row = await db.prepare("SELECT * FROM payments WHERE reference = ?").get(reference);
    if (row && row.status !== "paid") {
      await db.prepare("UPDATE payments SET status = 'paid', paid_at = ? WHERE id = ?").run(Date.now(), row.id);
      const purpose = row.user_type === "reseller" ? "license" : "voucher";
      if (purpose === "voucher") await fulfillVoucherPayment(row);
      else await fulfillLicensePayment(row);
    }
    json(res, 200, { ok: true });
  });
}
