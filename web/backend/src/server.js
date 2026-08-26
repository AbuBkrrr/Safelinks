import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { migrate, seed, pool } from "./db.js";
import { startScheduler } from "./jobs.js";
import { createRouter, json } from "./http.js";
import { UPLOADS_DIR } from "./uploads.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerPortalRoutes } from "./routes/portal.js";
import { registerSuperAdminRoutes } from "./routes/superAdmin.js";
import { registerResellerRoutes } from "./routes/reseller.js";
import { registerRouterRoutes } from "./routes/router.js";
import { registerAgentRoutes } from "./routes/agent.js";

const UPLOAD_CONTENT_TYPES = {
  ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".pdf": "application/pdf",
  ".webm": "audio/webm", ".ogg": "audio/ogg", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav",
};

// Static file serving for uploaded receipts (see uploads.js). Handled
// directly here rather than through the JSON-only router above — this
// is the one place the backend streams a binary file back out. Guards
// against path traversal by resolving against UPLOADS_DIR and
// rejecting anything that escapes it (a filename like "../../etc/passwd"
// would resolve outside the directory and get rejected below).
async function serveUpload(req, res, pathname) {
  const requested = decodeURIComponent(pathname.replace(/^\/uploads\//, ""));
  const resolved = path.join(UPLOADS_DIR, requested);
  if (!resolved.startsWith(UPLOADS_DIR + path.sep)) {
    json(res, 400, { error: "Invalid path" });
    return;
  }
  try {
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("not a file");
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      "Content-Type": UPLOAD_CONTENT_TYPES[ext] || "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": "private, max-age=3600",
    });
    createReadStream(resolved).pipe(res);
  } catch {
    json(res, 404, { error: "File not found" });
  }
}

async function main() {
  // Fail fast and loudly if Postgres isn't reachable yet, instead of
  // starting the HTTP server and returning cryptic errors on the first
  // request. Useful in Docker Compose where the app container can start
  // slightly before Postgres finishes its own init.
  const MAX_ATTEMPTS = 15;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await pool.query("SELECT 1");
      break;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        console.error(`Could not connect to Postgres after ${MAX_ATTEMPTS} attempts:`, err.message);
        process.exit(1);
      }
      console.log(`Waiting for Postgres... (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  await migrate();
  const seedResult = await seed();
  startScheduler();

  const router = createRouter();
  registerAuthRoutes(router);
  registerPortalRoutes(router);
  registerSuperAdminRoutes(router);
  registerResellerRoutes(router);
  registerRouterRoutes(router);
  registerAgentRoutes(router);

  router.get("/health", async (req, res) => json(res, 200, { ok: true, service: "reslink-backend" }));

  const PORT = process.env.PORT || 4000;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (req.method === "GET" && pathname.startsWith("/uploads/")) {
      return serveUpload(req, res, pathname);
    }
    return router.handle(req, res);
  });

  server.listen(PORT, () => {
    console.log(`SAFE_Links backend listening on http://localhost:${PORT}`);
    console.log(seedResult.seeded ? "Database seeded with demo data." : "Database already had data — skipped seeding.");
    console.log("Demo logins: admin@reslink.io / admin123  (super admin)");
    console.log("             admin@nairobitech.io / reseller123  (reseller)");
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
