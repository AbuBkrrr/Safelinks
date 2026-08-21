// Rate limiting for public, unauthenticated endpoints — login, signup,
// password-reset requests, and router/agent check-in and registration.
// Postgres-backed (not in-memory, not Redis) so it's correct even
// across multiple backend instances sharing one database: the upsert
// below is a single atomic statement, so two instances handling
// requests for the same key at the same moment can't both "win" a
// stale read the way a read-then-write check would.
//
// Fixed window, not sliding — simpler, and "someone gets a fresh
// attempt right at the window boundary" is an acceptable tradeoff for
// what this is protecting (credential stuffing, pairing-code
// brute-forcing, signup/email-bomb spam), which all need sustained
// abuse to matter, not a single extra attempt at a window edge.

import { json, text } from "./http.js";
import { db } from "./db.js";

async function consume(key, windowMs) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const row = await db.prepare(`
    INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limits.window_start < ? THEN 1 ELSE rate_limits.count + 1 END,
      window_start = CASE WHEN rate_limits.window_start < ? THEN ? ELSE rate_limits.window_start END
    RETURNING count, window_start
  `).get(key, now, cutoff, cutoff, now);
  // `pg` returns BIGINT columns as JS strings (they can exceed
  // Number's safe-integer range in general, even though these
  // particular values — epoch millis and a request count — never
  // will). Without this, `row.window_start + windowMs` below does
  // STRING CONCATENATION, not addition, silently producing a
  // multi-quadrillion "seconds" retry-after. Caught by hand-testing
  // this against a real Postgres instance for the first time — every
  // earlier verification of this file ran against `node --check`
  // (syntax only) or mocked data, neither of which would ever
  // surface a driver-level type quirk like this.
  return { count: Number(row.count), window_start: Number(row.window_start) };
}

/** Best-effort client IP. Trusts the LAST hop's X-Forwarded-For entry
 *  only because this backend's deployment model (see docker-compose.yml)
 *  always sits behind Caddy, which sets it correctly — trusting an
 *  arbitrary client-supplied header would be meaningless (they could
 *  claim to be anyone), but trusting your own known reverse proxy is
 *  the standard, correct pattern. If you deploy this differently
 *  (directly internet-facing, a different proxy), verify this still
 *  reflects the real client before relying on it. */
export function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return xff.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

/** Rate-limits by client IP under `${bucket}:${ip}`. Returns true (and
 *  already sent a 429) if the caller should stop; false if the request
 *  may proceed. `respond` picks json() vs text() — the agent/router
 *  endpoints speak plain text, everything else speaks JSON. */
export async function rateLimitByIp(req, res, bucket, { max, windowMs, respond = "json" } = {}) {
  return rateLimitByKey(res, `${bucket}:${getClientIp(req)}`, { max, windowMs, respond });
}

/** Rate-limits by an arbitrary caller-supplied key (e.g. an email
 *  address, so a password-reset flood aimed at ONE target account gets
 *  caught even if it's spread across many IPs, independent of the
 *  per-IP limit already applied). */
export async function rateLimitByKey(res, key, { max, windowMs, respond = "json" } = {}) {
  const row = await consume(key, windowMs);
  if (row.count > max) {
    const retryAfterSeconds = Math.ceil((row.window_start + windowMs - Date.now()) / 1000);
    if (respond === "text") {
      text(res, 429, `STATUS ERROR\nMESSAGE too many requests — retry in ${retryAfterSeconds}s\n`);
    } else {
      json(res, 429, { error: "Too many requests — please slow down", retryAfterSeconds: Math.max(retryAfterSeconds, 1) });
    }
    return true;
  }
  return false;
}
