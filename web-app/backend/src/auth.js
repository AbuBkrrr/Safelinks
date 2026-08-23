// Auth utilities — no external deps.
// Password hashing: Node's built-in scrypt (a real, slow, salted KDF —
// not a toy). JWT: a minimal hand-rolled HS256 implementation, since
// jsonwebtoken isn't installable in this environment; the wire format
// (header.payload.signature, base64url, HMAC-SHA256) is identical to
// the real spec, so swapping in `jsonwebtoken` later is a drop-in.

import { scryptSync, randomBytes, timingSafeEqual, createHmac } from "node:crypto";

const JWT_SECRET = process.env.JWT_SECRET || "reslink-dev-secret-change-in-production";
const TOKEN_TTL_SECONDS = 12 * 60 * 60; // 12 hours

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

// Security-question answers use the same hashPassword/verifyPassword
// scrypt machinery as real passwords (a real, slow, salted KDF — not
// stored in the clear), but normalized first: trimmed and lowercased,
// so "Nairobi", "nairobi ", and "NAIROBI" all verify as the same
// answer. Passwords are NOT normalized this way (case matters there);
// this normalization is specific to recall-based secret answers, where
// forcing exact casing/whitespace just locks people out of their own
// account for no security benefit.
export function normalizeAnswer(answer) {
  return String(answer || "").trim().toLowerCase();
}
export function hashAnswer(answer) {
  return hashPassword(normalizeAnswer(answer));
}
export function verifyAnswer(answer, stored) {
  return verifyPassword(normalizeAnswer(answer), stored);
}

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}
function b64urlJSON(obj) {
  return b64url(JSON.stringify(obj));
}

export function signToken(payload) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + TOKEN_TTL_SECONDS };
  const headerPart = b64urlJSON(header);
  const payloadPart = b64urlJSON(body);
  const signature = createHmac("sha256", JWT_SECRET).update(`${headerPart}.${payloadPart}`).digest("base64url");
  return `${headerPart}.${payloadPart}.${signature}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signature] = parts;
  const expected = createHmac("sha256", JWT_SECRET).update(`${headerPart}.${payloadPart}`).digest("base64url");
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}

/** Express-less middleware: reads Authorization header, verifies, and
 *  optionally enforces a role. Returns the decoded payload or null —
 *  the caller (router) is responsible for responding 401/403. */
export function authenticate(req, requiredRole) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const payload = verifyToken(token);
  if (!payload) return { ok: false, status: 401, error: "Missing or invalid token" };
  if (requiredRole && payload.role !== requiredRole) {
    return { ok: false, status: 403, error: `Requires role: ${requiredRole}` };
  }
  return { ok: true, user: payload };
}
