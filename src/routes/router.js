import { db, id } from "../db.js";
import { json } from "../http.js";
import { verifyPassword } from "../auth.js";
import { ROUTER_OFFLINE_THRESHOLD_MS } from "../db.js";
import { rateLimitByIp } from "../rateLimit.js";

// Routers authenticate with { routerId, apiKey } in the body, not a JWT —
// they aren't users and don't log in through /api/auth/login. The key
// was generated once at Agent Registration (installer step 7) and
// stored hashed, same as a password.
async function authenticateRouter(routerId, apiKey) {
  if (!routerId || !apiKey) return null;
  const router = await db.prepare("SELECT * FROM routers WHERE router_id = ?").get(routerId);
  if (!router) return null;
  if (!verifyPassword(apiKey, router.api_key_hash)) return null;
  return router;
}

export function registerRouterRoutes(router) {
  // POST /api/router/checkin — called by the router's own scheduler every
  // 30 seconds (RouterOS `/system/scheduler`, a cron job on OpenWRT/EdgeOS,
  // etc). Marks the router online, returns whatever commands are queued.
  // The router executes them locally and reports back via the ack route
  // below. No port forwarding or public IP needed — the router always
  // calls out, never gets called.
  router.post("/api/router/checkin", async (req, res, { body }) => {
    if (await rateLimitByIp(req, res, "agent-checkin", { max: 120, windowMs: 15 * 60000 })) return;
    const rt = await authenticateRouter(body.routerId, body.apiKey);
    if (!rt) return json(res, 401, { error: "Invalid router credentials" });

    await db.prepare("UPDATE routers SET last_check_in = ?, status = 'online' WHERE router_id = ?").run(Date.now(), rt.router_id);

    const commandRows = await db.prepare(
      "SELECT id, type, payload, created_at FROM router_commands WHERE router_id = ? AND status = 'pending' ORDER BY created_at ASC"
    ).all(rt.router_id);
    const commands = commandRows.map((c) => ({ ...c, payload: JSON.parse(c.payload) }));

    json(res, 200, { ok: true, commands, nextCheckInSeconds: 30 });
  });

  // POST /api/router/commands/:id/ack — router reports a command's result.
  // body: { routerId, apiKey, status: 'executed' | 'failed', detail? }
  router.post("/api/router/commands/:id/ack", async (req, res, { params, body }) => {
    if (await rateLimitByIp(req, res, "agent-checkin", { max: 120, windowMs: 15 * 60000 })) return;
    const rt = await authenticateRouter(body.routerId, body.apiKey);
    if (!rt) return json(res, 401, { error: "Invalid router credentials" });
    if (!["executed", "failed"].includes(body.status)) return json(res, 400, { error: "status must be executed or failed" });

    const result = await db.prepare(
      "UPDATE router_commands SET status = ?, executed_at = ? WHERE id = ? AND router_id = ?"
    ).run(body.status, Date.now(), params.id, rt.router_id);
    if (result.changes === 0) return json(res, 404, { error: "Command not found for this router" });

    if (body.status === "failed") {
      const reseller = await db.prepare("SELECT company_name FROM resellers WHERE id = ?").get(rt.reseller_id);
      const cmd = await db.prepare("SELECT type FROM router_commands WHERE id = ?").get(params.id);
      await db.prepare("INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)")
        .run(id("n"), `reseller:${rt.reseller_id}`, "alert", "Router command failed",
          `${rt.router_id} reported failure executing '${cmd?.type}'. ${body.detail || ""}`.trim(), Date.now(), 0, "routers");
    }

    json(res, 200, { ok: true });
  });
}

/** Enqueues a command for every router belonging to a reseller. Used by
 *  the reseller routes whenever voucher state changes (create/pause/
 *  resume/delete) — the router picks it up on its next 30s check-in. */
export async function enqueueCommandForReseller(resellerId, type, payload) {
  const routers = await db.prepare("SELECT router_id FROM routers WHERE reseller_id = ?").all(resellerId);
  const now = Date.now();
  for (const r of routers) {
    await db.prepare("INSERT INTO router_commands (id, router_id, type, payload, status, created_at) VALUES (?,?,?,?,?,?)")
      .run(id("cmd"), r.router_id, type, JSON.stringify(payload), "pending", now);
  }
  return routers.length;
}

/** A router is "online" only if it checked in within the last 90s,
 *  computed at read time rather than via a background sweep — no
 *  scheduler process runs continuously in this environment, so this
 *  gets the same user-visible result (accurate status whenever anyone
 *  looks) without one. A real deployment would run this as an actual
 *  periodic job so it can also *push* the alert instead of just
 *  reflecting it on next read. */
export function effectiveRouterStatus(lastCheckIn) {
  if (!lastCheckIn) return "offline";
  return Date.now() - lastCheckIn <= ROUTER_OFFLINE_THRESHOLD_MS ? "online" : "offline";
}
