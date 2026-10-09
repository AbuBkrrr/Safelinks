import { db, id } from "../db.js";
import { json } from "../http.js";
import { authenticate } from "../auth.js";

// Native-installer session recording. The SAFE_Links Tauri installer pushes
// the .rsc scripts onto the router over SSH; the router then self-registers
// via the EXISTING POST /api/agent/register endpoint (see routes/agent.js)
// using a pairing code. That endpoint is what actually creates the `routers`
// row and enqueues voucher syncs.
//
// This endpoint does NOT duplicate that flow. It records the installer-side
// view of the same session so:
//   - the reseller dashboard can show "installer wizard was used"
//   - Super Admin gets a second notification in case the router never
//     actually reaches the backend (e.g. site has no working WAN yet)
//   - the two views can be joined later on pairing_code for a full audit
//
// Auth: Bearer JWT, role=reseller.

export function registerInstallerRoutes(router) {
  router.post("/api/installer/session", async (req, res, { body }) => {
    const auth = authenticate(req, "reseller");
    if (!auth.ok) return json(res, auth.status, { error: auth.error });
    const resellerId = auth.user.id || auth.user.sub;
    if (!resellerId) return json(res, 401, { error: "Token missing reseller id" });

    const requiredStrings = [
      "installer_id",
      "agent_version",
      "router_ip",
      "router_vendor",
      "ssid",
      "pairing_code",
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
      rowId,
      resellerId,
      body.router_id || null,
      body.router_ip,
      body.location || null,
      "completed",
      now,
      body.installer_id,
      body.agent_version,
      body.router_model || null,
      body.router_firmware || null,
      body.router_mac || null,
      body.ssid,
      body.pairing_code,
      body.verify_ssid_broadcast ? 1 : 0,
      body.verify_captive_redirect ? 1 : 0,
      body.verify_wan_internet ? 1 : 0,
      now,
      "installer"
    );

    const reseller = await db.prepare(
      "SELECT company_name FROM resellers WHERE id = ?"
    ).get(resellerId);

    await db.prepare(`
      INSERT INTO notifications
        (id, scope, type, title, message, time, read, action_tab, ref_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id("n"),
      "super_admin",
      "installer",
      "Installer session completed",
      `${reseller ? reseller.company_name : "Reseller"} ran the installer for SSID "${body.ssid}" (${body.router_vendor} ${body.router_model || ""}). Awaiting router self-registration.`.trim(),
      now,
      0,
      "installs",
      rowId
    );

    json(res, 200, { ok: true, installation_id: rowId });
  });
}