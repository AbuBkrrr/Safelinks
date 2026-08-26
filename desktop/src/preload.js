"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/**
 * Exposed to the renderer as window.ReslinkNative. Runs with
 * contextIsolation: true (see main.js's webPreferences) — this file
 * is the ONLY bridge between the sandboxed page and anything with
 * real system access, and it exposes exactly three narrow methods,
 * nothing else.
 *
 * All three are Promise-based via ipcRenderer.invoke/ipcMain.handle,
 * Electron's own documented request/response IPC pattern for use with
 * contextIsolation. Deliberately NOT using a fire-and-forget-plus-
 * global-callback pattern (i.e. having this preload script try to
 * call a function the page's own script set on window) — with
 * contextIsolation on, the preload script and the page run in
 * genuinely separate JS contexts, and reliably calling a function
 * object across that boundary isn't something contextBridge is
 * designed to support in that direction. Promises avoid the question
 * entirely.
 */
contextBridge.exposeInMainWorld("ReslinkNative", {
  /**
   * Used by picker.html only. Tells the main process which mode was
   * chosen; main.js persists it and navigates accordingly. Fire-and-
   * forget is fine here — the main process's own navigation is the
   * visible result, there's nothing for the picker page to await.
   */
  chooseMode: (mode) => ipcRenderer.send("mode-chosen", mode),

  /**
   * LAN router pairing — see routerOsClient.js / routerOsScripts.js /
   * gatewayLocator.js for the implementation, and RouterLanBridge.kt
   * (the original standalone-app version) for the fuller design
   * writeup. Same protocol Capacitor.Plugins.RouterLanPairing uses on
   * Android, just positional args instead of Capacitor's object-arg
   * convention — see LanAutoPair's adapter in InstallerWizard.jsx.
   */
  probe: (adminUser, adminPass) =>
    ipcRenderer.invoke("lan-probe", { adminUser, adminPass }),

  pairWithConfirmedFingerprint: (pairingCode, adminUser, adminPass, confirmedFingerprint) =>
    ipcRenderer.invoke("lan-pair", { pairingCode, adminUser, adminPass, confirmedFingerprint }),
});
