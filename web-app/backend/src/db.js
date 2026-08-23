// Database layer — Postgres via the `pg` driver.
//
// This used to run on node:sqlite for zero external dependencies. That
// was fine for a demo but doesn't hold up at "hundreds of resellers":
// SQLite is single-writer, and every router check-in, session update,
// and delivery-log write is a write. Postgres is the one real npm
// dependency this backend now has — everything else is still Node
// built-ins.
//
// Route files were written against a synchronous better-sqlite3-style
// API: db.prepare(sql).get(...)/.all(...)/.run(...). Rather than
// rewrite every query in every route file, this module keeps that same
// shape but makes each method async (so every call site just gains an
// `await`) and transparently translates SQLite's `?` placeholders to
// Postgres's `$1, $2, ...`.

import pg from "pg";
import { randomUUID, randomBytes } from "node:crypto";
import { hashPassword } from "./auth.js";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set. Example: postgres://reslink:reslink@localhost:5432/reslink");
  process.exit(1);
}

export const pool = new Pool({ connectionString: DATABASE_URL });

function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function normalizeParams(params) {
  // Optional-field routes often do db.prepare(`... COALESCE(?, col) ...`)
  // and pass `body.someField` straight through, which is `undefined`
  // when the client omits that field. Both node:sqlite and node-postgres
  // reject `undefined` as a bind value — but `null` is exactly the right
  // meaning here (COALESCE treats it as "no override"), so normalize at
  // the one choke point instead of remembering to do it at every call site.
  return params.map((p) => (p === undefined ? null : p));
}

export const db = {
  prepare(sql) {
    const pgSql = toPgSql(sql);
    return {
      async get(...params) {
        const res = await pool.query(pgSql, normalizeParams(params));
        return res.rows[0];
      },
      async all(...params) {
        const res = await pool.query(pgSql, normalizeParams(params));
        return res.rows;
      },
      async run(...params) {
        const res = await pool.query(pgSql, normalizeParams(params));
        return { changes: res.rowCount };
      },
    };
  },
  async exec(sql) {
    await pool.query(sql);
  },
};

const id = (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const genCode = (len = 8) => {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from(randomBytes(len)).map((b) => chars[b % chars.length]).join("");
};

// A router misses its 30s check-in window this many ms before we treat
// it as offline (matches the spec: "alert if last check-in > 90 seconds").
export const ROUTER_OFFLINE_THRESHOLD_MS = 90 * 1000;

export { id, genCode };

export async function migrate() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS platform_plans (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, price REAL NOT NULL,
      max_clients INTEGER, max_devices_per_client INTEGER, description TEXT
    );

    CREATE TABLE IF NOT EXISTS super_admins (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      bank_name TEXT, bank_account_name TEXT, bank_account_number TEXT, ussd_code TEXT,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS integration_settings (
      id TEXT PRIMARY KEY DEFAULT 'singleton',
      contact_email TEXT, contact_whatsapp TEXT,
      platform_currency TEXT NOT NULL DEFAULT 'USD', dashboard_language TEXT NOT NULL DEFAULT 'en',
      updated_at BIGINT
    );

    CREATE TABLE IF NOT EXISTS resellers (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      company_name TEXT NOT NULL, license_key TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', subscription_plan TEXT NOT NULL,
      subscription_expiry BIGINT NOT NULL,
      ssid TEXT, portal_title TEXT, color TEXT,
      currency TEXT NOT NULL DEFAULT 'USD', language TEXT NOT NULL DEFAULT 'en', dashboard_language TEXT NOT NULL DEFAULT 'en',
      bank_name TEXT, bank_account_name TEXT, bank_account_number TEXT, ussd_code TEXT,
      contact_email TEXT, contact_whatsapp TEXT,
      -- Set to the subscription_expiry value the expiry sweep already
      -- raised a notification for, so it fires once per expiry rather
      -- than once per sweep tick — see jobs.js.
      notified_expiry BIGINT,
      -- Account recovery via secret question, set at signup and required
      -- (not optional) — see routes/auth.js. security_answer_hash uses
      -- the same scrypt hashing as password_hash, over a normalized
      -- (trimmed + lowercased) answer so casing/whitespace don't cause
      -- false rejections.
      security_question TEXT, security_answer_hash TEXT,
      -- Referral program. referral_code is generated once at signup
      -- (see routes/auth.js) and is this reseller's own shareable code;
      -- referred_by is who THEY signed up under, if anyone — set once,
      -- at signup, never changed after.
      referral_code TEXT UNIQUE, referred_by TEXT,
      created_at BIGINT NOT NULL,
      FOREIGN KEY (subscription_plan) REFERENCES platform_plans(id),
      FOREIGN KEY (referred_by) REFERENCES resellers(id)
    );
    CREATE INDEX IF NOT EXISTS idx_resellers_status ON resellers(status);

    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY, reseller_id TEXT NOT NULL, name TEXT NOT NULL,
      duration TEXT NOT NULL, price REAL NOT NULL, device_limit INTEGER NOT NULL,
      bandwidth INTEGER NOT NULL, priority TEXT NOT NULL DEFAULT 'medium',
      popular INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL,
      FOREIGN KEY (reseller_id) REFERENCES resellers(id)
    );
    CREATE INDEX IF NOT EXISTS idx_plans_reseller ON plans(reseller_id);

    CREATE TABLE IF NOT EXISTS vouchers (
      id TEXT PRIMARY KEY, reseller_id TEXT NOT NULL, username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL, name TEXT, email TEXT, phone TEXT, business TEXT,
      plan_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL,
      FOREIGN KEY (reseller_id) REFERENCES resellers(id),
      FOREIGN KEY (plan_id) REFERENCES plans(id)
    );
    CREATE INDEX IF NOT EXISTS idx_vouchers_reseller_status ON vouchers(reseller_id, status);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, voucher_id TEXT NOT NULL, device_label TEXT,
      mac TEXT, ip TEXT, bandwidth_mbps INTEGER, connected_at BIGINT NOT NULL,
      FOREIGN KEY (voucher_id) REFERENCES vouchers(id)
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_voucher ON sessions(voucher_id);

    CREATE TABLE IF NOT EXISTS routers (
      id TEXT PRIMARY KEY, reseller_id TEXT NOT NULL, router_id TEXT UNIQUE NOT NULL,
      api_key_hash TEXT NOT NULL,
      model TEXT, firmware TEXT, last_check_in BIGINT, status TEXT NOT NULL DEFAULT 'offline',
      FOREIGN KEY (reseller_id) REFERENCES resellers(id)
    );
    CREATE INDEX IF NOT EXISTS idx_routers_reseller ON routers(reseller_id);
    CREATE INDEX IF NOT EXISTS idx_routers_last_check_in ON routers(last_check_in);

    CREATE TABLE IF NOT EXISTS router_commands (
      id TEXT PRIMARY KEY, router_id TEXT NOT NULL, type TEXT NOT NULL,
      payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      created_at BIGINT NOT NULL, executed_at BIGINT,
      FOREIGN KEY (router_id) REFERENCES routers(router_id)
    );
    CREATE INDEX IF NOT EXISTS idx_router_commands_router_status ON router_commands(router_id, status);

    CREATE TABLE IF NOT EXISTS delivery_logs (
      id TEXT PRIMARY KEY, voucher_id TEXT NOT NULL, channel TEXT NOT NULL,
      status TEXT NOT NULL, time BIGINT NOT NULL,
      FOREIGN KEY (voucher_id) REFERENCES vouchers(id)
    );

    CREATE TABLE IF NOT EXISTS installations (
      id TEXT PRIMARY KEY, reseller_id TEXT NOT NULL, router_id TEXT,
      ip TEXT, location TEXT, status TEXT NOT NULL DEFAULT 'pending', time BIGINT NOT NULL,
      FOREIGN KEY (reseller_id) REFERENCES resellers(id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, type TEXT, title TEXT NOT NULL,
      message TEXT, time BIGINT NOT NULL, read INTEGER NOT NULL DEFAULT 0,
      action_tab TEXT, ref_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_scope ON notifications(scope);

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY, user_type TEXT NOT NULL, user_id TEXT NOT NULL,
      amount REAL NOT NULL, method TEXT, status TEXT NOT NULL DEFAULT 'completed',
      time BIGINT NOT NULL, note TEXT
    );

    CREATE TABLE IF NOT EXISTS pending_activations (
      id TEXT PRIMARY KEY, reseller_id TEXT NOT NULL, name TEXT, email TEXT, phone TEXT,
      business TEXT, plan_id TEXT NOT NULL, amount REAL NOT NULL, method TEXT NOT NULL,
      reference TEXT, status TEXT NOT NULL DEFAULT 'pending', time BIGINT NOT NULL,
      decided_at BIGINT,
      FOREIGN KEY (reseller_id) REFERENCES resellers(id)
    );
    CREATE INDEX IF NOT EXISTS idx_pending_activations_reseller_status ON pending_activations(reseller_id, status);

    CREATE TABLE IF NOT EXISTS license_payment_requests (
      id TEXT PRIMARY KEY, reseller_id TEXT NOT NULL, plan_id TEXT NOT NULL,
      amount REAL NOT NULL, method TEXT NOT NULL, reference TEXT,
      status TEXT NOT NULL DEFAULT 'pending', time BIGINT NOT NULL, decided_at BIGINT,
      FOREIGN KEY (reseller_id) REFERENCES resellers(id),
      FOREIGN KEY (plan_id) REFERENCES platform_plans(id)
    );

    -- Short-lived pairing codes for the self-registering router agent
    -- (see router-scripts/). A reseller generates one from the
    -- installer wizard; whoever's standing at the router types it in
    -- once. The router then registers itself by calling
    -- POST /api/agent/register with the code — no human types in the
    -- router's model/firmware/IP by hand, and no credentials are typed
    -- into the router beyond this one short code.
    CREATE TABLE IF NOT EXISTS pairing_codes (
      id TEXT PRIMARY KEY, reseller_id TEXT NOT NULL, code TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', router_id TEXT,
      expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL, used_at BIGINT,
      FOREIGN KEY (reseller_id) REFERENCES resellers(id)
    );
    CREATE INDEX IF NOT EXISTS idx_pairing_codes_reseller ON pairing_codes(reseller_id);

    -- Account recovery. token_hash follows the same pattern as
    -- password_hash/api_key_hash: the raw token is emailed once (see
    -- src/email.js) and never stored — only its hash, so a database
    -- leak alone can't be used to reset anyone's password.
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id TEXT PRIMARY KEY, reseller_id TEXT NOT NULL, token_hash TEXT NOT NULL,
      expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL, used_at BIGINT,
      FOREIGN KEY (reseller_id) REFERENCES resellers(id)
    );
    CREATE INDEX IF NOT EXISTS idx_password_reset_reseller ON password_reset_tokens(reseller_id);

    -- Rate limiting for public, unauthenticated endpoints (login,
    -- signup, password-reset-request, router/agent check-in and
    -- registration). One row per (bucket, key) — e.g. key =
    -- "login:203.0.113.7" — with a fixed window that resets itself the
    -- next time it's touched after expiring. See src/rateLimit.js; the
    -- upsert there is a single atomic statement so this is correct even
    -- across multiple backend instances sharing this Postgres, with no
    -- extra locking needed.
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY, window_start BIGINT NOT NULL, count INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY, reseller_id TEXT NOT NULL, subject TEXT, message TEXT,
      status TEXT NOT NULL DEFAULT 'open', reply TEXT, time BIGINT NOT NULL, replied_at BIGINT,
      source TEXT NOT NULL DEFAULT 'reseller', customer_name TEXT, customer_email TEXT, customer_phone TEXT,
      FOREIGN KEY (reseller_id) REFERENCES resellers(id)
    );

    -- A ticket's "message" column is just its opening message. Everything
    -- after that — from either side — lives here instead, and sending
    -- one of these never changes the ticket's status. Status changes
    -- ONLY via the dedicated .../status endpoints, so replying can never
    -- silently close a conversation (that was the bug: reply and resolve
    -- used to be the same action).
    CREATE TABLE IF NOT EXISTS support_messages (
      id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, sender TEXT NOT NULL, message TEXT NOT NULL, time BIGINT NOT NULL,
      FOREIGN KEY (ticket_id) REFERENCES support_tickets(id)
    );
    CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_messages(ticket_id);

    -- Marketer/reseller referral program. A reseller invites someone
    -- (by email/phone — a prospective marketer or reseller) from their
    -- Referrals tab; that creates a row here with status='invited'.
    -- If/when that person signs up using the referrer's referral_code
    -- (see routes/auth.js signup), this same row (matched by email) or
    -- a fresh one gets status='signed_up', referred_reseller_id set,
    -- and converted_at stamped. Nothing here pays out automatically —
    -- same manual-by-design pattern as every other payment in this
    -- system: Super Admin reviews signed-up referrals and marks the
    -- bonus paid by hand once they've actually sent it (see
    -- routes/superAdmin.js PUT /api/admin/referrals/:id/mark-paid),
    -- which is the only thing that moves a row to 'bonus_paid'.
    CREATE TABLE IF NOT EXISTS referrals (
      id TEXT PRIMARY KEY, referrer_reseller_id TEXT NOT NULL,
      name TEXT, email TEXT, phone TEXT,
      status TEXT NOT NULL DEFAULT 'invited', -- invited | signed_up | bonus_paid
      bonus_amount REAL NOT NULL,
      referred_reseller_id TEXT,
      created_at BIGINT NOT NULL, converted_at BIGINT, paid_at BIGINT,
      FOREIGN KEY (referrer_reseller_id) REFERENCES resellers(id),
      FOREIGN KEY (referred_reseller_id) REFERENCES resellers(id)
    );
    CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_reseller_id, status);

    -- Offline/manual activation. Super Admin generates a batch of
    -- random keys up front (meant to be handed out outside this
    -- system entirely — printed, emailed one at a time, read over the
    -- phone, whatever channel fits a non-internet-facing deployment)
    -- and a reseller redeems one themselves from their License tab for
    -- INSTANT activation — no waiting on Super Admin to confirm a
    -- transfer, because Super Admin already vetted the payment before
    -- generating the key in the first place. This is a second,
    -- independent path onto an active license alongside the existing
    -- bank-transfer-then-confirm flow in license_payment_requests —
    -- neither replaces the other; a deployment can use one, the other,
    -- or both.
    CREATE TABLE IF NOT EXISTS product_keys (
      id TEXT PRIMARY KEY, key_code TEXT UNIQUE NOT NULL,
      plan_id TEXT NOT NULL, duration_days INTEGER NOT NULL DEFAULT 30,
      batch_label TEXT,
      status TEXT NOT NULL DEFAULT 'unused', -- unused | used | revoked
      used_by_reseller_id TEXT, used_at BIGINT,
      created_at BIGINT NOT NULL,
      FOREIGN KEY (plan_id) REFERENCES platform_plans(id),
      FOREIGN KEY (used_by_reseller_id) REFERENCES resellers(id)
    );
    CREATE INDEX IF NOT EXISTS idx_product_keys_status ON product_keys(status, batch_label);
  `);

  // Run separately from the batch above: a defensive add for databases
  // migrated before this column existed (a no-op on a fresh install,
  // where the CREATE TABLE already included it). Isolated in its own
  // exec() call so it can never cascade into the rest of the schema
  // failing to apply.
  await db.exec(`ALTER TABLE resellers ADD COLUMN IF NOT EXISTS notified_expiry BIGINT;`);
  await db.exec(`ALTER TABLE resellers ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';`);
  await db.exec(`ALTER TABLE resellers ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en';`);
  await db.exec(`ALTER TABLE resellers ADD COLUMN IF NOT EXISTS dashboard_language TEXT NOT NULL DEFAULT 'en';`);
  await db.exec(`ALTER TABLE resellers ADD COLUMN IF NOT EXISTS security_question TEXT;`);
  await db.exec(`ALTER TABLE resellers ADD COLUMN IF NOT EXISTS security_answer_hash TEXT;`);
  await db.exec(`ALTER TABLE resellers ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;`);
  await db.exec(`ALTER TABLE resellers ADD COLUMN IF NOT EXISTS referred_by TEXT;`);
  await db.exec(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'reseller';`);
  await db.exec(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS customer_name TEXT;`);
  await db.exec(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS customer_email TEXT;`);
  await db.exec(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS customer_phone TEXT;`);
  await db.exec(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS action_tab TEXT;`);
  await db.exec(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS ref_id TEXT;`);
  await db.exec(`ALTER TABLE integration_settings ADD COLUMN IF NOT EXISTS platform_currency TEXT NOT NULL DEFAULT 'USD';`);
  await db.exec(`ALTER TABLE integration_settings ADD COLUMN IF NOT EXISTS dashboard_language TEXT NOT NULL DEFAULT 'en';`);
  // Flat bonus (in the platform currency) paid to a reseller when
  // someone they referred signs up — see the "referrals" table above.
  // Applies to new invites going forward; an invite's own bonus_amount
  // is snapshotted at invite time, so changing this doesn't retroactively
  // alter bonuses already promised.
  await db.exec(`ALTER TABLE integration_settings ADD COLUMN IF NOT EXISTS referral_bonus_amount REAL NOT NULL DEFAULT 10;`);
  // Optional uploaded receipt image/PDF attached alongside the existing
  // text `reference` field — see src/uploads.js. Nullable: the text
  // reference alone remains a valid way to submit a payment, this just
  // adds real proof-of-payment when the payer has a photo of it.
  await db.exec(`ALTER TABLE pending_activations ADD COLUMN IF NOT EXISTS receipt_url TEXT;`);
  await db.exec(`ALTER TABLE license_payment_requests ADD COLUMN IF NOT EXISTS receipt_url TEXT;`);
  // Attachments on support tickets/messages — a photo, PDF, or voice
  // note (see src/uploads.js) attached to the opening message or any
  // reply, on either side of the conversation (reseller<->Super Admin
  // or reseller<->customer). Nullable — every existing text-only flow
  // keeps working unchanged.
  await db.exec(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS attachment_url TEXT;`);
  await db.exec(`ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS attachment_url TEXT;`);
}

export async function seed() {
  const existing = await db.prepare("SELECT COUNT(*) AS n FROM resellers").get();
  if (Number(existing.n) > 0) return { seeded: false };

  const now = Date.now();
  const day = 86400000;

  const insertPlatformPlan = db.prepare(
    "INSERT INTO platform_plans (id,name,price,max_clients,max_devices_per_client,description) VALUES (?,?,?,?,?,?)"
  );
  await insertPlatformPlan.run("basic", "Basic", 15, 20, 3, "Starter tier for a single-site deployment.");
  await insertPlatformPlan.run("professional", "Professional", 35, 100, 6, "For growing reseller operations with multiple locations.");
  await insertPlatformPlan.run("enterprise", "Enterprise", 79, 500, 10, "Full-scale, multi-site deployments with priority support.");

  const insertSuperAdmin = db.prepare(
    "INSERT INTO super_admins (id,email,password_hash,bank_name,bank_account_name,bank_account_number,ussd_code,created_at) VALUES (?,?,?,?,?,?,?,?)"
  );
  await insertSuperAdmin.run(id("sa"), "admin@reslink.io", hashPassword("admin123"), "Chase Bank", "A I Brains Ventures", "0099 8811 220", "*911*1*0000#", now);

  await db.prepare(`INSERT INTO integration_settings (id, contact_email, contact_whatsapp, platform_currency, dashboard_language, updated_at)
    VALUES ('singleton', 'aibrainsventures@gmail.com', '+2348032540215', 'USD', 'en', ?)`).run(now);

  const insertReseller = db.prepare(`INSERT INTO resellers
    (id,email,password_hash,company_name,license_key,status,subscription_plan,subscription_expiry,ssid,portal_title,color,currency,language,dashboard_language,bank_name,bank_account_name,bank_account_number,ussd_code,contact_email,contact_whatsapp,security_question,security_answer_hash,referral_code,referred_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const r1 = "r1", r2 = "r2", r3 = "r3";
  // Demo accounts get a real secret question/answer too, so the
  // forgot-password flow is fully exercisable against seed data —
  // answer is normalized (trim + lowercase) the same way login-time
  // verification normalizes it, see routes/auth.js. r2 is seeded as
  // having signed up under r1's referral code, so the Referrals tab
  // has a real converted example to look at out of the box.
  await insertReseller.run(r1, "admin@nairobitech.io", hashPassword("reseller123"), "Nairobi Tech Solutions", "ISP-2026-8841", "active", "professional", now + 42 * day, "TechSolutions-WiFi-5G", "Welcome to TechSolutions WiFi", "#667eea", "KES", "sw", "sw", "Equity Bank", "Nairobi Tech Solutions Ltd", "0210 4487 221", "*247*1*8841#", "admin@nairobitech.io", "+254 700 111 000", "What city were you born in?", hashPassword("nairobi"), "NAIROBI1", null, now);
  await insertReseller.run(r2, "ops@lagosconnect.ng", hashPassword("reseller123"), "Lagos Connect Hub", "ISP-2026-3327", "active", "enterprise", now + 210 * day, "LagosConnect-Free", "You're online with Lagos Connect", "#764ba2", "NGN", "yo", "en", "GTBank", "Lagos Connect Hub", "0044 5521 903", "*737*1*3327#", "ops@lagosconnect.ng", "+234 803 000 111", "What was your first pet's name?", hashPassword("chichi"), "LAGOS327", r1, now);
  await insertReseller.run(r3, "hello@kampalanet.ug", hashPassword("reseller123"), "Kampala Office Net", "ISP-2026-1190", "pending", "basic", now - 3 * day, "KampalaNet-Guest", "Kampala Office Net", "#48bb78", "UGX", "en", "en", "Stanbic Bank", "Kampala Office Net", "9900 2211 034", "*165*1*1190#", "hello@kampalanet.ug", "+256 700 000 111", "What is your mother's maiden name?", hashPassword("okello"), "KAMPALA9", null, now);

  // Seed referrals: one already converted (r2, above), one still just
  // an invite awaiting a signup, so the Referrals tab has both states
  // to show on a fresh install.
  await db.prepare(`INSERT INTO referrals (id,referrer_reseller_id,name,email,phone,status,bonus_amount,referred_reseller_id,created_at,converted_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id("ref"), r1, "Lagos Connect Hub", "ops@lagosconnect.ng", "+234 803 000 111", "signed_up", 10, r2, now - 5 * day, now - 4 * day);
  await db.prepare(`INSERT INTO referrals (id,referrer_reseller_id,name,email,phone,status,bonus_amount,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id("ref"), r1, "Amina Yusuf", "amina.yusuf@example.com", "+254 700 222 333", "invited", 10, now - 1 * day);

  const insertPlan = db.prepare("INSERT INTO plans (id,reseller_id,name,duration,price,device_limit,bandwidth,priority,popular,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const p1 = "p1", p2 = "p2", p3 = "p3", p4 = "p4", p5 = "p5";
  await insertPlan.run(p1, r1, "Daily Pass", "daily", 1.5, 2, 10, "low", 0, now);
  await insertPlan.run(p2, r1, "Weekly Standard", "weekly", 6, 4, 25, "medium", 1, now);
  await insertPlan.run(p3, r1, "Monthly Pro", "monthly", 18, 8, 50, "high", 0, now);
  await insertPlan.run(p4, r2, "Weekly Basic", "weekly", 5, 3, 15, "medium", 1, now);
  await insertPlan.run(p5, r2, "Quarterly Business", "3months", 60, 10, 100, "high", 0, now);

  const insertVoucher = db.prepare("INSERT INTO vouchers (id,reseller_id,username,password,name,email,phone,business,plan_id,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  const v1 = "v1", v4 = "v4";
  await insertVoucher.run(v1, r1, "amara-2841", "Kx7mQ2pL", "Amara Okafor", "amara@greenoffice.co", "+254 700 111 222", "Green Office Co.", p2, "active", now - 5 * day, now + 2 * day);
  await insertVoucher.run("v2", r1, "david-1102", "Zt9wRb4N", "David Mwangi", "david@cafeblue.co", "+254 700 333 444", "Cafe Blue", p1, "expired", now - 6 * day, now - 5 * day);
  await insertVoucher.run("v3", r1, "grace-7734", "Hj3nVq8T", "Grace Wanjiru", "grace@sunriseshop.co", "+254 700 555 666", "Sunrise Retail Shop", p3, "paused", now - 12 * day, now + 18 * day);
  await insertVoucher.run(v4, r2, "tunde-5590", "Pw2cXm6K", "Tunde Bello", "tunde@bellologistics.ng", "+234 803 111 222", "Bello Logistics", p5, "active", now - 12 * day, now + 78 * day);
  await insertVoucher.run("v5", r2, "ifeoma-3321", "Ln8gYd1Z", "Ifeoma Nwosu", "ifeoma@nwosuconsult.ng", "+234 803 333 444", "Nwosu Consulting", p4, "active", now - 2 * day, now + 5 * day);

  const insertSession = db.prepare("INSERT INTO sessions (id,voucher_id,device_label,mac,ip,bandwidth_mbps,connected_at) VALUES (?,?,?,?,?,?,?)");
  await insertSession.run("s1", v1, "Front Desk iMac", "3C:22:FB:11:AA:01", "10.0.0.12", 12, now - 3 * 3600000);
  await insertSession.run("s2", v1, "Amara's iPhone", "3C:22:FB:11:AA:02", "10.0.0.13", 6, now - 1 * 3600000);
  await insertSession.run("s3", v4, "Warehouse Laptop", "F0:18:98:AA:CC:01", "10.0.1.11", 20, now - 5 * 3600000);
  await insertSession.run("s4", v4, "Dispatch Tablet", "F0:18:98:AA:CC:02", "10.0.1.12", 8, now - 40 * 60000);

  const insertRouter = db.prepare("INSERT INTO routers (id,reseller_id,router_id,api_key_hash,model,firmware,last_check_in,status) VALUES (?,?,?,?,?,?,?,?)");
  await insertRouter.run("rt1", r1, "RTR-8841-Q3F", hashPassword("sk_demo_r1_router1"), "MikroTik hAP ac3", "RouterOS 7.15", now - 22000, "online");
  await insertRouter.run("rt2", r2, "RTR-3327-M1D", hashPassword("sk_demo_r2_router1"), "Ubiquiti EdgeRouter X", "EdgeOS 2.0.9", now - 210000, "offline");

  const insertDelivery = db.prepare("INSERT INTO delivery_logs (id,voucher_id,channel,status,time) VALUES (?,?,?,?,?)");
  await insertDelivery.run(id("dl"), v1, "email", "delivered", now - 5 * day);
  await insertDelivery.run(id("dl"), v1, "whatsapp", "delivered", now - 5 * day);
  await insertDelivery.run(id("dl"), v4, "email", "delivered", now - 12 * day);
  await insertDelivery.run(id("dl"), v4, "whatsapp", "failed", now - 12 * day);

  const insertInstall = db.prepare("INSERT INTO installations (id,reseller_id,router_id,ip,location,status,time) VALUES (?,?,?,?,?,?,?)");
  await insertInstall.run(id("i"), r1, "RTR-8841-Q3F", "197.232.14.5", "Nairobi, KE", "completed", now - 2 * day);
  await insertInstall.run(id("i"), r2, "RTR-3327-M1D", "105.112.8.90", "Lagos, NG", "completed", now - 8 * day);
  await insertInstall.run(id("i"), r3, null, "41.210.3.44", "Kampala, UG", "pending", now - 4 * 3600000);

  const insertNotif = db.prepare("INSERT INTO notifications (id,scope,type,title,message,time,read,action_tab,ref_id) VALUES (?,?,?,?,?,?,?,?,?)");
  await insertNotif.run(id("n"), "super_admin", "install", "New reseller installation", "Kampala Office Net completed installer setup, awaiting payment.", now - 4 * 3600000, 0, "installs", null);
  await insertNotif.run(id("n"), "super_admin", "alert", "License expiring", "Kampala Office Net's license expired 3 days ago.", now - 3 * day, 0, "resellers", r3);
  await insertNotif.run(id("n"), `reseller:${r1}`, "payment_confirmation", "Payment confirmation needed", "A bank transfer for a new voucher is awaiting your confirmation.", now - 6 * 3600000, 0, "pending", null);

  const insertPayment = db.prepare("INSERT INTO payments (id,user_type,user_id,amount,method,status,time,note) VALUES (?,?,?,?,?,?,?,?)");
  await insertPayment.run(id("pay"), "reseller", r2, 79, "Bank Transfer", "completed", now - 8 * day, "License renewal — Enterprise");
  await insertPayment.run(id("pay"), "voucher", v1, 6, "Bank Transfer", "completed", now - 5 * day, "Weekly Standard voucher");

  const insertPending = db.prepare("INSERT INTO pending_activations (id,reseller_id,name,email,phone,business,plan_id,amount,method,reference,status,time) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  await insertPending.run(id("pa"), r1, "Michael Otieno", "michael@otienotrading.co", "+254 700 888 999", "Otieno Trading", p3, 18, "Bank Transfer", "Receipt_TXN88213.jpg", "pending", now - 6 * 3600000);

  const ticketId = id("t");
  const insertTicket = db.prepare("INSERT INTO support_tickets (id,reseller_id,subject,message,status,reply,time,replied_at) VALUES (?,?,?,?,?,?,?,?)");
  await insertTicket.run(ticketId, r1, "Payout schedule question", "When does the platform remit end-user transfer payments confirmed on our side?", "resolved", "Transfers go straight to your own bank account — only your platform license fee is paid to us.", now - 12 * day, now - 11 * day);
  const insertMessage = db.prepare("INSERT INTO support_messages (id,ticket_id,sender,message,time) VALUES (?,?,?,?,?)");
  await insertMessage.run(id("m"), ticketId, "admin", "Transfers go straight to your own bank account — only your platform license fee is paid to us.", now - 11 * day);
  await insertMessage.run(id("m"), ticketId, "reseller", "Got it, thanks for the quick answer!", now - 11 * day + 3600000);

  return { seeded: true };
}
