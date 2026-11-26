// Super-admin marketing: tracking links (QR / WhatsApp / social), the public
// pitch page's visit + lead endpoints, device-level "same device or shared?"
// analytics, audience (location / device / language / source), funnel to
// signups and paying resellers, lead follow-up, ad-pixel settings.
//
// Device identity: the pitch page keeps a random ID in the visitor's browser
// (no personal data) and sends it on every open. Without it we fall back to
// a rough signature (phone model, screen, timezone, language), which cannot
// tell two identical phones apart. Private windows, cleared data or another
// browser (e.g. WhatsApp's in-app browser vs Chrome) appear as new devices,
// so "Shared" is a strong hint, not proof.
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { db, id } from "../db.js";
import { json } from "../http.js";
import { authenticate } from "../auth.js";
import { rateLimitByIp } from "../rateLimit.js";
import { sendMessage, normalizePhone } from "../notify.js";

const require = createRequire(import.meta.url);
let geoip = null;
function geo(ip) {
  try {
    if (!geoip) geoip = require("geoip-lite"); // ~140 MB, loaded on first visit only
    const g = ip ? geoip.lookup(ip) : null;
    return g ? { country: g.country || null, region: g.region || null, city: g.city || null, lat: g.ll?.[0] ?? null, lon: g.ll?.[1] ?? null } : {};
  } catch (_) { return {}; }
}

export async function migrateMarketing() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS mkt_links (
      id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, label TEXT, channel TEXT, campaign TEXT,
      created_at BIGINT, archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS mkt_visits (
      id TEXT PRIMARY KEY, slug TEXT, device_key TEXT, device_no INTEGER, open_no INTEGER, new_device INTEGER,
      ip_prefix TEXT, country TEXT, region TEXT, city TEXT, lat REAL, lon REAL, timezone TEXT, lang TEXT,
      ua TEXT, os TEXT, browser TEXT, device_type TEXT, model TEXT, screen TEXT, referrer TEXT, in_app TEXT,
      utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, created_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_mkt_visits_slug ON mkt_visits(slug, created_at);
    CREATE INDEX IF NOT EXISTS idx_mkt_visits_dev ON mkt_visits(slug, device_key);
    CREATE TABLE IF NOT EXISTS mkt_leads (
      id TEXT PRIMARY KEY, slug TEXT, device_key TEXT, name TEXT, email TEXT, phone TEXT, company TEXT,
      message TEXT, country TEXT, city TEXT, status TEXT NOT NULL DEFAULT 'new', created_at BIGINT
    );
    ALTER TABLE resellers ADD COLUMN IF NOT EXISTS mkt_slug TEXT;
    ALTER TABLE resellers ADD COLUMN IF NOT EXISTS mkt_device_key TEXT;
    ALTER TABLE integration_settings ADD COLUMN IF NOT EXISTS meta_pixel_id TEXT;
    ALTER TABLE integration_settings ADD COLUMN IF NOT EXISTS ga_measurement_id TEXT;
  `);
}

// ---- helpers -----------------------------------------------------------
const clean = (v, n = 120) => (v == null ? null : String(v).replace(/[\x00-\x1f]/g, "").slice(0, n) || null);
const NO_LABEL = "(no label)";

function clientIp(req) {
  // Caddy (front) replaces any client-sent X-Forwarded-For, nginx appends;
  // so the left-most entry is the real visitor.
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.socket?.remoteAddress?.replace(/^::ffff:/, "") || "";
}
const ipPrefix = (ip) => (ip.includes(":") ? ip.split(":").slice(0, 3).join(":") + "::" : ip.split(".").slice(0, 3).join(".") + ".0");

export function parseUA(ua = "") {
  const u = String(ua);
  let os = "Other", model = null, type = "desktop", browser = "Other", inApp = null;
  if (/iPhone/.test(u)) { os = "iOS"; model = "iPhone"; type = "phone"; }
  else if (/iPad/.test(u)) { os = "iPadOS"; model = "iPad"; type = "tablet"; }
  else if (/Android/.test(u)) {
    os = "Android"; type = /Mobile/.test(u) ? "phone" : "tablet";
    const m = u.match(/Android [\d.]+; (?:[a-z]{2}-[a-z]{2}; )?([^;)]+?)(?: Build|\))/i);
    model = m ? m[1].trim() : "Android";
  } else if (/Windows/.test(u)) os = "Windows";
  else if (/Mac OS X/.test(u)) os = "macOS";
  else if (/Linux/.test(u)) os = "Linux";
  if (/FBAN|FBAV|FB_IAB/.test(u)) inApp = "Facebook";
  else if (/Instagram/.test(u)) inApp = "Instagram";
  else if (/WhatsApp/i.test(u)) inApp = "WhatsApp";
  else if (/musical_ly|TikTok|BytedanceWebview/i.test(u)) inApp = "TikTok";
  else if (/Twitter/i.test(u)) inApp = "X";
  else if (/LinkedInApp/i.test(u)) inApp = "LinkedIn";
  else if (/Telegram/i.test(u)) inApp = "Telegram";
  if (/Edg\//.test(u)) browser = "Edge";
  else if (/OPR\/|Opera/.test(u)) browser = "Opera";
  else if (/SamsungBrowser/.test(u)) browser = "Samsung Internet";
  else if (/UCBrowser/.test(u)) browser = "UC Browser";
  else if (/Firefox|FxiOS/.test(u)) browser = "Firefox";
  else if (/CriOS|Chrome/.test(u)) browser = "Chrome";
  else if (/Safari/.test(u)) browser = "Safari";
  if (inApp) browser = `${inApp} in-app`;
  return { os, model, type, browser, inApp };
}

// Device key: the browser's random ID, or a hashed signature fallback.
function deviceKey(b, ua) {
  const idv = String(b?.deviceId || "").trim();
  if (/^[A-Za-z0-9_-]{12,64}$/.test(idv)) return "id:" + idv;
  const p = parseUA(ua);
  const sig = [p.model || p.os, b?.screen || "", b?.tz || "", b?.lang || ""].join("|");
  return "sig:" + crypto.createHash("sha256").update(sig).digest("hex").slice(0, 16);
}

function verdict(devices, opens) {
  if (!opens) return "No opens yet";
  if (devices <= 1) return `1 device, opened ${opens}×`;
  return `Shared · ${devices} devices`;
}

function superAdmin(req, res) {
  const a = authenticate(req, "super_admin");
  if (!a.ok) { json(res, a.status, { error: a.error }); return false; }
  return true;
}

// One open at a time per link, so two quick requests can't both claim
// "new device" or the same device number.
const locks = new Map();
async function withLock(k, fn) {
  const prev = locks.get(k) || Promise.resolve();
  let release; const mine = new Promise((r) => (release = r));
  const chain = prev.then(() => mine); locks.set(k, chain);
  await prev;
  try { return await fn(); } finally { release(); if (locks.get(k) === chain) locks.delete(k); }
}
const DEDUPE_MS = 5000; // a reload/double-fire within 5s is the same open

// ---- routes ------------------------------------------------------------
export function registerMarketingRoutes(router) {
  // Public: one open of the pitch page.
  router.post("/api/mkt/visit", async (req, res, { body }) => {
    if (await rateLimitByIp(req, res, "mkt-visit", { max: 120, windowMs: 15 * 60000 })) return;
    const b = body || {};
    const slug = clean(b.slug, 64) || "";
    const ua = String(req.headers["user-agent"] || "");
    const key = deviceKey(b, ua);
    const out = await withLock(slug, async () => {
    const last = await db.prepare("SELECT device_no, open_no, new_device, country, city, created_at FROM mkt_visits WHERE slug = ? AND device_key = ? ORDER BY created_at DESC LIMIT 1").get(slug, key);
    if (last && Date.now() - Number(last.created_at) < DEDUPE_MS)
      return { deviceNo: last.device_no, openNo: last.open_no, newDevice: !!last.new_device, country: last.country, city: last.city };
    const prev = await db.prepare("SELECT MAX(device_no) AS dn, COUNT(*) AS n FROM mkt_visits WHERE slug = ? AND device_key = ?").get(slug, key);
    let deviceNo = prev?.dn, newDevice = 0;
    if (!deviceNo) {
      const mx = await db.prepare("SELECT COALESCE(MAX(device_no),0) AS m FROM mkt_visits WHERE slug = ?").get(slug);
      deviceNo = Number(mx.m) + 1; newDevice = 1;
    }
    const openNo = Number(prev?.n || 0) + 1;
    const ip = clientIp(req), g = geo(ip), p = parseUA(ua), u = b.utm || {};
    await db.prepare(`INSERT INTO mkt_visits (id,slug,device_key,device_no,open_no,new_device,ip_prefix,country,region,city,lat,lon,timezone,lang,ua,os,browser,device_type,model,screen,referrer,in_app,utm_source,utm_medium,utm_campaign,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id("mv"), slug, key, deviceNo, openNo, newDevice, ip ? ipPrefix(ip) : null, g.country || null, g.region || null, g.city || null,
      g.lat ?? null, g.lon ?? null, clean(b.tz, 64), clean(b.lang, 16), clean(ua, 400), p.os, p.browser, p.type, clean(p.model, 60),
      clean(b.screen, 20), clean(b.referrer, 300), p.inApp, clean(u.source, 60), clean(u.medium, 60), clean(u.campaign, 80), Date.now());
    return { deviceNo, openNo, newDevice: !!newDevice, country: g.country || null, city: g.city || null };
    });
    const s = await db.prepare("SELECT meta_pixel_id, ga_measurement_id FROM integration_settings WHERE id = 'singleton'").get();
    const link = slug ? await db.prepare("SELECT label, channel FROM mkt_links WHERE slug = ?").get(slug) : null;
    json(res, 200, { ...out, deviceKey: key,
      metaPixelId: s?.meta_pixel_id || null, gaId: s?.ga_measurement_id || null, link });
  });

  // Public: demo request / interest form on the pitch page.
  router.post("/api/mkt/lead", async (req, res, { body }) => {
    if (await rateLimitByIp(req, res, "mkt-lead", { max: 10, windowMs: 60 * 60000 })) return;
    const b = body || {};
    const name = clean(b.name, 80), email = clean(b.email, 120), phone = clean(b.phone, 30);
    if (!name || (!email && !phone)) return json(res, 400, { error: "Your name and a phone number or email, please" });
    if (email && !/^\S+@\S+\.\S+$/.test(email)) return json(res, 400, { error: "That email doesn't look right" });
    const g = geo(clientIp(req));
    const lid = id("ml");
    await db.prepare("INSERT INTO mkt_leads (id,slug,device_key,name,email,phone,company,message,country,city,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(lid, clean(b.slug, 64) || "", deviceKey(b, req.headers["user-agent"]), name, email, phone, clean(b.company, 120), clean(b.message, 1000), g.country || null, g.city || null, "new", Date.now());
    await db.prepare("INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab) VALUES (?,?,?,?,?,?,?,?)")
      .run(id("n"), "super_admin", "lead", "New marketing lead", `${name}${g.city ? " · " + g.city : ""}${g.country ? ", " + g.country : ""} wants a demo.`, Date.now(), 0, "marketing");
    json(res, 201, { ok: true });
  });

  // ---- super admin -----------------------------------------------------
  router.get("/api/admin/marketing/links", async (req, res) => {
    if (!superAdmin(req, res)) return;
    json(res, 200, { links: await db.prepare("SELECT * FROM mkt_links WHERE archived = 0 ORDER BY created_at DESC").all() });
  });

  router.post("/api/admin/marketing/links", async (req, res, { body }) => {
    if (!superAdmin(req, res)) return;
    const label = clean(body?.label, 80);
    if (!label) return json(res, 400, { error: "Give the link a name, e.g. 'Lagos flyers' or 'WhatsApp status'" });
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "link";
    let slug = base;
    for (let i = 0; i < 5 && (await db.prepare("SELECT 1 FROM mkt_links WHERE slug = ?").get(slug)); i++) slug = `${base}-${crypto.randomBytes(2).toString("hex")}`;
    await db.prepare("INSERT INTO mkt_links (id,slug,label,channel,campaign,created_at) VALUES (?,?,?,?,?,?)")
      .run(id("mk"), slug, label, clean(body?.channel, 30) || "other", clean(body?.campaign, 80), Date.now());
    json(res, 201, { slug });
  });

  router.delete("/api/admin/marketing/links/:slug", async (req, res, { params }) => {
    if (!superAdmin(req, res)) return;
    await db.prepare("UPDATE mkt_links SET archived = 1 WHERE slug = ?").run(params.slug);
    json(res, 200, { ok: true });
  });

  // Everything the dashboard shows, for the last N days.
  router.get("/api/admin/marketing/overview", async (req, res, { query }) => {
    if (!superAdmin(req, res)) return;
    const days = Math.min(365, Math.max(1, Number(query.days || 30)));
    const since = Date.now() - days * 86400e3;
    const visits = await db.prepare("SELECT * FROM mkt_visits WHERE created_at >= ? ORDER BY created_at ASC").all(since);
    const leads = await db.prepare("SELECT slug, device_key FROM mkt_leads WHERE created_at >= ?").all(since);
    const signups = await db.prepare("SELECT mkt_slug, status FROM resellers WHERE mkt_slug IS NOT NULL AND created_at >= ?").all(since);
    const links = await db.prepare("SELECT * FROM mkt_links WHERE archived = 0").all();
    const labelOf = (slug) => links.find((l) => l.slug === slug)?.label || (slug ? slug : NO_LABEL);

    const per = {};
    const row = (slug) => (per[slug] ||= { slug, label: labelOf(slug), channel: links.find((l) => l.slug === slug)?.channel || null, opens: 0, devices: new Set(), leads: 0, signups: 0, paid: 0, deviceOpens: {} });
    for (const l of links) row(l.slug);
    const count = (arr, f) => { const m = {}; for (const x of arr) { const k = f(x) || "Unknown"; m[k] = (m[k] || 0) + 1; } return Object.entries(m).map(([k, n]) => ({ key: k, n })).sort((a, b) => b.n - a.n); };
    for (const v of visits) { const r = row(v.slug || ""); r.opens++; r.devices.add(v.device_key); r.deviceOpens[v.device_key] = (r.deviceOpens[v.device_key] || 0) + 1; }
    for (const l of leads) row(l.slug || "").leads++;
    for (const s of signups) { const r = row(s.mkt_slug || ""); r.signups++; if (s.status === "active") r.paid++; }
    const linksOut = Object.values(per).map((r) => {
      const devices = r.devices.size, repeat = r.opens - devices;
      return { slug: r.slug, label: r.label, channel: r.channel, opens: r.opens, devices, repeatOpens: repeat, verdict: verdict(devices, r.opens),
        leads: r.leads, signups: r.signups, paid: r.paid, conversion: devices ? Math.round((r.signups / devices) * 1000) / 10 : 0,
        topDeviceOpens: Math.max(0, ...Object.values(r.deviceOpens)) };
    }).sort((a, b) => b.opens - a.opens);

    const uniqDevices = new Set(visits.map((v) => v.slug + "|" + v.device_key)).size;
    const byHour = Array(24).fill(0);
    const off = Number(process.env.BUSINESS_TZ_OFFSET ?? 1);
    for (const v of visits) byHour[new Date(Number(v.created_at) + off * 3600e3).getUTCHours()]++;
    json(res, 200, {
      days,
      totals: { opens: visits.length, devices: uniqDevices, repeatOpens: visits.length - uniqDevices, leads: leads.length, signups: signups.length, paid: signups.filter((s) => s.status === "active").length },
      links: linksOut,
      countries: count(visits, (v) => v.country), cities: count(visits, (v) => (v.city ? `${v.city}, ${v.country}` : v.country)).slice(0, 15),
      devices: count(visits, (v) => v.model || v.os).slice(0, 15), os: count(visits, (v) => v.os), browsers: count(visits, (v) => v.browser),
      deviceTypes: count(visits, (v) => v.device_type), languages: count(visits, (v) => (v.lang || "").split("-")[0]),
      sources: count(visits, (v) => v.in_app || v.utm_source || (v.referrer ? (() => { try { return new URL(v.referrer).hostname; } catch { return "link"; } })() : "Direct / QR")),
      byHour: byHour.map((n, hour) => ({ hour, n })),
      byDay: count(visits, (v) => new Date(Number(v.created_at)).toISOString().slice(0, 10)).sort((a, b) => a.key.localeCompare(b.key)),
      mapPoints: visits.filter((v) => v.lat != null).slice(-500).map((v) => ({ lat: v.lat, lon: v.lon, city: v.city, country: v.country })),
    });
  });

  router.get("/api/admin/marketing/opens", async (req, res, { query }) => {
    if (!superAdmin(req, res)) return;
    const rows = query.slug != null && query.slug !== ""
      ? await db.prepare("SELECT * FROM mkt_visits WHERE slug = ? ORDER BY created_at DESC LIMIT 300").all(query.slug === NO_LABEL ? "" : query.slug)
      : await db.prepare("SELECT * FROM mkt_visits ORDER BY created_at DESC LIMIT 300").all();
    const links = await db.prepare("SELECT slug, label FROM mkt_links").all();
    json(res, 200, { opens: rows.map((v) => ({
      at: Number(v.created_at), slug: v.slug, label: links.find((l) => l.slug === v.slug)?.label || (v.slug || NO_LABEL),
      deviceNo: v.device_no, openNo: v.open_no, newDevice: !!v.new_device,
      tag: v.new_device ? "New device" : `Same device · open #${v.open_no}`,
      country: v.country, city: v.city, region: v.region, timezone: v.timezone, lang: v.lang,
      device: v.model || v.os, os: v.os, browser: v.browser, type: v.device_type, screen: v.screen, source: v.in_app || v.utm_source || null,
    })) });
  });

  router.get("/api/admin/marketing/leads", async (req, res) => {
    if (!superAdmin(req, res)) return;
    const leads = await db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM mkt_visits v WHERE v.device_key = l.device_key AND v.slug = l.slug) AS device_opens,
        (SELECT label FROM mkt_links k WHERE k.slug = l.slug) AS label
      FROM mkt_leads l ORDER BY created_at DESC LIMIT 1000`).all();
    json(res, 200, { leads });
  });

  router.put("/api/admin/marketing/leads/:id", async (req, res, { params, body }) => {
    if (!superAdmin(req, res)) return;
    const st = ["new", "contacted", "demo booked", "converted", "lost"].includes(body?.status) ? body.status : null;
    if (!st) return json(res, 400, { error: "Unknown status" });
    await db.prepare("UPDATE mkt_leads SET status = ? WHERE id = ?").run(st, params.id);
    json(res, 200, { ok: true });
  });

  // Bulk SMS / WhatsApp to leads (by status), through the platform's provider.
  router.post("/api/admin/marketing/leads/message", async (req, res, { body }) => {
    if (!superAdmin(req, res)) return;
    const msg = clean(body?.message, 480);
    if (!msg || msg.length < 3) return json(res, 400, { error: "Write a message" });
    const st = body?.status && body.status !== "all" ? body.status : null;
    const rows = st ? await db.prepare("SELECT phone FROM mkt_leads WHERE status = ? AND phone IS NOT NULL").all(st)
      : await db.prepare("SELECT phone FROM mkt_leads WHERE phone IS NOT NULL").all();
    const phones = [...new Set(rows.map((r) => normalizePhone(r.phone)).filter(Boolean))];
    let sent = 0;
    for (const p of phones.slice(0, 2000)) { const o = await sendMessage({ to: p, kind: "marketing", body: msg }); if (o.status !== "failed") sent++; }
    json(res, 200, { ok: true, recipients: phones.length, sent });
  });

  router.get("/api/admin/marketing/export/:what", async (req, res, { params }) => {
    if (!superAdmin(req, res)) return;
    const rows = params.what === "leads"
      ? await db.prepare("SELECT created_at, name, phone, email, company, country, city, status, slug, message FROM mkt_leads ORDER BY created_at DESC").all()
      : await db.prepare("SELECT created_at, slug, device_no, open_no, new_device, country, region, city, model, os, browser, device_type, lang, timezone, in_app, utm_source, utm_medium, utm_campaign FROM mkt_visits ORDER BY created_at DESC LIMIT 50000").all();
    const cols = rows[0] ? Object.keys(rows[0]) : ["empty"];
    const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(c === "created_at" ? new Date(Number(r[c])).toISOString() : r[c])).join(","))].join("\n");
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="safelinks-${params.what === "leads" ? "leads" : "opens"}.csv"` });
    res.end(csv);
  });

  router.get("/api/admin/marketing/settings", async (req, res) => {
    if (!superAdmin(req, res)) return;
    const s = await db.prepare("SELECT meta_pixel_id, ga_measurement_id FROM integration_settings WHERE id = 'singleton'").get();
    json(res, 200, { metaPixelId: s?.meta_pixel_id || "", gaId: s?.ga_measurement_id || "" });
  });

  router.put("/api/admin/marketing/settings", async (req, res, { body }) => {
    if (!superAdmin(req, res)) return;
    const px = String(body?.metaPixelId || "").trim(), ga = String(body?.gaId || "").trim();
    if (px && !/^\d{6,20}$/.test(px)) return json(res, 400, { error: "Meta Pixel ID is a number, e.g. 123456789012345" });
    if (ga && !/^G-[A-Z0-9]{4,15}$/i.test(ga)) return json(res, 400, { error: "Google Analytics ID looks like G-XXXXXXX" });
    await db.prepare("UPDATE integration_settings SET meta_pixel_id = ?, ga_measurement_id = ? WHERE id = 'singleton'").run(px || null, ga ? ga.toUpperCase() : null);
    json(res, 200, { ok: true });
  });
}
