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
export async function initiatePayment({ amountMajor, currency, email, reference, callbackUrl, metadata, subaccount }) {
  const amountMinor = Math.round(Number(amountMajor) * 100); // Paystack uses kobo/cents
  const { status, body } = await paystackRequest("POST", "/transaction/initialize", {
    email,
    amount: amountMinor,
    currency: currency || "NGN",
    reference,
    callback_url: callbackUrl,
    metadata,
    ...(subaccount ? { subaccount } : {}),
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
  if (!signature || !SECRET_KEY()) return false;
  const hash = crypto.createHmac("sha512", SECRET_KEY()).update(rawBody).digest("hex");
  const a = Buffer.from(hash), b = Buffer.from(String(signature));
  // timingSafeEqual throws on length mismatch; a malformed header is just invalid.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Pay with Transfer (Charge API): Paystack issues a one-time account number
// for this exact amount. The customer transfers from any bank app; Paystack
// then sends charge.success to our webhook, which unlocks access with no
// human in the loop. Requires "Pay with Transfer" enabled on the Paystack
// account. Response fields are read defensively.
export async function chargeBankTransfer({ amountMajor, email, reference, metadata, subaccount, expiresInMinutes = 30 }) {
  const body = {
    email,
    amount: Math.round(Number(amountMajor) * 100),
    reference,
    metadata,
    bank_transfer: { account_expires_at: new Date(Date.now() + expiresInMinutes * 60000).toISOString() },
  };
  if (subaccount) body.subaccount = subaccount;
  const { status, body: r } = await paystackRequest("POST", "/charge", body);
  const d = r?.data || {};
  if (!(status >= 200 && status < 300) || !r?.status || !d.account_number) {
    throw new Error(r?.message || d.message || `Paystack transfer charge failed (HTTP ${status})`);
  }
  return {
    reference: d.reference || reference,
    accountNumber: d.account_number,
    accountName: d.account_name || null,
    bankName: d.bank?.name || d.bank_name || null,
    expiresAt: d.account_expires_at || body.bank_transfer.account_expires_at,
    displayText: d.display_text || null,
  };
}

// ---- Reseller payouts (split payments via subaccounts) -----------------
// Each reseller gets a Paystack subaccount; every charge made with that
// subaccount settles the reseller's share to their bank automatically and
// keeps percentage_charge for the platform.
let banksCache = null;
export async function listBanks() {
  if (banksCache && banksCache.at > Date.now() - 86400e3) return banksCache.list;
  const { status, body } = await paystackRequest("GET", "/bank?country=nigeria&perPage=200");
  if (status !== 200 || !body.status) throw new Error(body.message || `HTTP ${status}`);
  const list = (body.data || []).filter((b) => b.active !== false).map((b) => ({ code: b.code, name: b.name }));
  banksCache = { at: Date.now(), list };
  return list;
}

export async function resolveAccount(accountNumber, bankCode) {
  const { status, body } = await paystackRequest("GET", `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
  if (status !== 200 || !body.status) throw new Error(body.message || "Could not verify the account");
  return body.data?.account_name || null;
}

export async function upsertSubaccount({ existingCode, businessName, bankCode, accountNumber, platformPercent }) {
  const payload = { business_name: businessName, settlement_bank: bankCode, account_number: accountNumber, percentage_charge: platformPercent };
  const { status, body } = existingCode
    ? await paystackRequest("PUT", `/subaccount/${encodeURIComponent(existingCode)}`, payload)
    : await paystackRequest("POST", "/subaccount", payload);
  if (!(status >= 200 && status < 300) || !body.status) throw new Error(body.message || `Subaccount failed (HTTP ${status})`);
  return body.data?.subaccount_code || existingCode;
}
