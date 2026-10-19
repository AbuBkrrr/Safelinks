import { db, id, genCode } from "../db.js";
import { text } from "../http.js";
import { hashPassword, verifyPassword } from "../auth.js";
import { rateLimitByIp } from "../rateLimit.js";

// ─── Numeric coercion for RouterOS values ──────────────────────
// RouterOS returns uptime as "1w2d3h4m5s" and cpu-load possibly as
// "5%" — both produce NaN when passed through Number(). Postgres BIGINT
// rejects NaN → 500. Coerce every incoming metric safely.
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function rosUptimeToSeconds(v) {
  if (v == null) return 0;
  const s = String(v).trim();
  if (!s) return 0;
  // Pure-number form (already seconds)
  const direct = Number(s);
  if (Number.isFinite(direct) && direct > 0) return direct;
  // RouterOS 7.x time-to-string returns "HH:MM:SS" (e.g. "00:44:24")
  const hms = s.match(/^([0-9]+):([0-9]+):([0-9]+)/);
  if (hms) {
    const h = Number(hms[1]) || 0;
    const m = Number(hms[2]) || 0;
    const sec = Number(hms[3]) || 0;
    return h * 3600 + m * 60 + sec;
  }
  // Fallback: word form "1w2d3h4m5s"
  let total = 0;
  const re = /([0-9]+)([wdhms])/g;
  let mm;
  while ((mm = re.exec(s)) !== null) {
    const n = Number(mm[1]);
    const unit = mm[2];
    const mult = unit === "w" ? 604800
               : unit === "d" ? 86400
               : unit === "h" ? 3600
               : unit === "m" ? 60
               : 1;
    total += n * mult;
  }
  return total;
}


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
  router.get("/api/agent/login.html", (req, res) => {
    const html = `<html><head><title>SAFE_Links</title><script>(function(){var m='$(mac)',i='$(ip)',o='$(link-orig)',u='$(username)',e='$(error)';if(!o||o.length<3)o='http://budgetpro.com.ng/';var rid='$(reseller_id)';
    if(e.length>0){ document.body.innerHTML='<h3>Login failed: '+e+'</h3>'; }
    else if(u.length>0){ document.body.innerHTML='<h3>Logging you in...</h3>'; }
    else { location.replace('https://www.safelinks.name.ng/portal/'+rid+'?mac='+encodeURIComponent(m)+'&ip='+encodeURIComponent(i)+'&dst='+encodeURIComponent(o)); }
    })();</script></head><body style='background:#0f172a;color:#e2e8f0;font-family:sans-serif;text-align:center;padding:40px'><p style='font-size:14px'>Redirecting...</p></body></html>`;
    text(res, 200, html.replace('$(reseller_id)', req.query.rid || 'unknown'));
  });

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


  // GET /api/agent/bootstrap.rsc?code=X
  // Serves the pairing bootstrap .rsc with the code substituted.
  router.get("/api/agent/bootstrap.rsc", async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://x");
      const code = String(url.searchParams.get("code") || "").trim().toUpperCase();
      if (!code) return text(res, 400, "# STATUS ERROR\n# missing code\n");
      const pc = await db.prepare("SELECT code, status, expires_at FROM pairing_codes WHERE code = ?").get(code);
      if (!pc || pc.status === "used" || pc.expires_at < Date.now()) {
        return text(res, 410, "# STATUS ERROR\n# pairing code invalid or expired\n");
      }
      const { readFileSync } = await import("node:fs");
      const { fileURLToPath } = await import("node:url");
      const { dirname, join } = await import("node:path");
      const here = dirname(fileURLToPath(import.meta.url));
      const rscPath = join(here, "..", "resources", "safelinks-agent.rsc");
      let body = readFileSync(rscPath, "utf8");
      body = body.split("PASTE-CODE-HERE").join(code);
      return text(res, 200, body);
    } catch (e) {
      return text(res, 500, "# STATUS ERROR\n# " + (e.message || "read failed") + "\n");
    }
  });

  // GET /api/agent/heartbeat.rsc?rid=X&key=Y
  // Returns a fresh short script: metrics POST + any queued commands.
  router.get("/api/agent/heartbeat.rsc", async (req, res) => {
  // Sweep expired vouchers on every heartbeat so 2-min vouchers actually expire.
  try { await db.prepare("UPDATE vouchers SET status='expired' WHERE status='active' AND expires_at < ?").run(Date.now()); } catch (e) { console.warn('[sweep] voucher expiry failed', e.message); }
    try {
      const url = new URL(req.url || "/", "http://x");
      const rid = String(url.searchParams.get("rid") || "").trim();
      const key = String(url.searchParams.get("key") || "").trim();
      if (!rid || !key) return text(res, 400, "# STATUS ERROR\n# missing creds\n");
      const routerRow = await db.prepare("SELECT id, router_id, api_key_hash FROM routers WHERE router_id = ?").get(rid);
      if (!routerRow) return text(res, 404, "# STATUS ERROR\n# unknown router\n");
      // Accept any non-empty key for now (hash verify can be added later)
      const cmds = await db.prepare(
        "SELECT id, type, payload FROM router_commands WHERE router_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 20"
      ).all(routerRow.id);
      const base = process.env.APP_URL || "https://www.safelinks.name.ng";
      const lines = [];
      // [sweep-r3] Mark expired vouchers + queue unbind/disable — runs on the
      // route the router actually fetches, so 2-min vouchers expire in the UI
      // and clients get kicked off the router on the next heartbeat.
      try {
        const swNow = Date.now();
        const swExpired = await db.prepare(
          "SELECT id, username, reseller_id FROM vouchers WHERE status='active' AND expires_at < ?"
        ).all(swNow);
        if (swExpired.length > 0) {
          await db.prepare("UPDATE vouchers SET status='expired' WHERE status='active' AND expires_at < ?").run(swNow);
          for (const v of swExpired) {
            const swRouters = await db.prepare("SELECT router_id FROM routers WHERE reseller_id = ?").all(v.reseller_id);
            for (const r of swRouters) {
              await db.prepare("INSERT INTO router_commands (id, router_id, type, payload, status, created_at) VALUES (?,?,?,?,?,?)").run(
                id("cmd"), r.router_id, "unbind_mac", JSON.stringify({ username: v.username }), "pending", swNow
              );
              await db.prepare("INSERT INTO router_commands (id, router_id, type, payload, status, created_at) VALUES (?,?,?,?,?,?)").run(
                id("cmd"), r.router_id, "disable_user", JSON.stringify({ username: v.username }), "pending", swNow
              );
            }
          }
          console.log('[sweep-r3] expired ' + swExpired.length + ' voucher(s)');
        }
      } catch (swErr) { console.error('[sweep-r3] failed:', swErr.message); }

      lines.push("# safelinks-cmd.rsc — " + new Date().toISOString());
      lines.push("# " + cmds.length + " pending command(s)");
      lines.push("");
      lines.push(":local slCpu [/system resource get cpu-load]");
      lines.push(":local slRamF [/system resource get free-memory]");
      lines.push(":local slRamT [/system resource get total-memory]");
      lines.push(":local slUp [/system resource get uptime]");
      lines.push(":local slSessions \"\"");
      lines.push(":foreach h in=[/ip hotspot active find] do={ :local m [/ip hotspot active get $h mac-address]; :local ip [/ip hotspot active get $h address]; :local u [/ip hotspot active get $h user]; :local bi [/ip hotspot active get $h bytes-in]; :local bo [/ip hotspot active get $h bytes-out]; :set slSessions ($slSessions . $m . \",\" . $ip . \",\" . $u . \",\" . $bi . \",\" . $bo . \";\") }");
      lines.push(':do { /tool fetch url="' + base + '/api/agent/report" http-method=post http-data="rid=' + rid + '&key=' + key + '&cpu=$slCpu&ramUsed=$slRamF&ramTotal=$slRamT&uptime=$slUp&sessions=$slSessions" output=none } on-error={}');
      lines.push("");
      for (const c of cmds) {
        let p = {};
        try { p = JSON.parse(c.payload || "{}"); } catch (_) {}
        if (c.type === "bind_mac") {
          const mac = String(p.username || p.mac || "").toUpperCase();
          const exp = String(p.password || p.expiresAt || "");
          if (!mac) { await db.prepare("UPDATE router_commands SET status='dropped' WHERE id=?").run(c.id); continue; }
          const macHex = mac.replace(/[^A-Fa-f0-9]/g, "");
          lines.push("/ip hotspot active remove [find mac-address=" + mac + "]");
          lines.push("/ip hotspot ip-binding remove [find mac-address=" + mac + "]");
          if (exp.length >= 19) {
            const d = exp.slice(0, 10);
            const t = exp.slice(11, 19);
            lines.push("/ip hotspot ip-binding add mac-address=" + mac + " type=bypassed comment=\"SAFELinks exp:" + exp + "\"");
            lines.push("/system scheduler remove [find name=\"sl-exp-" + macHex + "\"]");
            lines.push("/system scheduler add name=\"sl-exp-" + macHex + "\" start-date=" + d + " start-time=" + t + " interval=0s on-event=\"/ip hotspot ip-binding remove [find mac-address=" + mac + "]\"");
          } else {
            lines.push("/ip hotspot ip-binding add mac-address=" + mac + " type=bypassed comment=\"SAFELinks\"");
          }
        } else if (c.type === "unbind_mac") {
          const mac = String(p.username || p.mac || "").toUpperCase();
          const macHex = mac.replace(/[^A-Fa-f0-9]/g, "");
          if (mac) {
            lines.push("/ip hotspot active remove [find mac-address=" + mac + "]");
            lines.push("/ip hotspot ip-binding remove [find mac-address=" + mac + "]");
            lines.push("/system scheduler remove [find name=\"sl-exp-" + macHex + "\"]");
          }
        } else if (c.type === "set_ssid") {
          const ssid = String(p.ssid || "");
          lines.push(':do { /interface wireless set [find] ssid="' + ssid + '" } on-error={}');
          lines.push(':do { /interface wifi set [find] ssid="' + ssid + '" } on-error={}');
        } else if (c.type === "create_user") {
          const u = String(p.username || "");
          const pw = String(p.password || "");
          lines.push('/ip hotspot user remove [find name="' + u + '"]');
          lines.push('/ip hotspot user add name="' + u + '" password="' + pw + '"');
        } else if (c.type === "enable_user") {
          lines.push('/ip hotspot user enable [find name="' + String(p.username || "") + '"]');
        } else if (c.type === "disable_user") {
          lines.push('/ip hotspot user disable [find name="' + String(p.username || "") + '"]');
        } else if (c.type === "delete_user") {
          lines.push('/ip hotspot user remove [find name="' + String(p.username || "") + '"]');
        } else {
          await db.prepare("UPDATE router_commands SET status='dropped' WHERE id=?").run(c.id);
          continue;
        }
        // Tell the router to acknowledge the command so it doesn't stay stuck
        lines.push(':do { /tool fetch url="' + base + '/api/agent/commands/' + c.id + '/ack" http-method=post http-data="status=completed" output=none } on-error={}');
        await db.prepare("UPDATE router_commands SET status='sent' WHERE id=?").run(c.id);
      }
      return text(res, 200, lines.join("\n") + "\n");
    } catch (e) {
      return text(res, 500, "# STATUS ERROR\n# " + (e.message || "heartbeat failed") + "\n");
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

    await db.prepare("INSERT INTO routers (id,reseller_id,router_id,api_key_hash,api_key,model,firmware,last_check_in,status) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id("rt"), resellerId, routerId, hashPassword(apiKey), apiKey, body.model || body.identity || "Unknown", body.firmware || "Unknown", now, "online");
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
      lines.push(`CMD ${c.id} ${c.type} ${p.username || "-"} ${p.password || "-"} ${p.deviceLimit || "-"} ${p.bandwidthMbps || "-"} ${p.uptime || '1d'}`);
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
    // FIX: accept flat form encoding — heartbeat.rsc sends rid/key/cpu/...
    // Form-encoded bodies arrive as { rid, key, cpu, ramUsed, ramTotal, uptime, sessions? }
    // JSON bodies arrive as { router_id, api_key, metrics: {...}, sessions: [...] }
    // Normalize both into the same shape the rest of this handler expects.
    const b = body || {};
    const router_id = b.router_id || b.rid;
    const api_key = b.api_key || b.key;
    if (!router_id || !api_key) return err(res, 400, "router_id/rid and api_key/key required");
    const rt = await db.prepare("SELECT router_id, reseller_id, api_key_hash FROM routers WHERE router_id = ?").get(router_id);
    if (!rt) return err(res, 404, "unknown router");
    // Codevertex-style: prefer plaintext comparison (register stores the
    // exact string now). Fall back to sha256 for old rows where only the
    // bcrypt hash exists — but note old bcrypt rows were never comparable
    // to sha256, so those routers must re-register once.
    const rtFull = await db.prepare("SELECT api_key, api_key_hash FROM routers WHERE router_id = ?").get(router_id);
    let authed = false;
    if (rtFull && rtFull.api_key && rtFull.api_key === api_key) authed = true;
    if (!authed) {
      const crypto = await import("node:crypto");
      const h = crypto.createHash("sha256").update(api_key).digest("hex");
      if (rtFull && h === rtFull.api_key_hash) authed = true;
    }
    if (!authed) return err(res, 401, "bad api key");

    const now = Date.now();
    console.log("[agent/report] rid=" + router_id + " keyLen=" + String(api_key).length + " hasMetrics=" + !!(b.metrics || b.cpu !== undefined || b.ramUsed !== undefined) + " hasSessions=" + (typeof b.sessions === "string" ? b.sessions.length + "chars" : Array.isArray(b.sessions) ? b.sessions.length + "items" : "no"));
    // Refresh online state — proves the router is polling even if metrics are wrong
    try {
      await db.prepare("UPDATE routers SET last_check_in = ?, status = 'online' WHERE router_id = ?").run(now, router_id);
    } catch (_) {}

    // Normalize metrics + sessions into the shape this handler expects
    const metricsFromFlat = {
      cpu: b.cpu,
      ramUsed: b.ramUsed,
      ramTotal: b.ramTotal,
      uptime: b.uptime,
    };
    const metrics = b.metrics || metricsFromFlat;
    let sessions = b.sessions;
    if (typeof sessions === "string" && sessions.length > 0) {
      sessions = sessions.split(";").filter(s => s.trim()).map(row => {
        const parts = row.split(",");
        return {
          mac: parts[0] || "",
          ip: parts[1] || null,
          username: parts[2] || null,
          bytesIn: Number(parts[3] || 0),
          bytesOut: Number(parts[4] || 0),
        };
      });
    } else if (!Array.isArray(sessions)) {
      sessions = [];
    }
    // Upsert router metrics
    if (metrics && (metrics.cpu !== undefined || metrics.ramUsed !== undefined)) {
      console.log("[agent/report] uptime_raw=" + JSON.stringify(metrics.uptime) + " parsed=" + rosUptimeToSeconds(metrics.uptime));
      await db.prepare(`INSERT INTO router_metrics (router_id, reseller_id, cpu_load, ram_used, ram_total, uptime_seconds, active_user_count, updated_at)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT (router_id) DO UPDATE SET cpu_load=EXCLUDED.cpu_load, ram_used=EXCLUDED.ram_used, ram_total=EXCLUDED.ram_total, uptime_seconds=EXCLUDED.uptime_seconds, active_user_count=EXCLUDED.active_user_count, updated_at=EXCLUDED.updated_at`)
        .run(router_id, rt.reseller_id, num(metrics.cpu), num(metrics.ramUsed), num(metrics.ramTotal), rosUptimeToSeconds(metrics.uptime), Array.isArray(sessions) ? sessions.length : 0, now);
    }

    // Refresh active sessions (delete then insert — simplest correct pattern)
    await db.prepare("DELETE FROM active_sessions WHERE router_id = ?").run(router_id);
    if (Array.isArray(sessions)) {
      for (const s of sessions) {
        if (!s.mac) continue;
        await db.prepare(`INSERT INTO active_sessions (id, router_id, reseller_id, mac, ip, username, bytes_in, bytes_out, started_at, last_seen)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(id("as"), router_id, rt.reseller_id, String(s.mac), s.ip || null, s.username || null,
               num(s.bytesIn), num(s.bytesOut), num(s.startedAt) || now, now);
      }
    }

    return ok(res, ["report accepted", "metrics=" + (metrics ? "yes" : "no"), "sessions=" + (Array.isArray(sessions) ? sessions.length : 0)]);
  });

}
