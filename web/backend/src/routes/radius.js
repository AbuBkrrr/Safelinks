import { db } from "../db.js";
import { authenticate } from "../auth.js";
import { json } from "../http.js";

// ────────── RADIUS foundation ──────────
// The RADIUS daemon (FreeRADIUS) reads from radcheck + radreply.
// Railway doesn't expose UDP, so the daemon runs on a small VPS that
// points at the same Postgres. These endpoints just keep the tables
// in sync — they work today, no daemon required for the API to function.

async function upsertRadiusUser({ username, password, expiresAt, bandwidthMbps, filterId }) {
  await db.prepare("DELETE FROM radcheck WHERE username = ?").run(username);
  await db.prepare("DELETE FROM radreply WHERE username = ?").run(username);

  await db.prepare(
    "INSERT INTO radcheck (username, attribute, op, value) VALUES (?, ?, ?, ?)"
  ).run(username, "Cleartext-Password", ":=", password);

  if (expiresAt) {
    const secondsUntilExpiry = Math.max(60, Math.floor((expiresAt - Date.now()) / 1000));
    await db.prepare(
      "INSERT INTO radreply (username, attribute, op, value) VALUES (?, ?, ?, ?)"
    ).run(username, "Session-Timeout", ":=", String(secondsUntilExpiry));
  }

  if (bandwidthMbps) {
    await db.prepare(
      "INSERT INTO radreply (username, attribute, op, value) VALUES (?, ?, ?, ?)"
    ).run(username, "Mikrotik-Rate-Limit", ":=", `${bandwidthMbps}M/${bandwidthMbps}M`);
  }

  // Filter-Id — used by vendors (Cisco, TP-Link) to apply ACL/policy.
  // Convention: "suspended" routes blocked users to payment page.
  if (filterId) {
    await db.prepare(
      "INSERT INTO radreply (username, attribute, op, value) VALUES (?, ?, ?, ?)"
    ).run(username, "Filter-Id", ":=", filterId);
  }
}

async function revokeRadiusUser(username) {
  await db.prepare("DELETE FROM radcheck WHERE username = ?").run(username);
  await db.prepare("DELETE FROM radreply WHERE username = ?").run(username);
}

export function registerRadiusRoutes(router) {
  // POST /api/radius/sync — writes voucher to RADIUS tables
  router.post("/api/radius/sync", async (req, res, { body }) => {
    const auth = authenticate(req, "reseller");
    if (!auth.ok) return json(res, auth.status, { error: auth.error });
    const resellerId = auth.user.id || auth.user.sub;
    const b = body || {};
    if (!b.username || !b.password) return json(res, 400, { error: "username + password required" });

    const v = await db.prepare(
      "SELECT * FROM vouchers WHERE username = ? AND reseller_id = ?"
    ).get(b.username, resellerId);
    if (!v) return json(res, 404, { error: "voucher not found for this reseller" });

    await upsertRadiusUser({
      username: b.username,
      password: b.password,
      expiresAt: b.sessionTimeout ? Date.now() + b.sessionTimeout * 1000 : Number(v.expires_at),
      bandwidthMbps: b.bandwidthMbps || null,
      filterId: b.filterId || null,
    });

    return json(res, 200, { ok: true, synced: b.username });
  });

  // POST /api/radius/revoke — removes entries so RADIUS returns Access-Reject
  router.post("/api/radius/revoke", async (req, res, { body }) => {
    const auth = authenticate(req, "reseller");
    if (!auth.ok) return json(res, auth.status, { error: auth.error });
    const resellerId = auth.user.id || auth.user.sub;
    const b = body || {};
    if (!b.username) return json(res, 400, { error: "username required" });

    const v = await db.prepare(
      "SELECT id FROM vouchers WHERE username = ? AND reseller_id = ?"
    ).get(b.username, resellerId);
    if (!v) return json(res, 404, { error: "voucher not found" });

    await revokeRadiusUser(b.username);
    return json(res, 200, { ok: true, revoked: b.username });
  });

  // GET /api/radius/status — health + row counts
  router.get("/api/radius/status", async (req, res) => {
    try {
      const c = await db.prepare("SELECT COUNT(*) AS c FROM radcheck").get();
      const r = await db.prepare("SELECT COUNT(*) AS c FROM radreply").get();
      const n = await db.prepare("SELECT COUNT(*) AS c FROM nas").get();
      return json(res, 200, {
        ok: true,
        radcheckRows: Number(c.c) || 0,
        radreplyRows: Number(r.c) || 0,
        nasRows: Number(n.c) || 0,
        note: "RADIUS daemon must run separately — Railway doesn't expose UDP",
      });
    } catch (e) {
      return json(res, 500, { error: String(e.message || e) });
    }
  });

  // GET /api/agent/wg-config?rid=X&key=Y — returns WireGuard peer config text
  router.get("/api/agent/wg-config", async (req, res, { body }) => {
    try {
      const url = new URL(req.url || "/", "http://x");
      const rid = String(url.searchParams.get("rid") || "").trim();
      const key = String(url.searchParams.get("key") || "").trim();
      if (!rid || !key) return json(res, 400, { error: "rid + key required" });

      const routerRow = await db.prepare(
        "SELECT id, router_id FROM routers WHERE router_id = ?"
      ).get(rid);
      if (!routerRow) return json(res, 404, { error: "unknown router" });

      // Stage 1: return a template. Real WG server address + public key
      // come from a config env once the VPS is deployed.
      const wgServer = process.env.WG_SERVER_ADDR || "vps.safelinks.name.ng:51820";
      const wgServerPub = process.env.WG_SERVER_PUBKEY || "<not-configured>";
      const wgPeerIp = `10.99.0.${100 + (parseInt(routerRow.id.replace(/\D/g, "").slice(-4) || "0", 10) % 150)}`;

      const config = [
        `[Interface]`,
        `# Router: ${rid}`,
        `# PrivateKey: <generate on router: /interface/wireguard add name=slwg listen-port=13231>`,
        `Address = ${wgPeerIp}/24`,
        `DNS = 10.99.0.1`,
        ``,
        `[Peer]`,
        `PublicKey = ${wgServerPub}`,
        `Endpoint = ${wgServer}`,
        `AllowedIPs = 10.99.0.0/24`,
        `PersistentKeepalive = 25`,
        ``,
        `# After this tunnel is up:`,
        `#   /radius add service=hotspot address=${wgPeerIp.replace(/\.\d+$/,".1")} secret=<your-nas-secret>`,
        `#   /ip hotspot profile set [find] use-radius=yes`,
      ].join("\n");

      return json(res, 200, { ok: true, peerIp: wgPeerIp, config });
    } catch (e) {
      return json(res, 500, { error: String(e.message || e) });
    }
  });
}