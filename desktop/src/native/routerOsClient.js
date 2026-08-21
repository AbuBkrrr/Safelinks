"use strict";

const tls = require("node:tls");

/**
 * Node port of RouterOsClient (see the Kotlin/Java versions for the
 * full trust-on-first-use design writeup — identical protocol and
 * security model here). The one real platform difference: Node's
 * `checkServerIdentity` callback is documented as advisory-only when
 * `rejectUnauthorized: false` — "depending on the settings of the TLS
 * server, unauthorized connections may still be accepted" regardless
 * of what that callback returns. That means the pattern used on
 * Android/Kotlin (throw inside the trust manager to abort the
 * handshake) doesn't reliably abort anything here.
 *
 * So this client does NOT use https.request() at all. It connects
 * with raw tls.connect(), waits for the handshake to finish, inspects
 * the peer certificate's fingerprint ITSELF, and only writes any HTTP
 * request bytes — including the Basic Auth header carrying the
 * router's admin credentials — after that check has already passed.
 * If the fingerprint doesn't match, the socket is destroyed before a
 * single byte of the request is written. This is slightly more code
 * than reusing Node's http client, but it means the fail-closed
 * guarantee is enforced by this module's own logic, not by an
 * advisory hook whose real behavior isn't fully guaranteed by the
 * platform.
 */
class RouterOsClient {
  constructor(gatewayIp) {
    this.gatewayIp = gatewayIp;
    this.pinnedFingerprint = null;
  }

  /**
   * Connects and completes the TLS handshake, then verifies the
   * cert's SHA-256 fingerprint before resolving. If expectedFingerprint
   * is null (the first call of a session — see probe()), any
   * fingerprint is accepted and recorded. If it's set (execute()),
   * the connection is destroyed and the promise rejects with
   * err.certMismatch = true on any mismatch — before anything is
   * written to the socket.
   */
  _connectVerified(expectedFingerprint) {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: this.gatewayIp,
        port: 443,
        // RouterOS's REST API (www-ssl) ships a self-signed cert by
        // default — there's no legitimate CA chain for a LAN device
        // to validate against. rejectUnauthorized:false lets the
        // handshake complete instead of failing outright; the actual
        // trust decision happens below, against the fingerprint, not
        // against a CA chain.
        rejectUnauthorized: false,
        servername: this.gatewayIp,
        timeout: 8000,
      });

      let settled = false;

      socket.on("timeout", () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error("Connection timed out"));
      });

      socket.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });

      socket.once("secureConnect", () => {
        if (settled) return;
        const cert = socket.getPeerCertificate();
        if (!cert || !cert.fingerprint256) {
          settled = true;
          socket.destroy();
          reject(new Error(`No certificate presented by ${this.gatewayIp}`));
          return;
        }

        const fingerprint = cert.fingerprint256; // ':'-separated SHA-256 hex - same format used on Android/Kotlin
        if (expectedFingerprint && fingerprint !== expectedFingerprint) {
          settled = true;
          socket.destroy();
          const err = new Error("Certificate fingerprint changed since first probe");
          err.certMismatch = true;
          err.seenFingerprint = fingerprint;
          reject(err);
          return;
        }

        settled = true;
        this.pinnedFingerprint = fingerprint;
        resolve(socket);
      });
    });
  }

  _sendRequest(socket, method, path, body, adminUser, adminPass) {
    return new Promise((resolve, reject) => {
      const auth = Buffer.from(`${adminUser}:${adminPass}`, "utf8").toString("base64");
      const bodyBuf = body ? Buffer.from(body, "utf8") : null;

      const headerLines = [
        `${method} ${path} HTTP/1.1`,
        `Host: ${this.gatewayIp}`,
        `Authorization: Basic ${auth}`,
        "Accept: application/json",
      ];
      if (bodyBuf) {
        headerLines.push("Content-Type: application/json");
        headerLines.push(`Content-Length: ${bodyBuf.length}`);
      }
      headerLines.push("Connection: close");
      const requestHead = headerLines.join("\r\n") + "\r\n\r\n";

      let raw = Buffer.alloc(0);
      let resolved = false;
      let expectedBodyLength = null;
      let headerEndIndex = -1;

      const tryResolve = () => {
        if (resolved) return;
        if (headerEndIndex === -1) {
          headerEndIndex = raw.indexOf("\r\n\r\n");
          if (headerEndIndex === -1) return; // headers not fully received yet

          const headerText = raw.slice(0, headerEndIndex).toString("utf8");
          const clMatch = headerText.match(/\r\nContent-Length:\s*(\d+)/i);
          if (clMatch) expectedBodyLength = parseInt(clMatch[1], 10);
        }

        const bodyBytesSoFar = raw.length - (headerEndIndex + 4);
        if (expectedBodyLength !== null && bodyBytesSoFar >= expectedBodyLength) {
          resolved = true;
          socket.destroy(); // done reading - don't wait for the server's own close
          resolve(parseResponse(raw));
        }
        // If expectedBodyLength is null (no Content-Length header, e.g.
        // a chunked or connection-closed response), fall through to the
        // 'end'/'close' handlers below instead of resolving early.
      };

      socket.on("data", (chunk) => {
        raw = Buffer.concat([raw, chunk]);
        tryResolve();
      });

      socket.on("end", () => {
        if (resolved) return;
        resolved = true;
        try {
          resolve(parseResponse(raw));
        } catch (e) {
          reject(e);
        }
      });

      socket.on("close", () => {
        if (resolved) return;
        resolved = true;
        try {
          resolve(parseResponse(raw));
        } catch (e) {
          reject(new Error("Connection closed before a full response was received"));
        }
      });

      socket.on("error", (err) => {
        if (resolved) return;
        resolved = true;
        reject(err);
      });

      socket.write(requestHead);
      if (bodyBuf) socket.write(bodyBuf);
    });
  }

  /**
   * First call of a pairing session. Confirms something at the LAN
   * gateway speaks RouterOS's REST API and captures its cert
   * fingerprint for the person pairing to confirm before anything
   * that changes router configuration happens.
   */
  async probe(adminUser, adminPass) {
    let socket;
    try {
      socket = await this._connectVerified(null);
    } catch (e) {
      return { type: "NetworkError", message: e.message };
    }
    try {
      const { statusCode, body } = await this._sendRequest(
        socket, "GET", "/rest/system/resource", null, adminUser, adminPass
      );
      if (statusCode < 200 || statusCode >= 300) {
        return { type: "HttpError", code: statusCode, body };
      }
      if (!body.includes('"board-name"') && !body.includes('"version"')) {
        return { type: "HttpError", code: statusCode, body: `Response didn't look like RouterOS: ${body}` };
      }
      return { type: "Success", body };
    } catch (e) {
      return { type: "NetworkError", message: e.message };
    }
  }

  /**
   * Runs a script via POST /rest/execute. Must be called after
   * probe() succeeded and the fingerprint was confirmed by whoever's
   * pairing - pass that confirmed fingerprint as expectedFingerprint
   * so this fails closed if the cert changed in between, before any
   * credentials are sent.
   */
  async execute(script, adminUser, adminPass, expectedFingerprint) {
    let socket;
    try {
      socket = await this._connectVerified(expectedFingerprint);
    } catch (e) {
      if (e.certMismatch) {
        return { type: "CertMismatch", seenFingerprint: e.seenFingerprint, expectedFingerprint };
      }
      return { type: "NetworkError", message: e.message };
    }
    try {
      const payload = JSON.stringify({ script });
      const { statusCode, body } = await this._sendRequest(
        socket, "POST", "/rest/execute", payload, adminUser, adminPass
      );
      if (statusCode < 200 || statusCode >= 300) {
        return { type: "HttpError", code: statusCode, body };
      }
      return { type: "Success", body };
    } catch (e) {
      return { type: "NetworkError", message: e.message };
    }
  }
}

function parseResponse(raw) {
  const text = raw.toString("utf8");
  const sepIndex = text.indexOf("\r\n\r\n");
  if (sepIndex === -1) throw new Error("Malformed or empty HTTP response from router");
  const headerPart = text.slice(0, sepIndex);
  const body = text.slice(sepIndex + 4);
  const statusLine = headerPart.split("\r\n")[0];
  const match = statusLine.match(/^HTTP\/1\.\d (\d{3})/);
  const statusCode = match ? parseInt(match[1], 10) : 0;
  return { statusCode, body };
}

module.exports = { RouterOsClient };
