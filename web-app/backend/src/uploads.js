// Local-disk storage for uploaded attachments — receipt images/PDFs
// (see routes/portal.js POST /:resellerId/upload-receipt and
// routes/reseller.js POST /upload-receipt) AND support-ticket
// attachments — a photo, PDF, or voice note on a support message (see
// routes/portal.js POST /:resellerId/support/upload, routes/reseller.js
// POST /support/upload). No S3/cloud storage dependency by design —
// same philosophy as the rest of this backend (see package.json: two
// real deps, everything else built-in). Files land in ./uploads next
// to src/, served back out by a static route registered in server.js.
//
// The client sends the file as base64 inside the normal JSON body
// (this backend's router only parses JSON/form bodies — see http.js —
// there's no multipart/form-data parser), which is why server.js
// raises the request body size cap for routes that call this.

import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOADS_DIR = path.join(__dirname, "..", "uploads");

const ALLOWED_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  // Voice notes — browsers' MediaRecorder API defaults to webm or ogg
  // depending on platform; mp3/mp4/wav covers anything else likely to
  // show up (a forwarded voicemail, a phone's own voice memo app).
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

const MAX_BYTES = 6 * 1024 * 1024; // 6MB decoded — generous for a phone photo or a short voice note

/** Decodes a base64 payload and writes it to disk under a random name.
 *  Returns the public URL path (e.g. "/uploads/ab12cd34.jpg") on
 *  success, or throws an Error with a message safe to show the user
 *  (bad type / too large / bad data) on failure. Shared by both the
 *  receipt-upload and support-attachment-upload endpoints — same
 *  validation and storage either way, just different callers. */
export async function saveUpload({ filename, mimeType, dataBase64 }) {
  if (!dataBase64 || typeof dataBase64 !== "string") {
    throw new Error("No file data received");
  }
  // Browsers append codec params to the mimeType they report back from
  // MediaRecorder (e.g. "audio/webm;codecs=opus" in Chrome, "audio/ogg;
  // codecs=opus" in Firefox) — strip everything from ";" on before
  // matching against ALLOWED_TYPES, which only lists the bare types.
  const baseMimeType = typeof mimeType === "string" ? mimeType.split(";")[0].trim() : mimeType;
  const ext = ALLOWED_TYPES[baseMimeType];
  if (!ext) {
    throw new Error("Unsupported file type — use a JPEG, PNG, WebP, PDF, or a voice note");
  }
  // Body may arrive as a bare base64 string or a data: URL — accept both.
  const commaIdx = dataBase64.indexOf(",");
  const raw = dataBase64.startsWith("data:") && commaIdx !== -1 ? dataBase64.slice(commaIdx + 1) : dataBase64;
  let buf;
  try {
    buf = Buffer.from(raw, "base64");
  } catch {
    throw new Error("Couldn't read that file — try a different one");
  }
  if (buf.length === 0) throw new Error("That file looks empty");
  if (buf.length > MAX_BYTES) throw new Error("File is too large — please keep it under 6MB");

  await mkdir(UPLOADS_DIR, { recursive: true });
  const name = `${Date.now()}-${randomBytes(6).toString("hex")}.${ext}`;
  await writeFile(path.join(UPLOADS_DIR, name), buf);
  return { url: `/uploads/${name}`, originalName: filename || name };
}

// Kept as an alias — existing callers (receipt uploads) import this
// name; new support-attachment callers use saveUpload directly. Same
// function either way.
export const saveReceiptUpload = saveUpload;
