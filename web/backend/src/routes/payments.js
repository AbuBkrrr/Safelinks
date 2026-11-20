// Payment routes — initiate, verify, webhooks, and provider listing.
// Works with the custom router (http.js) — same shape as routes/portal.js.

import crypto from "node:crypto";
import { db, id } from "../db.js";
import { json } from "../http.js";
import { rateLimitByIp } from "../rateLimit.js";
import {
  initiatePayment as initiateProviderPayment,
  verifyPayment as verifyProviderPayment,
  verifyWebhook,
  listEnabledProviders,
} from "../payments/index.js";
import { CURRENCY_GATEWAY_SUPPORT } from "./planPrices.js";
import { enqueueCommandForReseller } from "./router.js";
import { planDurationMs } from "../planDuration.js";
import { upsertCustomer, issueVoucher, extendVoucher, walletCredit, afterPaidPurchase } from "../growth.js";
import { sendMessage, naira } from "../notify.js";

// Helper: generate a short unique reference for a payment intent.
function makeReference(prefix = "SL") {
  const rand = crypto.randomBytes(5).toString("hex").toUpperCase();
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

// Helper: after a payment is confirmed, activate the voucher + queue a router command.
export async function fulfillVoucherPayment(paymentRow, verified) {
  const now = Date.now();
  const resellerId = paymentRow.reseller_id || paymentRow.user_id;
  const pending = await db.prepare(
    "SELECT * FROM pending_activations WHERE reseller_id = ? AND reference = ? LIMIT 1"
  ).get(resellerId, paymentRow.reference);
  const customer = await upsertCustomer(resellerId, {
    phone: paymentRow.customer_phone || pending?.phone,
    name: paymentRow.customer_name || pending?.name,
    email: paymentRow.customer_email || pending?.email,
    referralCode: paymentRow.referral_code,
  });

  // Wallet top-up: credit and stop.
  if (paymentRow.purpose_kind === "wallet") {
    if (customer) {
      await walletCredit(customer.id, Number(paymentRow.amount), "topup", paymentRow.reference);
      await db.prepare("UPDATE payments SET customer_id = ? WHERE id = ?").run(customer.id, paymentRow.id);
      const c = await db.prepare("SELECT wallet_balance FROM customers WHERE id = ?").get(customer.id);
      const r = await db.prepare("SELECT company_name FROM resellers WHERE id = ?").get(resellerId);
      await sendMessage({ resellerId, to: customer.phone, kind: "wallet",
        body: `${r?.company_name || "WiFi"}: ${naira(paymentRow.amount)} added to your wallet. Balance ${naira(c.wallet_balance)}.` });
    }
    return { wallet: true };
  }

  const plan = paymentRow.plan_id ? await db.prepare("SELECT * FROM plans WHERE id = ?").get(paymentRow.plan_id) : null;
  const mac = paymentRow.client_mac || pending?.client_mac || null;
  if (paymentRow.promo_code) {
    await db.prepare("UPDATE promo_codes SET uses = uses + 1 WHERE reseller_id = ? AND UPPER(code) = UPPER(?)").run(resellerId, paymentRow.promo_code);
  }

  // Renewal of an existing login keeps the customer connected; otherwise a
  // fresh random login (never derived from the MAC, which anyone can see).
  let v = null;
  if (paymentRow.extend_voucher_id) {
    const old = await db.prepare("SELECT * FROM vouchers WHERE id = ? AND reseller_id = ?").get(paymentRow.extend_voucher_id, resellerId);
    if (old) v = await extendVoucher(old, plan);
  }
  if (!v) {
    v = await issueVoucher({ resellerId, plan, customer, clientMac: mac, source: "paid",
      name: paymentRow.customer_name || pending?.name, email: paymentRow.customer_email || pending?.email,
      phone: paymentRow.customer_phone || pending?.phone });
  }
  if (pending) await db.prepare("UPDATE pending_activations SET status = 'activated' WHERE id = ?").run(pending.id);
  if (paymentRow.reference) {
    await db.prepare("UPDATE payments SET voucher_id = ?, customer_id = ? WHERE reference = ?").run(v.id, customer?.id || null, paymentRow.reference);
  }
  await afterPaidPurchase(resellerId, customer, paymentRow.amount, plan);

  await db.prepare("INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)")
    .run(id("n"), `reseller:${resellerId}`, "payment", "New sale",
      `${naira(paymentRow.amount)} - ${plan?.name || "plan"} for ${paymentRow.customer_name || paymentRow.customer_phone || "a customer"}.`, now, 0, "vouchers");
  return { voucherId: v.id, username: v.username, password: v.password, expiresAt: v.expires_at };
}

// Helper: after a license payment is confirmed, activate the reseller license.
async function fulfillLicensePayment(paymentRow) {
  const now = Date.now();
  const plan = paymentRow.plan_id
    ? await db.prepare("SELECT * FROM platform_plans WHERE id = ?").get(paymentRow.plan_id)
    : null;
  const durationDays = plan?.duration_days || 30;
  const expiresAt = now + durationDays * 24 * 60 * 60 * 1000;

  // Defensive: some payment rows were created without reseller_id populated
  // (older initiate paths passed metadata.user_id only). Fall back to user_id
  // so a real payment always activates the reseller. Log if both are null.
  const targetResellerId = paymentRow.reseller_id || paymentRow.user_id;
  if (!targetResellerId) {
    console.error('[fulfillLicensePayment] no reseller_id/user_id on payment row', paymentRow.reference);
    return { expiresAt, planId: plan?.id || "basic", skipped: true };
  }

  await db.prepare(
    "UPDATE resellers SET subscription_plan = ?, subscription_expiry = ?, status = 'active' WHERE id = ?"
  ).run(plan?.id || "basic", expiresAt, targetResellerId);

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
  router.get("/api/payments/providers", async (req, res, { query }) => {
    const currency = String(query?.currency || "").toUpperCase().trim() || null;
    let providers = listEnabledProviders();
    if (currency && CURRENCY_GATEWAY_SUPPORT[currency]) {
      providers = providers.filter((p) => CURRENCY_GATEWAY_SUPPORT[currency].includes(p));
    }
    json(res, 200, { providers, currency });
  });

  // POST /api/payments/initiate
  // Body: { provider, purpose: 'voucher'|'license', amountMajor, currency,
  //         email, reference?, metadata? }
  router.post("/api/payments/initiate", async (req, res, { body }) => {
    if (await rateLimitByIp(req, res, "payment-init", { max: 30, windowMs: 15 * 60000 })) return;

    const { provider, purpose, amountMajor, currency, email, reference: suppliedRef, metadata, paymentOptions } = body || {};
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
              paymentOptions,
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
        // Claim atomically: webhook and portal polling can race on one payment.
        const claim = await db.prepare("UPDATE payments SET status = 'paid', paid_at = ? WHERE id = ? AND status <> 'paid'").run(Date.now(), row.id);
        if (claim.changes === 1) {
        // Figure out fulfillment by purpose encoded in the metadata at creation time.
        // We stored "note" field — reuse it, or infer from plan_id/user_type.
        const purpose = row.user_type === "reseller" ? "license" : "voucher";
        if (purpose === "voucher") await fulfillVoucherPayment(row, result);
        else await fulfillLicensePayment(row);
        }
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
    // Only a successful charge for at least the expected amount unlocks
    // anything. Previously ANY signed event with a reference (charge.failed,
    // refunds, ...) marked the payment paid and issued a voucher.
    if (body?.event !== "charge.success" || body?.data?.status !== "success") return json(res, 200, { ok: true });
    const row = await db.prepare("SELECT * FROM payments WHERE reference = ?").get(reference);
    if (row && Number(body.data.amount) / 100 + 1e-9 < Number(row.amount)) {
      console.error("[paystack webhook] underpaid", reference, body.data.amount, row.amount);
      return json(res, 200, { ok: true });
    }
    if (row && row.status !== "paid") {
      // Claim atomically: webhook and portal polling can race on one payment.
      const claim = await db.prepare("UPDATE payments SET status = 'paid', paid_at = ? WHERE id = ? AND status <> 'paid'").run(Date.now(), row.id);
      if (claim.changes === 1) {
      const purpose = row.user_type === "reseller" ? "license" : "voucher";
      if (purpose === "voucher") await fulfillVoucherPayment(row);
      else await fulfillLicensePayment(row);
      }
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
      // Claim atomically: webhook and portal polling can race on one payment.
      const claim = await db.prepare("UPDATE payments SET status = 'paid', paid_at = ? WHERE id = ? AND status <> 'paid'").run(Date.now(), row.id);
      if (claim.changes === 1) {
      const purpose = row.user_type === "reseller" ? "license" : "voucher";
      if (purpose === "voucher") await fulfillVoucherPayment(row);
      else await fulfillLicensePayment(row);
      }
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
      // Claim atomically: webhook and portal polling can race on one payment.
      const claim = await db.prepare("UPDATE payments SET status = 'paid', paid_at = ? WHERE id = ? AND status <> 'paid'").run(Date.now(), row.id);
      if (claim.changes === 1) {
      const purpose = row.user_type === "reseller" ? "license" : "voucher";
      if (purpose === "voucher") await fulfillVoucherPayment(row);
      else await fulfillLicensePayment(row);
      }
    }
    json(res, 200, { ok: true });
  });
}
