// Router setup: the single source of the script every installer runs.
//   GET /api/setup/<CODE>.rsc         filled-in safelinks-setup.rsc
//   GET /api/setup/page/<name>.html   hotspot pages (hand-off to the portal)
// Apps (Windows installer, desktop, Android) and the dashboard's copy-paste
// command all run the same one line on the router, so a shared or old app
// download still configures routers with today's script.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { db } from "../db.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(here, "..", "..", "router-scripts", "safelinks-setup.rsc");

// Hosts a customer must reach BEFORE paying.
const GATEWAY_HOSTS = [
  "checkout.paystack.com", "js.paystack.co", "api.paystack.co", "standard.paystack.co", "paystack.com",
  "checkout.flutterwave.com", "api.flutterwave.com",
  "checkout.stripe.com", "js.stripe.com", "m.stripe.network",
  "accounts.google.com",
];

// RouterOS double-quoted string: escape \ " $ and drop control chars.
export const ros = (v) => String(v ?? "").replace(/[\x00-\x1f]/g, "").replace(/[\\"$]/g, (c) => "\\" + c);

export function apiBase(req) {
  const env = process.env.PUBLIC_API_URL || process.env.BACKEND_URL;
  if (env) return env.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${req.headers.host}`;
}
export function portalBase() {
  return (process.env.APP_URL || "https://www.safelinks.name.ng").replace(/\/$/, "");
}

export function setupCommand(apiUrl, code) {
  return `/tool fetch url="${apiUrl}/api/setup/${code}.rsc" dst-path=safelinks-setup.rsc check-certificate=no; :delay 2s; /import safelinks-setup.rsc`;
}

export async function buildSetupScript(req, pc) {
  let cfg = {};
  try { cfg = JSON.parse(pc.config || "{}"); } catch (_) {}
  const api = apiBase(req), portal = portalBase();
  const hosts = new Set([new URL(api).hostname, new URL(portal).hostname, ...GATEWAY_HOSTS]);
  const portalHost = new URL(portal).hostname;
  if (portalHost.startsWith("www.")) hosts.add(portalHost.slice(4));
  const vals = {
    API: api, PORTAL: portal, RID: pc.reseller_id, CODE: pc.code,
    SSID: cfg.ssid || "SafeLinks-WiFi", WIFIPASS: cfg.wifiPassword || "",
    WANMODE: cfg.wanMode === "pppoe" ? "pppoe" : "dhcp", WANIF: cfg.wanInterface || "ether1",
    WANUSER: cfg.wanUser || "", WANPASS: cfg.wanPass || "", ADMINMAC: cfg.adminMac || "",
    HOSTS: [...hosts].filter((h) => /^[a-z0-9.-]+$/i.test(h) && h.includes(".")).join(","),
  };
  return readFileSync(SCRIPT_PATH, "utf8").replace(/__([A-Z]+)__/g, (m, k) => (k in vals ? ros(vals[k]) : m));
}

function page(name, rid) {
  const portal = `${portalBase()}/portal/${encodeURIComponent(rid)}`;
  // $(...) are filled in by the router when it serves the page.
  const targets = {
    "login.html": `${portal}?mac=$(mac-esc)&ip=$(ip)&dst=$(link-orig-esc)&login=$(link-login-only-esc)&err=$(error)`,
    "alogin.html": `$(link-redirect)`,
    "status.html": `${portal}?mac=$(mac-esc)&ip=$(ip)&view=status&login=$(link-login-only-esc)`,
    "logout.html": `${portal}?mac=$(mac-esc)&login=$(link-login-only-esc)`,
  };
  const to = targets[name];
  if (!to) return null;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=${to}"><title>WiFi</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding:48px 16px;color:#334155">
<p>Connecting&hellip;</p><p><a href="${to}">Tap here if nothing happens</a></p></body></html>`;
}

export function registerSetupRoutes(router) {
  router.get("/api/setup/page/:name", async (req, res, { params, query }) => {
    const html = page(params.name, query.rid || "");
    if (!html || !query.rid) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });

  router.get("/api/setup/:file", async (req, res, { params }) => {
    const code = String(params.file || "").replace(/\.rsc$/i, "").trim().toUpperCase();
    const pc = await db.prepare("SELECT * FROM pairing_codes WHERE code = ?").get(code);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    // A failed fetch must still be a valid script that explains itself.
    if (!pc || pc.status === "used" || Number(pc.expires_at) < Date.now()) {
      res.writeHead(410);
      return res.end(':put "SAFE_Links: this setup code is invalid or expired. Create a new one in your dashboard."\n');
    }
    res.writeHead(200);
    res.end(await buildSetupScript(req, pc));
  });
}
