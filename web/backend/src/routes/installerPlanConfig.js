import { db } from "../db.js";
import { json } from "../http.js";
import { authenticate } from "../auth.js";

// GET /api/installer/plan-config
//
// Returns the calling reseller's subscription-plan parameters so the
// native installer can:
//   1. verify the license is active before configuring a router
//   2. fetch the plan-driven DHCP pool range and per-user bandwidth
//   3. detect any pending license renewal (show the awaiting-confirmation UI)
//
// Auth: Bearer JWT, role=reseller.

export function registerInstallerPlanConfigRoutes(router) {
  router.get("/api/installer/plan-config", async (req, res) => {
    const auth = authenticate(req, "reseller");
    if (!auth.ok) return json(res, auth.status, { error: auth.error });
    const resellerId = auth.user.id || auth.user.sub || auth.user.resellerId;
    if (!resellerId) return json(res, 401, { error: "Token missing reseller id" });

    const reseller = await db.prepare(
      "SELECT id, company_name, status, subscription_plan, subscription_expiry FROM resellers WHERE id = ?"
    ).get(resellerId);
    if (!reseller) return json(res, 404, { error: "Reseller not found" });

    const plan = await db.prepare(
      "SELECT id, name, price, max_clients, max_devices_per_client, description, pool_start, pool_end, bandwidth_mbps_per_user FROM platform_plans WHERE id = ?"
    ).get(reseller.subscription_plan);

    const now = Date.now();
    const expiry = Number(reseller.subscription_expiry) || 0;
    const active = reseller.status === "active" && expiry > now;
    const licenseStatus = active ? "active" : (expiry > 0 ? "expired" : "none");

    const pending = await db.prepare(
      "SELECT id, plan_id, amount, method, reference, time FROM license_payment_requests WHERE reseller_id = ? AND status = ? ORDER BY time DESC LIMIT 1"
    ).get(resellerId, "pending");

    json(res, 200, {
      reseller_id: reseller.id,
      reseller_company: reseller.company_name,
      reseller_status: reseller.status,

      plan_id: reseller.subscription_plan,
      plan_name: plan ? plan.name : null,
      plan_price: plan ? plan.price : null,
      max_clients: plan ? plan.max_clients : null,
      max_devices_per_client: plan ? plan.max_devices_per_client : null,
      pool_start: plan ? plan.pool_start : null,
      pool_end: plan ? plan.pool_end : null,
      bandwidth_mbps_per_user: plan ? plan.bandwidth_mbps_per_user : null,

      license_status: licenseStatus,
      license_expiry: expiry,
      license_expires_in_ms: active ? (expiry - now) : 0,

      pending_payment: pending ? {
        id: pending.id,
        plan_id: pending.plan_id,
        amount: pending.amount,
        method: pending.method,
        reference: pending.reference,
        time: pending.time,
      } : null,
    });
  });
}
