import { db, id } from "../db.js";
import { json } from "../http.js";
import { authenticate } from "../auth.js";
import {
  initiatePayment as initiateProviderPayment,
  listEnabledProviders,
} from "../payments/index.js";

// Native-installer endpoints.
//
//  POST /api/installer/session            — installer session recording
//  POST /api/installer/license/initiate   — reseller pays license via gateway
//
// The session endpoint records the installer-side view of a router
// provisioning flow. The license endpoint wraps the existing
// payments/initiate machinery, authenticating the reseller and
// passing through the pricing resolved in the reseller's currency.

function makeLicReference() {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `LIC-${Date.now().toString(36)}-${rand}`;
}

export function registerInstallerRoutes(router) {
  // ----- POST /api/installer/session -----
  router.post("/api/installer/session", async (req, res, { body }) => {
    const auth = authenticate(req, "reseller");
    if (!auth.ok) return json(res, auth.status, { error: auth.error });
    const resellerId = auth.user.id || auth.user.sub;
    if (!resellerId) return json(res, 401, { error: "Token missing reseller id" });

    const requiredStrings = [
      "installer_id", "agent_version", "router_ip", "router_vendor", "ssid", "pairing_code",
    ];
    for (const k of requiredStrings) {
      if (typeof body[k] !== "string" || !body[k].trim()) {
        return json(res, 400, { error: `Missing or invalid field: ${k}` });
      }
    }

    const now = Date.now();
    const rowId = id("i");

    await db.prepare(`
      INSERT INTO installations
        (id, reseller_id, router_id, ip, location, status, time,
         installer_id, agent_version,
         router_model, router_firmware, router_mac,
         ssid, pairing_code,
         verify_ssid_broadcast, verify_captive_redirect, verify_wan_internet,
         completed_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?,
              ?, ?,
              ?, ?, ?,
              ?, ?,
              ?, ?, ?,
              ?, ?)
    `).run(
      rowId, resellerId, body.router_id || null, body.router_ip, body.location || null,
      "completed", now,
      body.installer_id, body.agent_version,
      body.router_model || null, body.router_firmware || null, body.router_mac || null,
      body.ssid, body.pairing_code,
      body.verify_ssid_broadcast ? 1 : 0,
      body.verify_captive_redirect ? 1 : 0,
      body.verify_wan_internet ? 1 : 0,
      now, "installer"
    );

    const reseller = await db.prepare("SELECT company_name FROM resellers WHERE id = ?").get(resellerId);

    await db.prepare(`
      INSERT INTO notifications (id, scope, type, title, message, time, read, action_tab, ref_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id("n"), "super_admin", "installer", "Installer session completed",
      `${reseller ? reseller.company_name : "Reseller"} ran the installer for SSID "${body.ssid}" (${body.router_vendor} ${body.router_model || ""}). Awaiting router self-registration.`.trim(),
      now, 0, "installs", rowId
    );

    json(res, 200, { ok: true, installation_id: rowId });
  });

  // ----- POST /api/installer/license/initiate -----
  // Body: { planId, provider }
  // Reseller-authenticated. Resolves the plan price in the reseller's
  // currency, creates a pending payments row with purpose=license, and
  // calls the provider to get a checkout URL. The existing webhook
  // handler activates the license on success (fulfillLicensePayment).
  router.post("/api/installer/license/initiate", async (req, res, { body }) => {
    const auth = authenticate(req, "reseller");
    if (!auth.ok) return json(res, auth.status, { error: auth.error });
    const resellerId = auth.user.id || auth.user.sub;
    if (!resellerId) return json(res, 401, { error: "Token missing reseller id" });

    const { planId, provider } = body || {};
    if (!planId || !provider) return json(res, 400, { error: "planId and provider are required" });

    const enabled = listEnabledProviders();
    if (!enabled.includes(provider)) return json(res, 400, { error: `Provider not enabled: ${provider}` });

    const reseller = await db.prepare(
      "SELECT id, email, company_name, currency FROM resellers WHERE id = ?"
    ).get(resellerId);
    if (!reseller) return json(res, 404, { error: "Reseller not found" });

    const settings = await db.prepare(
      "SELECT platform_currency FROM integration_settings WHERE id = 'singleton'"
    ).get();
    const platformCurrency = settings?.platform_currency || "USD";
    const resellerCurrency = reseller.currency || platformCurrency;

    const plan = await db.prepare(
      "SELECT id, name, price FROM platform_plans WHERE id = ?"
    ).get(planId);
    if (!plan) return json(res, 404, { error: "Plan not found" });

    // Resolve price in reseller's currency (fallback to platform default).
    let row = await db.prepare(
      "SELECT price, enabled FROM plan_prices WHERE plan_id = ? AND currency = ? AND enabled = 1"
    ).get(planId, resellerCurrency);
    let usedCurrency = resellerCurrency;
    if (!row) {
      row = await db.prepare(
        "SELECT price, enabled FROM plan_prices WHERE plan_id = ? AND currency = ? AND enabled = 1"
      ).get(planId, platformCurrency);
      usedCurrency = platformCurrency;
    }
    const amount = row ? Number(row.price) : Number(plan.price);

    const reference = makeLicReference();
    const callbackUrl = `${process.env.APP_URL || "https://www.safelinks.name.ng"}/payment-callback`;

    // Pre-create the payments row so the webhook can reconcile it.
    await db.prepare(`
      INSERT INTO payments
        (id, user_type, user_id, reseller_id, amount, method, status,
         reference, currency, customer_name, customer_email, customer_phone,
         plan_id, router_id, time, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id("p"), "reseller", resellerId, resellerId, amount,
      `online:${provider}`, "pending", reference, usedCurrency,
      reseller.company_name || null, reseller.email || null, null,
      planId, null, Date.now(), "license"
    );

    try {
      const init = await initiateProviderPayment(provider, {
        amountMajor: amount,
        currency: usedCurrency,
        email: reseller.email,
        reference,
        callbackUrl,
        metadata: { reseller_id: resellerId, plan_id: planId, purpose: "license" },
      });
      json(res, 200, {
        ok: true,
        provider,
        reference: init.reference,
        authorizationUrl: init.authorizationUrl,
        amount,
        currency: usedCurrency,
        plan_id: planId,
        plan_name: plan.name,
      });
    } catch (err) {
      json(res, 400, { error: err.message || "Payment initiation failed" });
    }
  });
}
