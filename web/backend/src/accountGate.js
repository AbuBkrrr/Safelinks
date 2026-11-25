// Account standing: a reseller who is suspended by the platform, or whose
// license / free trial has run out, can still log in, see everything, renew,
// redeem a product key and contact support, but cannot make changes or take
// NEW customer sales until they renew. Customers who already paid keep their
// time (their logins stay on the router).
import { db } from "./db.js";
import { verifyToken } from "./auth.js";
import { json } from "./http.js";

export async function resellerStanding(resellerId) {
  const r = await db.prepare("SELECT status, subscription_expiry FROM resellers WHERE id = ?").get(resellerId);
  if (!r) return { ok: false, reason: "not_found" };
  if (r.status === "suspended") return { ok: false, reason: "suspended" };
  if (r.subscription_expiry && Number(r.subscription_expiry) < Date.now()) return { ok: false, reason: "expired" };
  return { ok: true };
}

// Reseller writes that stay allowed while blocked, so they can get back in.
const RESELLER_ALLOWED = [
  /^\/api\/reseller\/license/, /^\/api\/reseller\/product-key/, /^\/api\/reseller\/support/,
  /^\/api\/reseller\/notifications/, /^\/api\/reseller\/payout/, /^\/api\/payments\//,
];
// Portal actions that start a NEW sale.
const PORTAL_SALE = /^\/api\/portal\/([^/]+)\/(transfer-checkout|card-checkout|trial|redeem|signup|me\/buy)$/;

/** Returns true when it has already answered the request (blocked). */
export async function accountGate(req, res, pathname) {
  if (req.method === "GET" || req.method === "OPTIONS") return false;
  if (pathname.startsWith("/api/reseller/") && !RESELLER_ALLOWED.some((re) => re.test(pathname))) {
    const h = req.headers["authorization"] || "";
    const p = verifyToken(h.startsWith("Bearer ") ? h.slice(7) : null);
    if (!p || p.role !== "reseller") return false; // normal auth handles it
    const st = await resellerStanding(p.resellerId || p.sub);
    if (!st.ok) {
      json(res, 403, {
        error: st.reason === "suspended"
          ? "Your account is suspended. Renew your license or contact support to continue."
          : "Your license has expired. Renew it in the License tab to continue.",
        code: "account_" + st.reason,
      });
      return true;
    }
  }
  const m = pathname.match(PORTAL_SALE);
  if (m) {
    const st = await resellerStanding(decodeURIComponent(m[1]));
    if (!st.ok && st.reason !== "not_found") {
      json(res, 403, { error: "This WiFi service is temporarily unavailable. Please contact the owner.", code: "service_unavailable" });
      return true;
    }
  }
  return false;
}
