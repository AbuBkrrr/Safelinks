// Minimal router — no Express. Matches method + path (with :params),
// parses JSON and form-encoded bodies, and gives a couple of response
// helpers. Small enough to read top to bottom in under a minute, which
// matters more here than pulling in a framework we can't even install.

export function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  });
  res.end(payload);
}

// Plain `key=value`-per-line responses for the RouterOS agent endpoints
// (routes/agent.js). RouterOS's scripting language has no real JSON
// parser, but splitting a fixed, flat text format on newlines and "="
// is a couple of lines of RouterOS script — so the device-facing
// protocol speaks this instead of JSON. See reslink-backend/router-scripts/.
export function text(res, status, body) {
  const payload = typeof body === "string" ? body : String(body);
  res.writeHead(status, {
    "Content-Type": "text/plain",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      // Raised from the original 1MB to accommodate base64-encoded
      // receipt photo uploads (see src/uploads.js) — this router has
      // no multipart/form-data parser, so a file upload is just a
      // bigger JSON body. Base64 inflates size by ~33%, so 9MB here
      // comfortably covers uploads.js's 6MB decoded file cap.
      if (data.length > 9_000_000) { req.destroy(); reject(new Error("Body too large")); }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      const contentType = req.headers["content-type"] || "";
      if (contentType.includes("application/x-www-form-urlencoded")) {
        // RouterOS's /tool fetch http-data sends form-encoded bodies,
        // not JSON — its scripting language has no JSON.stringify
        // equivalent, but building a "key=value&key2=value2" string is
        // trivial in RouterOS script.
        try {
          const params = new URLSearchParams(data);
          return resolve(Object.fromEntries(params.entries()));
        } catch { return resolve({}); }
      }
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

function compilePath(pattern) {
  const paramNames = [];
  const regexStr = pattern
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        paramNames.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^${regexStr}$`), paramNames };
}

export function createRouter() {
  const routes = []; // { method, compiled, handler }

  function add(method) {
    return (pattern, handler) => {
      routes.push({ method, compiled: compilePath(pattern), handler });
    };
  }

  const router = {
    get: add("GET"),
    post: add("POST"),
    put: add("PUT"),
    delete: add("DELETE"),
    async handle(req, res) {
      const url = new URL(req.url, "http://localhost");
      const pathname = decodeURIComponent(url.pathname);

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        });
        return res.end();
      }

      for (const route of routes) {
        if (route.method !== req.method) continue;
        const m = pathname.match(route.compiled.regex);
        if (!m) continue;
        const params = {};
        route.compiled.paramNames.forEach((name, i) => { params[name] = m[i + 1]; });
        const query = Object.fromEntries(url.searchParams.entries());
        try {
          const body = ["POST", "PUT"].includes(req.method) ? await readBody(req) : {};
          await route.handler(req, res, { params, query, body });
        } catch (err) {
          // Full error (message + stack) goes to the server log only —
          // the client never sees internals like DB constraint text or
          // field names. NODE_ENV=development (only) also echoes the
          // message back, to keep local debugging convenient without
          // weakening what actually ships to production.
          console.error(err);
          const body = process.env.NODE_ENV === "development"
            ? { error: "Internal server error", detail: String(err.message || err) }
            : { error: "Internal server error" };
          json(res, 500, body);
        }
        return;
      }
      json(res, 404, { error: "Not found", path: pathname });
    },
  };
  return router;
}
