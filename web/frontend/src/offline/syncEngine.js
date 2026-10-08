// Orchestrates syncing: checks real backend reachability (not just
// navigator.onLine, which only reflects OS-level network status and
// is notoriously unreliable — a phone can report "online" while on a
// WiFi network with no actual internet, e.g. a captive portal that
// hasn't been completed yet), then replays queued offline actions in
// order against the real API.
//
// This file has ZERO knowledge of what a "voucher" or "ticket" is —
// callers register a handler per action type. That's what makes this
// reusable across every offline-capable feature, not just vouchers.

import * as store from "./offlineStore.js";

/**
 * Real reachability check — a lightweight GET against the backend's
 * own health endpoint, with a short timeout so a hung connection
 * doesn't block the UI from knowing "actually, we're offline."
 */
export async function checkConnectivity(apiBaseUrl, { timeoutMs = 4000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/health`, {
      signal: controller.signal,
      cache: "no-store",
    });
    return res.ok;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Replays every pending/failed queued action, in the order they were
 * created, against the real API — using the handler registered for
 * that action's `type`. Stops replaying (but doesn't discard) further
 * actions after the first failure that looks like a connectivity
 * problem, to preserve ordering — but a handler-reported REJECTION
 * (e.g. "that voucher code already exists") is recorded as a
 * permanent failure and does NOT block subsequent actions, since
 * that's a real answer from the server, not a network hiccup.
 *
 * @param {Object} handlers - { [actionType]: async (payload) => result }
 *   A handler should THROW for a genuine network/connectivity failure
 *   (caller will stop and retry the whole batch later), or return
 *   { rejected: true, reason } for a real server-side rejection that
 *   isn't going to succeed on retry (caller records it and moves on).
 * @returns {Object} { syncedCount, failedCount, stoppedEarly }
 */
export async function syncPendingActions(handlers) {
  const pending = await store.getPendingActions();
  let syncedCount = 0;
  let failedCount = 0;

  for (const action of pending) {
    const handler = handlers[action.type];
    if (!handler) {
      await store.markActionFailed(action.id, `No sync handler registered for action type "${action.type}"`);
      failedCount++;
      continue;
    }

    await store.markActionSyncing(action.id);
    try {
      const result = await handler(action.payload);
      if (result && result.rejected) {
        await store.markActionFailed(action.id, result.reason || "Rejected by server");
        failedCount++;
        continue; // a real rejection, not a network problem - keep going
      }
      await store.markActionSynced(action.id);
      syncedCount++;
    } catch (e) {
      // Treat as a connectivity problem: stop here to preserve replay
      // order rather than let later actions jump ahead of one that
      // might still succeed once the network's actually back.
      await store.markActionFailed(action.id, e.message || String(e));
      return { syncedCount, failedCount: failedCount + 1, stoppedEarly: true };
    }
  }

  return { syncedCount, failedCount, stoppedEarly: false };
}

/**
 * Small orchestrator: periodically checks connectivity, and syncs
 * when it transitions from offline -> online (not on every single
 * check while already online, to avoid hammering the server).
 * Returns a stop() function.
 */
export function startSyncWatcher({ apiBaseUrl, handlers, intervalMs = 15000, onStatusChange }) {
  let wasOnline = null; // null = unknown yet, so the first check always fires
  let stopped = false;

  async function tick() {
    if (stopped) return;
    const isOnline = await checkConnectivity(apiBaseUrl);
    if (isOnline && !wasOnline) {
      const result = await syncPendingActions(handlers);
      onStatusChange?.({ online: true, justReconnected: true, ...result });
    } else if (wasOnline !== isOnline) {
      onStatusChange?.({ online: isOnline, justReconnected: false });
    }
    wasOnline = isOnline;
  }

  tick();
  const id = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(id);
  };
}
