// Flutterwave adapter — https://developer.flutterwave.com/
// Pan-African: cards, mobile money, bank transfers across 30+ countries.

import https from "node:https";
import crypto from "node:crypto";

const SECRET_KEY = () => process.env.FLUTTERWAVE_SECRET_KEY || "";

export function isEnabled() {
  return Boolean(process.env.FLUTTERWAVE_SECRET_KEY);
}

function flwRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: "api.flutterwave.com",
        port: 443,
        path,
        method,
        headers: {
          Authorization: `Bearer ${SECRET_KEY()}`,
          "Content-Type": "application/json",
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
    req.on("timeout", () => { req.destroy(); reject(new Error("Flutterwave timeout")); });
    if (data) req.write(data);
    req.end();
  });
}

export async function initiatePayment({ amountMajor, currency, email, reference, callbackUrl, metadata, name, phone }) {
  // Flutterwave sandbox has a quirk where the default link_expiration is in
  // the past (2024-02-14). Setting it explicitly to 24h in the future fixes
  // immediate-expiry errors.
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 19);
  const { status, body } = await flwRequest("POST", "/v3/payments", {
    tx_ref: reference,
    amount: Number(amountMajor),
    currency: currency || "NGN",
    redirect_url: callbackUrl,
    customer: { email, name: name || email, phone_number: phone || "" },
    meta: metadata,
    customizations: {
      title: "SafeLinks",
      description: "Internet voucher purchase",
    },
    configuration: {
      session_duration: 1440,  // 24 hours
      max_retry_attempt: 5,
    },
    link_expiration: expiresAt,  // yyyy-mm-ddThh:mm:ss
  });
  if (status !== 200 || body.status !== "success") {
    throw new Error(body.message || `Flutterwave init failed (HTTP ${status})`);
  }
  return {
    provider: "flutterwave",
    reference,
    authorizationUrl: body.data.link,
  };
}

export async function verifyPayment(reference) {
  // Verify by tx_ref
  const { status, body } = await flwRequest("GET", `/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`);
  if (status !== 200 || body.status !== "success") {
    return { paid: false, error: body.message || `HTTP ${status}` };
  }
  const t = body.data;
  return {
    paid: t.status === "successful",
    amountMajor: Number(t.amount),
    currency: t.currency,
    channel: t.payment_type,
    email: t.customer?.email,
    metadata: t.meta,
    reference: t.tx_ref,
    raw: t,
  };
}

// Flutterwave sends a "verif-hash" header matching FLW_SECRET_HASH env var.
export function verifyWebhookSignature(_rawBody, signature) {
  const expected = process.env.FLUTTERWAVE_WEBHOOK_HASH || "";
  if (!expected || !signature) return false;
  return signature === expected;
}



