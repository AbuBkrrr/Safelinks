// Storage layer for offline-first operation: caches GET-style data for
// offline viewing, and queues write actions (create voucher, reply to
// ticket, etc.) taken while offline for later replay against the real
// API. Pure IndexedDB, no external dependencies â€” works unmodified in
// any browser/WebView/Electron renderer. Tested here against
// fake-indexeddb, a real (not mocked) IndexedDB implementation, so
// this exact code path is genuinely exercised, not just reasoned about.

const DB_NAME = "safelinks_offline";
const DB_VERSION = 2;
const STORE_CACHE = "cache";
const STORE_QUEUE = "queue";
const STORE_BLOBS = "blobs";

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CACHE)) {
        db.createObjectStore(STORE_CACHE, { keyPath: "collection" });
      }
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        const store = db.createObjectStore(STORE_QUEUE, { keyPath: "id" });
        store.createIndex("status", "status", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// --- cache: for offline viewing of the last-known server data ---

export async function setCachedCollection(collection, data) {
  const db = await openDb();
  const tx = db.transaction(STORE_CACHE, "readwrite");
  tx.objectStore(STORE_CACHE).put({ collection, data, cachedAt: Date.now() });
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getCachedCollection(collection) {
  const db = await openDb();
  const tx = db.transaction(STORE_CACHE, "readonly");
  const result = await promisify(tx.objectStore(STORE_CACHE).get(collection));
  return result || null; // null means "never cached", distinct from an empty list
}

// --- queue: write actions taken offline, to replay once reconnected ---

export async function queueAction({ id, type, payload }) {
  const db = await openDb();
  const tx = db.transaction(STORE_QUEUE, "readwrite");
  tx.objectStore(STORE_QUEUE).put({
    id,
    type,
    payload,
    status: "pending",
    createdAt: Date.now(),
    attempts: 0,
    lastError: null,
  });
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPendingActions() {
  const db = await openDb();
  const tx = db.transaction(STORE_QUEUE, "readonly");
  const all = await promisify(tx.objectStore(STORE_QUEUE).getAll());
  // Oldest first â€” actions must replay in the order they happened,
  // e.g. two edits to the same voucher must apply in the right order.
  return all.filter((a) => a.status === "pending" || a.status === "failed").sort((a, b) => a.createdAt - b.createdAt);
}

export async function getAllActions() {
  const db = await openDb();
  const tx = db.transaction(STORE_QUEUE, "readonly");
  const all = await promisify(tx.objectStore(STORE_QUEUE).getAll());
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function markActionSynced(id) {
  const db = await openDb();
  const tx = db.transaction(STORE_QUEUE, "readwrite");
  tx.objectStore(STORE_QUEUE).delete(id);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function markActionFailed(id, errorMessage) {
  const db = await openDb();
  const tx = db.transaction(STORE_QUEUE, "readwrite");
  const store = tx.objectStore(STORE_QUEUE);
  const existing = await promisify(store.get(id));
  if (existing) {
    store.put({ ...existing, status: "failed", attempts: existing.attempts + 1, lastError: errorMessage });
  }
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function markActionSyncing(id) {
  const db = await openDb();
  const tx = db.transaction(STORE_QUEUE, "readwrite");
  const store = tx.objectStore(STORE_QUEUE);
  const existing = await promisify(store.get(id));
  if (existing) store.put({ ...existing, status: "syncing" });
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- blobs: raw file/audio data captured offline, uploaded at sync time ---
// Keyed by a client-generated ID. The "placeholder URL" convention
// (see attachmentPlaceholder.js) lets every existing attachmentUrl
// field in the app stay a plain string - no type changes needed
// anywhere else - while still being able to tell "a real server URL"
// apart from "a blob sitting locally, not uploaded yet."

export async function storePendingBlob({ id, blob, mimeType, filename }) {
  const db = await openDb();
  const tx = db.transaction(STORE_BLOBS, "readwrite");
  tx.objectStore(STORE_BLOBS).put({ id, blob, mimeType, filename, createdAt: Date.now() });
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPendingBlob(id) {
  const db = await openDb();
  const tx = db.transaction(STORE_BLOBS, "readonly");
  const result = await promisify(tx.objectStore(STORE_BLOBS).get(id));
  return result || null;
}

export async function deletePendingBlob(id) {
  const db = await openDb();
  const tx = db.transaction(STORE_BLOBS, "readwrite");
  tx.objectStore(STORE_BLOBS).delete(id);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Exposed for tests only â€” real app code never needs to reset this.
export function _resetForTests() {
  dbPromise = null;
}
