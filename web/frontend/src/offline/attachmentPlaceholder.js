// A placeholder "URL" for an attachment that's been captured offline
// but not uploaded yet â€” the real Blob lives in offlineStore's blobs
// store, keyed by the same ID. This lets every existing attachmentUrl
// field stay a plain string (used in state, sent in queued action
// payloads, etc.) without threading a richer type through the whole
// app - only the few places that actually need to tell "a real
// server URL" apart from "still local" use these helpers.

const PREFIX = "offlineblob:";

export function makePlaceholder(id) {
  return PREFIX + id;
}

export function isPlaceholder(url) {
  return typeof url === "string" && url.startsWith(PREFIX);
}

export function extractBlobId(url) {
  return url.slice(PREFIX.length);
}
