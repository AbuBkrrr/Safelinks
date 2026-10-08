// Payment gateway dispatcher.
// Routes calls to the correct provider adapter based on `provider` string.
// If a provider is not configured (no API key), it is treated as "disabled".

import * as paystack from "./paystack.js";
import * as flutterwave from "./flutterwave.js";
import * as stripe from "./stripe.js";

const ADAPTERS = {
  paystack,
  flutterwave,
  stripe,
};

export function getAdapter(provider) {
  return ADAPTERS[provider] || null;
}

export function listEnabledProviders() {
  const out = [];
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    if (adapter.isEnabled()) out.push(name);
  }
  return out;
}

export async function initiatePayment(provider, params) {
  const adapter = getAdapter(provider);
  if (!adapter) throw new Error(`Unknown provider: ${provider}`);
  if (!adapter.isEnabled()) throw new Error(`Provider ${provider} not configured`);
  return adapter.initiatePayment(params);
}

export async function verifyPayment(provider, reference) {
  const adapter = getAdapter(provider);
  if (!adapter) throw new Error(`Unknown provider: ${provider}`);
  return adapter.verifyPayment(reference);
}

export function verifyWebhook(provider, rawBody, signature) {
  const adapter = getAdapter(provider);
  if (!adapter) return false;
  return adapter.verifyWebhookSignature(rawBody, signature);
}
