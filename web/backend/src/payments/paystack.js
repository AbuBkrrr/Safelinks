// Paystack adapter — https://paystack.com/docs/api/
// Nigeria-focused: cards, bank transfer, USSD, QR codes.
// Uses only Node built-in https — no SDK dependency.

import https from "node:https";
import crypto from "node:crypto";

const SECRET_KEY = () => process.env.PAYSTACK_SECRET_KEY || "";

export function isEnabled() {
  return Boolean(process.env.PAYSTACK_SECRET_KEY);
}

function paystackRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: "api.paystack.co",
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
    req.on("timeout", () => { req.destroy(); reject(new Error("Paystack timeout")); });
    if (data) req.write(data);
    req.end();
  });
}

// Initialize a transaction. Returns { authorization_url, reference }.
export async function initiatePayment({ amountMajor, currency, email, reference, callbackUrl, metadata }) {
  const amountMinor = Math.round(Number(amountMajor) * 100); // Paystack uses kobo/cents
  const { status, body } = await paystackRequest("POST", "/transaction/initialize", {
    email,
    amount: amountMinor,
    currency: currency || "NGN",
    reference,
    callback_url: callbackUrl,
    metadata,
  });
  if (status !== 200 || !body.status) {
    throw new Error(body.message || `Paystack init failed (HTTP ${status})`);
  }
  return {
    provider: "paystack",
    reference: body.data.reference,
    authorizationUrl: body.data.authorization_url,
    accessCode: body.data.access_code,
  };
}

// Verify a transaction by reference. Returns { paid, amountMajor, currency, channel, raw }.
export async function verifyPayment(reference) {
  const { status, body } = await paystackRequest("GET", `/transaction/verify/${encodeURIComponent(reference)}`);
  if (status !== 200 || !body.status) {
    return { paid: false, error: body.message || `HTTP ${status}` };
  }
  const t = body.data;
  return {
    paid: t.status === "success",
    amountMajor: Number(t.amount) / 100,
    currency: t.currency,
    channel: t.channel,
    email: t.customer?.email,
    metadata: t.metadata,
    reference: t.reference,
    raw: t,
  };
}

// Verify webhook signature using HMAC SHA-512 of the raw body with the secret key.
export function verifyWebhookSignature(rawBody, signature) {
  if (!signature) return false;
  const hash = crypto.createHmac("sha512", SECRET_KEY()).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
}
