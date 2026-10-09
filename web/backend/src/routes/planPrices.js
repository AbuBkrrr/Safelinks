import { db, id } from "../db.js";
import { json } from "../http.js";
import { authenticate } from "../auth.js";

// Multi-currency plan pricing. plan_prices holds one row per
// (plan_id, currency) pair. The public endpoint resolves the price for
// a caller-supplied currency with a fallback to the platform default
// currency (integration_settings.platform_currency).

const SUPPORTED_CURRENCIES = [
  "NGN", "USD", "GBP", "EUR",
  "XOF", "XAF",
  "GHS", "KES", "UGX", "TZS", "RWF", "ZAR", "ZMW", "EGP", "MAD",
];

// Which gateways can charge in which currency.
export const CURRENCY_GATEWAY_SUPPORT = {
  NGN: ["paystack", "flutterwave"],
  USD: ["paystack", "flutterwave", "stripe"],
  GBP: ["flutterwave", "stripe"],
  EUR: ["flutterwave", "stripe"],
  GHS: ["paystack", "flutterwave"],
  KES: ["paystack", "flutterwave"],
  ZAR: ["paystack", "flutterwave"],
  XOF: ["flutterwave"],
  XAF: ["flutterwave"],
  UGX: ["flutterwave"],
  TZS: ["flutterwave"],
  RWF: ["flutterwave"],
  ZMW: ["flutterwave"],
  EGP: ["flutterwave"],
  MAD: ["flutterwave"],
};

function requireSuperAdmin(req, res) {
  const auth = authenticate(req, "super_admin");
  if (!auth.ok) { json(res, auth.status, { error: auth.error }); return null; }
  return auth.user;
}

function normalizeCurrency(c) {
  const cur = String(c || "").toUpperCase().trim();
  if (!SUPPORTED_CURRENCIES.includes(cur)) return null;
  return cur;
}

export function registerPlanPricesRoutes(router) {
  router.get("/api/admin/plans/:planId/prices", async (req, res, { params }) => {
    if (!requireSuperAdmin(req, res)) return;

    const plan = await db.prepare("SELECT id, name FROM platform_plans WHERE id = ?").get(params.planId);
    if (!plan) return json(res, 404, { error: "Plan not found" });

    const settings = await db.prepare(
      "SELECT platform_currency FROM integration_settings WHERE id = 'singleton'"
    ).get();
    const platformCurrency = settings?.platform_currency || "USD";

    const rows = await db.prepare(
      "SELECT id, plan_id, currency, price, enabled, gateway_support, updated_at FROM plan_prices WHERE plan_id = ? ORDER BY currency"
    ).all(params.planId);

    const prices = rows.map((r) => ({
      currency: r.currency,
      price: Number(r.price),
      enabled: Boolean(r.enabled),
      gateway_support: r.gateway_support ? JSON.parse(r.gateway_support) : null,
      is_platform_default: r.currency === platformCurrency,
      updated_at: Number(r.updated_at),
    }));

    json(res, 200, {
      plan_id: plan.id,
      plan_name: plan.name,
      platform_currency: platformCurrency,
      supported_currencies: SUPPORTED_CURRENCIES,
      prices,
    });
  });

  router.put("/api/admin/plans/:planId/prices/:currency", async (req, res, { params, body }) => {
    if (!requireSuperAdmin(req, res)) return;

    const currency = normalizeCurrency(params.currency);
    if (!currency) return json(res, 400, { error: "Unsupported currency" });

    const plan = await db.prepare("SELECT id FROM platform_plans WHERE id = ?").get(params.planId);
    if (!plan) return json(res, 404, { error: "Plan not found" });

    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0) return json(res, 400, { error: "price must be a non-negative number" });

    const enabled = body.enabled === false ? 0 : 1;
    const gatewaySupport = body.gateway_support
      ? JSON.stringify(body.gateway_support)
      : null;

    const now = Date.now();
    const existing = await db.prepare(
      "SELECT id FROM plan_prices WHERE plan_id = ? AND currency = ?"
    ).get(params.planId, currency);

    if (existing) {
      await db.prepare(
        "UPDATE plan_prices SET price = ?, enabled = ?, gateway_support = ?, updated_at = ? WHERE id = ?"
      ).run(price, enabled, gatewaySupport, now, existing.id);
    } else {
      await db.prepare(
        "INSERT INTO plan_prices (id, plan_id, currency, price, enabled, gateway_support, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
      ).run(id("pp"), params.planId, currency, price, enabled, gatewaySupport, now, now);
    }

    json(res, 200, { ok: true });
  });

  router.delete("/api/admin/plans/:planId/prices/:currency", async (req, res, { params }) => {
    if (!requireSuperAdmin(req, res)) return;

    const currency = normalizeCurrency(params.currency);
    if (!currency) return json(res, 400, { error: "Unsupported currency" });

    const result = await db.prepare(
      "UPDATE plan_prices SET enabled = 0, updated_at = ? WHERE plan_id = ? AND currency = ?"
    ).run(Date.now(), params.planId, currency);

    if (result.changes === 0) return json(res, 404, { error: "No price row for that plan/currency" });
    json(res, 200, { ok: true });
  });
}

export function registerPublicPlansRoutes(router) {
  router.get("/api/plans/public", async (req, res, { query }) => {
    const requested = normalizeCurrency(query?.currency) || null;

    const settings = await db.prepare(
      "SELECT platform_currency FROM integration_settings WHERE id = 'singleton'"
    ).get();
    const platformCurrency = settings?.platform_currency || "USD";

    const plans = await db.prepare(
      "SELECT id, name, price, max_clients, max_devices_per_client, description FROM platform_plans"
    ).all();

    const out = [];
    for (const p of plans) {
      let row = null;
      let usedCurrency = null;
      let fallback = false;

      if (requested) {
        row = await db.prepare(
          "SELECT price, enabled FROM plan_prices WHERE plan_id = ? AND currency = ? AND enabled = 1"
        ).get(p.id, requested);
        if (row) usedCurrency = requested;
      }

      if (!row) {
        row = await db.prepare(
          "SELECT price, enabled FROM plan_prices WHERE plan_id = ? AND currency = ? AND enabled = 1"
        ).get(p.id, platformCurrency);
        usedCurrency = platformCurrency;
        fallback = requested && requested !== platformCurrency;
      }

      const price = row ? Number(row.price) : Number(p.price);

      out.push({
        id: p.id,
        name: p.name,
        price,
        currency: usedCurrency || platformCurrency,
        fallback,
        max_clients: p.max_clients,
        max_devices_per_client: p.max_devices_per_client,
        description: p.description,
      });
    }

    json(res, 200, {
      requested_currency: requested,
      platform_currency: platformCurrency,
      plans: out,
    });
  });
}