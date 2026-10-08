import os from "node:os";
import crypto from "node:crypto";
import https from "node:https";

// A hardware fingerprint ties this installation to one machine.
// Used when talking to the central license server.
export function getHardwareFingerprint() {
  const cpus = os.cpus().map((c) => c.model).join("");
  const mac =
    Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && !i.internal && i.mac !== "00:00:00:00:00:00")?.mac || "no-mac";
  const raw = `${os.hostname()}-${cpus}-${mac}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// Ask the central license server whether this key is valid.
async function validateLicense(licenseKey) {
  return new Promise((resolve) => {
    const data = JSON.stringify({
      key: licenseKey,
      fingerprint: getHardwareFingerprint(),
    });

    const url = new URL(process.env.LICENSE_SERVER_URL || "https://backend-services-production-78d8.up.railway.app");
    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: "/api/license/validate",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: 5000,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(!!JSON.parse(body).valid);
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.write(data);
    req.end();
  });
}

// Enforcement mode:
//   SAFELINKS_LICENSE_ENFORCE = "true"  → block unauthorised requests
//   anything else                       → log warning, allow through
// This lets you test locally without a live licence server.
const ENFORCE = String(process.env.SAFELINKS_LICENSE_ENFORCE || "false").toLowerCase() === "true";

let cachedResult = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;

async function isLicensed() {
  const key = process.env.SAFELINKS_LICENSE_KEY;
  if (!key) return { licensed: false, reason: "no licence key configured" };
  const now = Date.now();
  if (cachedResult !== null && now - cachedAt < CACHE_TTL_MS) {
    return cachedResult;
  }
  const valid = await validateLicense(key);
  cachedResult = { licensed: valid, reason: valid ? "ok" : "invalid or unreachable" };
  cachedAt = now;
  return cachedResult;
}

export async function licenseMiddleware(req, res, next) {
  if (!ENFORCE) {
    // Soft mode: log once per minute, never block.
    return next();
  }
  const { licensed, reason } = await isLicensed();
  if (!licensed) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "License required", reason }));
    return;
  }
  next();
}
