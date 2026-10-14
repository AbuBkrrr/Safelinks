import { db, id, genCode } from "../db.js";
import { text } from "../http.js";
import { hashPassword, verifyPassword } from "../auth.js";
import { rateLimitByIp } from "../rateLimit.js";

// The zero-touch, self-registering router agent protocol. Everything
// here speaks plain `KEY value` lines, one per line — NOT JSON.
// RouterOS's scripting language has no JSON parser worth relying on,
// but splitting on "\n" and pulling out a value after the first space
// is three lines of RouterOS script. See router-scripts/safelinks-agent.rsc
// for the actual device-side script that talks to these endpoints.
//
// This is the flow that replaces a human typing the router's model,
// firmware, and IP into a web form: the reseller generates a
// short-lived pairing code (POST /api/reseller/pairing-codes), reads
// it out to whoever's at the router, and that one code is the only
// thing that gets typed in *anywhere* by hand. The router reports its
// own model/firmware and registers itself.

function ok(res, lines) {
  text(res, 200, `STATUS OK\n${lines.join("\n")}\n`);
}
function err(res, status, message) {
  text(res, status, `STATUS ERROR\nMESSAGE ${message}\n`);
}

export function registerAgentRoutes(router) {
  // GET /api/agent/install/:code
  // Serves the agent RSC with the pairing code pre-injected. Router fetches
  // this over its own WAN via /tool fetch, then /import's it locally.
  // Avoids any large-file SSH transfer + escaping hazards.
  router.get("/api/agent/install/:code", async (req, res, { params }) => {
    const code = String(params.code || "").trim().toUpperCase();
    if (!code) return text(res, 400, "STATUS ERROR\nMESSAGE missing code\n");
    const pc = await db.prepare("SELECT code, status, expires_at FROM pairing_codes WHERE code = ?").get(code);
    if (!pc || pc.status === "used" || pc.expires_at < Date.now()) {
      return text(res, 410, "STATUS ERROR\nMESSAGE pairing code invalid or expired\n");
    }
    try {
      const { readFileSync } = await import("node:fs");
      const { fileURLToPath } = await import("node:url");
      const { dirname, join } = await import("node:path");
      const here = dirname(fileURLToPath(import.meta.url));
      const rscPath = join(here, "..", "resources", "safelinks-agent.rsc");
      let body = readFileSync(rscPath, "utf8");
      body = body.replace("PASTE-CODE-HERE", code);
      text(res, 200, body);
    } catch (e) {
      text(res, 500, "STATUS ERROR\nMESSAGE " + (e.message || "read failed") + "\n");
    }
  });


  // POST /api/agent/register
  // body (form-encoded): code, model, firmware, identity
  // Called ONCE by the router itself, using the pairing code a human
  // typed in. Everything else — model, firmware, the router's own
  // /system identity name — comes from the device, not a person.
  router.post("/api/agent/register", async (req, res, { body }) => {
    // Pairing codes are 6 characters, human-typed by design — that's a
    // real keyspace against a patient attacker without a limit here.
    // 20 attempts / 15 min / IP (matching the code's own expiry window)
    // makes brute-forcing one within its lifetime infeasible from a
    // single source.
    if (await rateLimitByIp(req, res, "agent-register", { max: 20, windowMs: 15 * 60000, respond: "text" })) return;
    const code = (body.code || "").trim().toUpperCase();
    if (!code) return err(res, 400, "code is required");

    const pc = await db.prepare("SELECT * FROM pairing_codes WHERE code = ?").get(code);
    if (!pc) return err(res, 404, "unknown pairing code");
    if (pc.status === "used") return err(res, 409, "pairing code already used");
    if (pc.expires_at < Date.now()) return err(res, 410, "pairing code expired — generate a new one");

    const resellerId = pc.reseller_id;
    const now = Date.now();
    const routerId = `RTR-${resellerId.slice(-4).toUpperCase()}-${genCode(3)}`;
    const apiKey = `sk_${genCode(24)}`;

    await db.prepare("INSERT INTO routers (id,reseller_id,router_id,api_key_hash,model,firmware,last_check_in,status) VALUES (?,?,?,?,?,?,?,?)")
      .run(id("rt"), resellerId, routerId, hashPassword(apiKey), body.model || body.identity || "Unknown", body.firmware || "Unknown", now, "online");
    await db.prepare("INSERT INTO installations (id,reseller_id,router_id,ip,location,status,time) VALUES (?,?,?,?,?,?,?)")
      .run(id("i"), resellerId, routerId, body.ip || null, body.identity || null, "completed", now);
    await db.prepare("UPDATE pairing_codes SET status = 'used', router_id = ?, used_at = ? WHERE id = ?").run(routerId, now, pc.id);

    const reseller = await db.prepare("SELECT company_name FROM resellers WHERE id = ?").get(resellerId);
    await db.prepare("INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)")
      .run(id("n"), "super_admin", "install", "New reseller installation",
        `${reseller.company_name} completed a zero-touch installation (${routerId}) — now online.`, now, 0, "installs");

    // Sync every currently-active voucher onto the freshly provisioned
    // router, same as the manual registration path.
    const activeVouchers = await db.prepare("SELECT username, password, plan_id FROM vouchers WHERE reseller_id = ? AND status = 'active'").all(resellerId);
    for (const v of activeVouchers) {
      const plan = await db.prepare("SELECT device_limit, bandwidth FROM plans WHERE id = ?").get(v.plan_id);
      await db.prepare("INSERT INTO router_commands (id, router_id, type, payload, status, created_at) VALUES (?,?,?,?,?,?)")
        .run(id("cmd"), routerId, "create_user", JSON.stringify({ username: v.username, password: v.password, deviceLimit: plan?.device_limit, bandwidthMbps: plan?.bandwidth }), "pending", now);
    }

    // ROUTER_ID and API_KEY are returned ONLY in this one response —
    // exactly like the manual path, the server never re-sends the
    // plaintext key again after this.
    ok(res, [`ROUTER_ID ${routerId}`, `API_KEY ${apiKey}`, `SYNCED_VOUCHERS ${activeVouchers.length}`]);
  });

  // POST /api/agent/checkin — same semantics as /api/router/checkin,
  // just plain-text in and out instead of JSON, for the RouterOS agent.
  // body (form-encoded): router_id, api_key
  router.post("/api/agent/checkin", async (req, res, { body }) => {
    // A legitimate router calls this every 30s (~30/15min). 120/15min/IP
    // comfortably covers several routers sharing one NAT'd IP while
    // still catching a flood.
    if (await rateLimitByIp(req, res, "agent-checkin", { max: 120, windowMs: 15 * 60000, respond: "text" })) return;
    const rt = await db.prepare("SELECT * FROM routers WHERE router_id = ?").get(body.router_id);
    if (!rt || !verifyPassword(body.api_key || "", rt.api_key_hash)) return err(res, 401, "invalid router credentials");

    await db.prepare("UPDATE routers SET last_check_in = ?, status = 'online' WHERE router_id = ?").run(Date.now(), rt.router_id);

    const commands = await db.prepare(
      "SELECT id, type, payload FROM router_commands WHERE router_id = ? AND status = 'pending' ORDER BY created_at ASC"
    ).all(rt.router_id);

    // One line per command: CMD <id> <type> <username> <password> <deviceLimit> <bandwidthMbps>
    // Fixed field order, blank fields left empty — trivial to split on
    // spaces in RouterOS script, unlike parsing real JSON.
    const lines = [`NEXT_CHECKIN 30`, `COMMAND_COUNT ${commands.length}`];
    for (const c of commands) {
      const p = JSON.parse(c.payload);
      lines.push(`CMD ${c.id} ${c.type} ${p.username || "-"} ${p.password || "-"} ${p.deviceLimit || "-"} ${p.bandwidthMbps || "-"}`);
    }
    ok(res, lines);
  });

  // POST /api/agent/commands/:id/ack
  // body (form-encoded): router_id, api_key, status (executed|failed), detail?
  router.post("/api/agent/commands/:id/ack", async (req, res, { params, body }) => {
    if (await rateLimitByIp(req, res, "agent-checkin", { max: 120, windowMs: 15 * 60000, respond: "text" })) return;
    const rt = await db.prepare("SELECT * FROM routers WHERE router_id = ?").get(body.router_id);
    if (!rt || !verifyPassword(body.api_key || "", rt.api_key_hash)) return err(res, 401, "invalid router credentials");
    if (!["executed", "failed"].includes(body.status)) return err(res, 400, "status must be executed or failed");

    const result = await db.prepare("UPDATE router_commands SET status = ?, executed_at = ? WHERE id = ? AND router_id = ?")
      .run(body.status, Date.now(), params.id, rt.router_id);
    if (result.changes === 0) return err(res, 404, "command not found for this router");

    if (body.status === "failed") {
      const cmd = await db.prepare("SELECT type FROM router_commands WHERE id = ?").get(params.id);
      await db.prepare("INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)")
        .run(id("n"), `reseller:${rt.reseller_id}`, "alert", "Router command failed",
          `${rt.router_id} reported failure executing '${cmd?.type}'. ${body.detail || ""}`.trim(), Date.now(), 0, "routers");
    }
    ok(res, ["ACK OK"]);
  });
  // POST /api/agent/report
  // Router agent posts metrics + currently connected clients every 30s.
  // Body: { router_id, api_key, metrics: {cpu, ramUsed, ramTotal, uptime}, sessions: [{mac, ip, username, bytesIn, bytesOut, startedAt}] }
  router.post("/api/agent/report", async (req, res, { body }) => {
    const { router_id, api_key, metrics, sessions } = body || {};
    if (!router_id || !api_key) return err(res, 400, "router_id and api_key required");
    const rt = await db.prepare("SELECT router_id, reseller_id, api_key_hash FROM routers WHERE router_id = ?").get(router_id);
    if (!rt) return err(res, 404, "unknown router");
    const crypto = await import("node:crypto");
    const h = crypto.createHash("sha256").update(api_key).digest("hex");
    if (h !== rt.api_key_hash) return err(res, 401, "bad api key");

    const now = Date.now();
    // Upsert router metrics
    if (metrics) {
      await db.prepare(`INSERT INTO router_metrics (router_id, reseller_id, cpu_load, ram_used, ram_total, uptime_seconds, active_user_count, updated_at)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT (router_id) DO UPDATE SET cpu_load=EXCLUDED.cpu_load, ram_used=EXCLUDED.ram_used, ram_total=EXCLUDED.ram_total, uptime_seconds=EXCLUDED.uptime_seconds, active_user_count=EXCLUDED.active_user_count, updated_at=EXCLUDED.updated_at`)
        .run(router_id, rt.reseller_id, Number(metrics.cpu || 0), Number(metrics.ramUsed || 0), Number(metrics.ramTotal || 0), Number(metrics.uptime || 0), Array.isArray(sessions) ? sessions.length : 0, now);
    }

    // Refresh active sessions (delete then insert — simplest correct pattern)
    await db.prepare("DELETE FROM active_sessions WHERE router_id = ?").run(router_id);
    if (Array.isArray(sessions)) {
      for (const s of sessions) {
        if (!s.mac) continue;
        await db.prepare(`INSERT INTO active_sessions (id, router_id, reseller_id, mac, ip, username, bytes_in, bytes_out, started_at, last_seen)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(id("as"), router_id, rt.reseller_id, String(s.mac), s.ip || null, s.username || null,
               Number(s.bytesIn || 0), Number(s.bytesOut || 0), Number(s.startedAt || now), now);
      }
    }

    return ok(res, ["report accepted", "metrics=" + (metrics ? "yes" : "no"), "sessions=" + (Array.isArray(sessions) ? sessions.length : 0)]);
  });

}
