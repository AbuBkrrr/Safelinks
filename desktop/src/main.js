// SAFE_Links desktop app — a thin native window around the whole web app
// (Super Admin, Reseller, and the Captive Portal), same "one app, routes
// you by who's signed in" philosophy as the Android app in
// android-app/. See that project's README for the reasoning; it
// applies here unchanged.
//
// A small native picker (picker.html) runs once, on first launch,
// before anything web loads: "I'm a Reseller / Admin" or "I'm pairing
// a router". This isn't decorative — it's the only way /install is
// reachable at all from this app. The web app's own text pointing
// people to /install (see ../web-app/frontend/src/App.jsx's Landing
// component) is plain, non-clickable text meant for a browser user
// who can type a URL; this window has no address bar either. Same
// reasoning as the Android app's PickerActivity — see that project's
// README for the fuller writeup, since it was confirmed there against
// the actual source rather than assumed.
//
// Session persistence: Electron persists localStorage/cookies per-app
// automatically (in the OS's app-data folder), the same way a real
// browser remembers you're logged into a site — no extra code needed
// for "stay signed in across restarts" to work. The picker's mode
// choice is persisted separately (mode.json in the same app-data
// folder), and switching modes later doesn't touch either — you stay
// signed in across a mode switch too.

const { app, BrowserWindow, shell, session, Menu, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const { locateGateway } = require("./native/gatewayLocator");
const { RouterOsClient } = require("./native/routerOsClient");
const {
  buildInstallCheckinScript,
  buildRegisterScript,
  InvalidPairingCodeError,
} = require("./native/routerOsScripts");

// ---------------------------------------------------------------------
// THE ONE THING YOU MUST CHANGE: point this at your real deployed site
// before building. See README.md.
// ---------------------------------------------------------------------
const SERVER_URL = "https://REPLACE-WITH-YOUR-DOMAIN.com/";

const ALLOWED_ORIGIN = (() => {
  try {
    return new URL(SERVER_URL).origin;
  } catch {
    return null;
  }
})();

let mainWindow;

// -----------------------------------------------------------------
// Mode persistence — plain JSON file in Electron's own per-app data
// folder. Deliberately not a new npm dependency (e.g. electron-store)
// for something this small; fs + one JSON file is enough and keeps
// this app's dependency footprint limited to what LAN pairing
// actually needs (default-gateway — see native/gatewayLocator.js).
// -----------------------------------------------------------------
function modeFilePath() {
  return path.join(app.getPath("userData"), "mode.json");
}

function readSavedMode() {
  try {
    const raw = fs.readFileSync(modeFilePath(), "utf8");
    const data = JSON.parse(raw);
    if (data.mode === "reseller_admin" || data.mode === "installer") return data.mode;
  } catch {
    // No saved mode yet (first launch), or the file's unreadable/corrupt
    // — either way, treat as "not chosen yet" and show the picker.
  }
  return null;
}

function saveMode(mode) {
  try {
    fs.mkdirSync(path.dirname(modeFilePath()), { recursive: true });
    fs.writeFileSync(modeFilePath(), JSON.stringify({ mode }), "utf8");
  } catch (e) {
    console.error("Could not persist mode choice:", e);
  }
}

function urlForMode(mode) {
  const base = SERVER_URL.endsWith("/") ? SERVER_URL.slice(0, -1) : SERVER_URL;
  return mode === "installer" ? `${base}/install` : `${base}/`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#f0f2f5",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    title: "SAFE_Links",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  buildMenu();

  const savedMode = readSavedMode();
  if (savedMode) {
    // Normal launch with a mode already chosen — skip the picker
    // entirely, load straight into the right place, no flash of the
    // picker screen. "Switch Mode" in the menu re-shows it later
    // without clearing this.
    mainWindow.loadURL(urlForMode(savedMode)).catch(() => showOfflineFallback());
  } else {
    mainWindow.loadFile(path.join(__dirname, "picker.html"));
  }

  // If the initial or any later navigation fails (no internet, server
  // not deployed yet, DNS failure, etc.), show a local fallback page
  // instead of Electron's default blank/error screen.
  mainWindow.webContents.on("did-fail-load", (_event, errorCode) => {
    // -3 is ERR_ABORTED, which fires on normal cancelled navigations
    // (e.g. a redirect) — not a real failure, ignore it.
    if (errorCode !== -3) showOfflineFallback();
  });

  // "View receipt" / "view attachment" links throughout the app open
  // with target="_blank" — by default Electron would open those in a
  // second full app window, which looks like a bug (a second copy of
  // the whole shell) rather than "view this file". Sending them to the
  // system's own browser/PDF/image viewer instead matches what the
  // Android app does for the same links, and is what people expect for
  // "leave the app to look at a file" style links.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Basic navigation guard: only ever navigate within the configured
  // server's origin. Links that legitimately go elsewhere (there
  // aren't any in this app today) would need to be handled via
  // setWindowOpenHandler above, not by allowing arbitrary top-level
  // navigation here. picker.html and offline.html are loaded via
  // loadFile() from the main process, not renderer-initiated
  // navigation, so this guard doesn't apply to (and doesn't block)
  // either of those.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (ALLOWED_ORIGIN && new URL(url).origin !== ALLOWED_ORIGIN) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

function showOfflineFallback() {
  mainWindow.loadFile(path.join(__dirname, "offline.html"));
}

function buildMenu() {
  // A minimal menu — just enough to navigate, switch mode, and quit.
  // No "Toggle Developer Tools" front-and-center for a production
  // consumer app; it's still reachable via the standard OS shortcut if
  // genuinely needed for support/debugging, just not advertised here.
  const template = [
    {
      label: "SAFE_Links",
      submenu: [
        { role: "reload" },
        {
          label: "Back",
          accelerator: "Alt+Left",
          click: () => { if (mainWindow.webContents.canGoBack()) mainWindow.webContents.goBack(); },
        },
        {
          label: "Forward",
          accelerator: "Alt+Right",
          click: () => { if (mainWindow.webContents.canGoForward()) mainWindow.webContents.goForward(); },
        },
        { type: "separator" },
        {
          label: "Switch Mode",
          click: () => { if (mainWindow) mainWindow.loadFile(path.join(__dirname, "picker.html")); },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// -----------------------------------------------------------------
// LAN router auto-pairing (MikroTik only) — see native/routerOsClient.js
// for the trust-on-first-use design (the security-critical part) and
// native/routerOsScripts.js for what actually gets pushed to the
// router. One active pairing session at a time, matching the Android/
// Kotlin version's design: a probe result can't accidentally be
// reused against a different router than the one it was captured from.
// -----------------------------------------------------------------
let activeClient = null;
let activeGatewayIp = null;

function describeResult(result) {
  if (result.type === "Success") return "ok";
  if (result.type === "HttpError") return `HTTP ${result.code}: ${String(result.body).slice(0, 200)}`;
  if (result.type === "NetworkError") return result.message;
  if (result.type === "CertMismatch") return "router's certificate changed since it was confirmed - aborted";
  return "unknown error";
}

ipcMain.handle("lan-probe", async (_event, { adminUser, adminPass }) => {
  const gateway = await locateGateway();
  if (gateway.error) return { ok: false, error: gateway.error };

  const client = new RouterOsClient(gateway.gatewayIp);
  const result = await client.probe(adminUser, adminPass);

  if (result.type === "Success") {
    activeClient = client;
    activeGatewayIp = gateway.gatewayIp;
    return { ok: true, gatewayIp: gateway.gatewayIp, fingerprint: client.pinnedFingerprint };
  }
  if (result.type === "HttpError") {
    return { ok: false, error: `Router rejected the request (HTTP ${result.code}). Check the admin username/password.` };
  }
  if (result.type === "NetworkError") {
    return { ok: false, error: `Couldn't reach ${gateway.gatewayIp}: ${result.message}. Is the REST API (www-ssl) enabled on this router?` };
  }
  return { ok: false, error: "Unexpected certificate state during probe." };
});

ipcMain.handle("lan-pair", async (_event, { pairingCode, adminUser, adminPass, confirmedFingerprint }) => {
  if (!activeClient || !activeGatewayIp) {
    return { ok: false, error: "No active probe session - call probe() first." };
  }
  if (activeClient.pinnedFingerprint !== confirmedFingerprint) {
    return { ok: false, error: "Fingerprint you confirmed doesn't match what was probed - aborting rather than risk pairing the wrong device." };
  }

  const installScript = buildInstallCheckinScript(SERVER_URL);
  const installResult = await activeClient.execute(installScript, adminUser, adminPass, confirmedFingerprint);
  if (installResult.type !== "Success") {
    return { ok: false, error: `Could not install the check-in script: ${describeResult(installResult)}` };
  }

  let registerScript;
  try {
    registerScript = buildRegisterScript(pairingCode, SERVER_URL);
  } catch (e) {
    if (e instanceof InvalidPairingCodeError) return { ok: false, error: e.message };
    throw e;
  }

  const registerResult = await activeClient.execute(registerScript, adminUser, adminPass, confirmedFingerprint);
  if (registerResult.type === "Success") {
    const match = registerResult.body.match(/ROUTER_ID=(\S+)/);
    // One-shot: clear session state so a stray extra call can't
    // silently reuse stale credentials/session state.
    activeClient = null;
    activeGatewayIp = null;
    return { ok: true, routerId: match ? match[1] : null };
  }
  return { ok: false, error: `Registration failed: ${describeResult(registerResult)}` };
});

// -----------------------------------------------------------------
// Mode selection from picker.html (see preload.js's chooseMode).
// -----------------------------------------------------------------
ipcMain.on("mode-chosen", (_event, mode) => {
  if (mode !== "reseller_admin" && mode !== "installer") return;
  saveMode(mode);
  if (mainWindow) {
    mainWindow.loadURL(urlForMode(mode)).catch(() => showOfflineFallback());
  }
});

// Without this, launching the app again while it's already running (a
// double-click on the desktop icon, or Start Menu) opens a second,
// completely independent window rather than focusing the existing one
// — confusing for a business app where "am I looking at the same
// session or a different one?" actually matters. requestSingleInstanceLock()
// returns false in the SECOND process the instant it starts, so
// everything below (whenReady, window creation) only ever needs to run
// in the first/real instance — the second one just quits immediately.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // Support tickets can attach a voice note, recorded via the browser's
    // getUserMedia() API. Electron blocks all media-device permission
    // requests by default; this grants microphone access only to the
    // app's own configured origin — not to arbitrary sites, since nothing
    // else ever loads in this window, but worth being explicit about.
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      if (permission === "media") {
        const requestingOrigin = new URL(webContents.getURL()).origin;
        callback(!ALLOWED_ORIGIN || requestingOrigin === ALLOWED_ORIGIN);
        return;
      }
      callback(false);
    });

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
