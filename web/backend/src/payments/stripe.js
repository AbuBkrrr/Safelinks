// Stripe adapter — https://stripe.com/docs/api
// International: cards, Apple Pay, Google Pay, etc.
// Uses Stripe's Checkout Sessions API (simplest hosted redirect flow).

import https from "node:https";
import crypto from "node:crypto";
import querystring from "node:querystring";

const SECRET_KEY = () => process.env.STRIPE_SECRET_KEY || "";

export function isEnabled() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

// Stripe API uses form-encoded bodies, not JSON.
function stripeRequest(method, path, formObj) {
  return new Promise((resolve, reject) => {
    const data = formObj ? querystring.stringify(formObj) : null;
    const req = https.request(
      {
        hostname: "api.stripe.com",
        port: 443,
        path,
        method,
        headers: {
          Authorization: `Bearer ${SECRET_KEY()}`,
          "Content-Type": "application/x-www-form-urlencoded",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
        timeout: 15000,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, body: { raw } }); }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Stripe timeout")); });
    if (data) req.write(data);
    req.end();
  });
}

// Note: Stripe expects the smallest currency unit. Zero-decimal currencies
// (like NGN, JPY) should NOT be multiplied by 100. This helper handles the
// common case; adjust if you add other zero-decimal currencies.
const ZERO_DECIMAL = new Set(["NGN", "JPY", "KRW", "VND", "CLP"]);
function toStripeAmount(amountMajor, currency) {
  const n = Number(amountMajor);
  return ZERO_DECIMAL.has((currency || "USD").toUpperCase()) ? Math.round(n) : Math.round(n * 100);
}

export async function initiatePayment({ amountMajor, currency, reference, callbackUrl, metadata, email }) {
  const params = {
    mode: "payment",
    success_url: `${callbackUrl}?reference=${reference}&status=success`,
    cancel_url: `${callbackUrl}?reference=${reference}&status=cancelled`,
    "line_items[0][price_data][currency]": (currency || "USD").toLowerCase(),
    "line_items[0][price_data][product_data][name]": "SafeLinks Internet Voucher",
    "line_items[0][price_data][unit_amount]": toStripeAmount(amountMajor, currency),
    "line_items[0][quantity]": 1,
    "client_reference_id": reference,
    "metadata[reference]": reference,
    "metadata[user_type]": metadata?.user_type || "",
    "metadata[user_id]": metadata?.user_id || "",
    "metadata[router_id]": metadata?.router_id || "",
    "metadata[plan_id]": metadata?.plan_id || "",
  };
  if (email) params.customer_email = email;

  const { status, body } = await stripeRequest("POST", "/v1/checkout/sessions", params);
  if (status !== 200 || !body.id) {
    throw new Error(body.error?.message || `Stripe init failed (HTTP ${status})`);
  }
  return {
    provider: "stripe",
    reference,
    authorizationUrl: body.url,
    sessionId: body.id,
  };
}

export async function verifyPayment(reference) {
  // Look up the Checkout Session by client_reference_id metadata match.
  // For simplicity, we treat "session marked paid via webhook" as authoritative.
  // A direct lookup:
  const { status, body } = await stripeRequest(
    "GET",
    `/v1/checkout/sessions?limit=1&client_reference_id=${encodeURIComponent(reference)}`
  );
  if (status !== 200 || !body.data || body.data.length === 0) {
    return { paid: false, error: "Session not found" };
  }
  const s = body.data[0];
  return {
    paid: s.payment_status === "paid",
    amountMajor: s.amount_total / 100,
    currency: (s.currency || "usd").toUpperCase(),
    reference: s.client_reference_id,
    raw: s,
  };
}

// Stripe webhook signature: `t=timestamp,v1=hmac` header. Compute HMAC SHA-256
// of `${timestamp}.${rawBody}` with the webhook secret.
export function verifyWebhookSignature(rawBody, signatureHeader, toleranceSec = 300) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
  if (!secret || !signatureHeader) return false;
  const parts = Object.fromEntries(signatureHeader.split(",").map((kv) => kv.split("=")));
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSec) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
  } catch {
    return false;
  }
}
