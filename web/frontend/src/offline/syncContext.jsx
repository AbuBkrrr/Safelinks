import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { startSyncWatcher } from "./syncEngine.js";
import * as offlineStore from "./offlineStore.js";

const SyncContext = createContext(null);

/**
 * Wrap any part of the app that needs offline support in this once.
 * `actionHandlers` maps an action `type` string to an async function
 * that replays it against the real API — see ResellerApp.jsx's
 * `pendingActivationHandlers` for the concrete example.
 */
export function SyncProvider({ children, actionHandlers }) {
  const [online, setOnline] = useState(null); // null = not checked yet
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSyncResult, setLastSyncResult] = useState(null);
  const handlersRef = useRef(actionHandlers);
  handlersRef.current = actionHandlers;

  async function refreshPendingCount() {
    const pending = await offlineStore.getPendingActions();
    setPendingCount(pending.length);
  }

  useEffect(() => {
    refreshPendingCount();
    const stop = startSyncWatcher({
      apiBaseUrl: "",
      handlers: handlersRef.current,
      intervalMs: 15000,
      onStatusChange: (update) => {
        setOnline(update.online);
        if (update.justReconnected) setLastSyncResult(update);
        refreshPendingCount();
      },
    });
    return stop;
  }, []);

  return (
    <SyncContext.Provider value={{ online, pendingCount, lastSyncResult, refreshPendingCount }}>
      {children}
    </SyncContext.Provider>
  );
}

export function useSyncStatus() {
  const ctx = useContext(SyncContext);
  // Safe default for anything rendered outside a SyncProvider (e.g.
  // during tests, or a screen that doesn't need offline support) -
  // reads as "online, nothing queued" rather than crashing.
  return ctx || { online: true, pendingCount: 0, lastSyncResult: null, refreshPendingCount: async () => {} };
}

/**
 * Queues an action for later sync. Returns the client-generated ID,
 * useful for optimistic UI (e.g. showing "syncing..." next to the
 * specific item this action was about).
 */
export async function queueOfflineAction(type, payload) {
  const id = "offline_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
  await offlineStore.queueAction({ id, type, payload });
  return id;
}
