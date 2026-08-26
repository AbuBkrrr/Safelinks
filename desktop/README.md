# SAFE_Links — Windows desktop app

A native desktop window around the whole SAFE_Links web app — same "one
app, routes you to your own dashboard based on sign-in" idea as the
Android app in `android-app/`.

**A small native picker (`picker.html`) runs once, on first launch**,
before anything web loads: "I'm a Reseller / Admin" or "I'm pairing a
router". This isn't decorative — it's the only way `/install` is
reachable at all from this app. The web app's own text pointing people
to `/install` (`web-app/frontend/src/App.jsx`'s `Landing` component) is
plain, non-clickable text meant for a browser user who can type a URL;
this window has no address bar either.

Once past the picker, routing works exactly like the website: not
signed in shows the welcome screen, signed in as a reseller or Super
Admin goes straight to the matching dashboard, installer mode opens the
pairing wizard directly. Both the mode choice and your login session
are remembered across restarts — Electron persists local storage
per-app the same way a browser does per-site, and the mode choice is
saved separately (`mode.json` in the app's own data folder), so
switching modes later (**SAFE_Links menu → Switch Mode**) doesn't touch
your session either.

Two separate tools are involved, used in order:

1. **`npm run package:win`** — builds the actual app (an Electron app,
   bundled with its own Chromium + Node runtime) into a folder of files
   including `SAFE_Links.exe`.
2. **Inno Setup Compiler** — takes that folder and produces a single
   proper Windows installer (`SAFE_Links-Setup.exe`) with a Start Menu
   entry, optional desktop icon, and an uninstaller.

You need both steps — Inno Setup packages what's already built, it
doesn't build the app itself.

## 1. Point it at your server

Open **`src/main.js`** and change this line near the top:

```js
const SERVER_URL = "https://REPLACE-WITH-YOUR-DOMAIN.com/";
```

to your real deployed domain (see the `deploy/` folder and root
`README.md` in the main SAFE_Links zip — Docker Compose + Caddy handles
deployment in one command). Do this **before** step 2 below — the URL
gets bundled into the app when it's packaged, there's no in-app settings
screen to change it later without repackaging.

## 2. Build the app

Requires [Node.js](https://nodejs.org) (any recent LTS). From this
project's folder:

```bash
npm install
npm run package:win
```

`npm install` now pulls in one runtime dependency —
[`default-gateway`](https://github.com/silverwind/default-gateway),
used by LAN router auto-pairing (see below) to find the local network's
gateway. **A packaging bug in `package:win` was caught and fixed while
adding this**: the script used to pass `--ignore="^/node_modules"` to
`electron-packager`, which was harmless when this app had zero runtime
dependencies, but would have silently stripped `default-gateway` out of
the packaged `.exe` entirely — the feature would work in `npm start`
(dev mode, `node_modules` present on disk) and silently fail once
actually distributed. Fixed by removing that flag; `electron-packager`
already prunes `devDependencies` automatically by default, so real
`dependencies` like this one are included without needing to list them
explicitly.

This cross-compiles a real Windows build even if you're running this on
Mac/Linux — Electron ships prebuilt per-platform runtimes, so no
Windows-specific toolchain is needed for this step specifically (Inno
Setup itself, in step 3, does need to run on Windows).

Output lands in `dist\SAFE_Links-win32-x64\` — that whole folder is the
app; `SAFE_Links.exe` is what launches it directly if you just want to
test it without building an installer yet (double-click it or run it —
no install needed to try it).

This step produces a large output folder (~350MB) — that's normal and
expected for any Electron app, not a packaging mistake. It bundles a
full Chromium + Node runtime, the same way every Electron app (Slack,
Discord, VS Code) does.

## 3. Build the installer

1. Install [Inno Setup](https://jrsoftware.org/isinfo.php) (Windows
   only — this step has to happen on a Windows machine).
2. Open **Inno Setup Compiler**.
3. `File → Open` → select **`SAFE_Links.iss`** in this project's root.
4. `Build → Compile` (or press F9).

The finished installer lands at `Output\SAFE_Links-Setup.exe`. That's
the one file you actually hand out or distribute — running it installs
SAFE_Links to the current user's Program Files (no admin rights
required by default — the installer does ask if you'd rather install
system-wide for all users instead), adds a Start Menu entry, and an
uninstaller.

`SAFE_Links.iss` expects `dist\SAFE_Links-win32-x64\` to already exist
from step 2 — if you rename or move that folder, update
`SourceBaseDir` near the top of the `.iss` file to match.

## What's already handled

I read Electron's own APIs directly to confirm each of these (not
guessed), the same way I verified things for the Android app — see the
comments in `src/main.js` for the reasoning behind each:

- **"View receipt" / "view attachment" links** (`target="_blank"`) open
  in your system's default browser/PDF/image viewer, rather than
  spawning a confusing second copy of the whole app window.
- **Voice notes on support tickets** — microphone access is granted
  only to the app's own configured domain, not to arbitrary sites
  (nothing else ever loads in this window, but worth being explicit).
- **Attaching a receipt photo/file** — needed no extra code; Electron's
  full Chromium engine already implements a native file picker for
  `<input type="file">` out of the box.
- **Session persistence** — signing in is remembered across app
  restarts automatically; Electron persists local storage per-app the
  same way a browser does per-site, no extra code needed.
- **Back/Forward navigation** — `Alt+Left` / `Alt+Right`, or the menu.
- **Single-instance lock** — opening the app while it's already running
  focuses the existing window instead of spawning a confusing second,
  independent copy.
- **Offline fallback** (`src/offline.html`) — shown if the app can't
  reach your server, instead of Electron's default blank error page.
- **App icon + installer icon** — generated from the SAFE_Links brand
  colors (`#667eea` → `#764ba2`), already wired into both the packaged
  `.exe` (via `--icon=build/icon.ico` in the `package:win` script) and
  the installer itself (`SetupIconFile` in the `.iss`).
- **First-launch mode picker + mode switching** — `picker.html` /
  `preload.js`'s `chooseMode` / `mode.json` persistence (see top of
  this README). Verified end-to-end by actually launching this app
  under Xvfb (a headless X server) in the environment this was built
  in — it opened its window, loaded the picker with no thrown errors,
  and stayed running — not just read and assumed to work.

### LAN router auto-pairing (new)

Pairs a MikroTik router directly over the local network instead of
someone typing the pairing code into the router's console by hand — if
this PC is on the same network as the router. Exposed to the web app as
`window.ReslinkNative` (`src/preload.js`, `src/native/routerOsClient.js`,
`src/native/routerOsScripts.js`, `src/native/gatewayLocator.js`), wired
into the pairing UI via `web-app/frontend/src/InstallerWizard.jsx`'s
`LanAutoPair` component (already applied there, not left as a manual
patch — same component the Android app uses, feature-detecting whichever
native bridge is present).

This is a genuinely different trust model from the rest of the app, so
it's worth reading in full before turning it on for real users:

- **This does NOT use Node's `https.request()`.** Node's
  `checkServerIdentity` callback is documented as advisory-only when
  `rejectUnauthorized: false` — "unauthorized connections may still be
  accepted" regardless of what that callback returns, which isn't a
  strong enough guarantee for something that's supposed to fail closed.
  `routerOsClient.js` instead connects with raw `tls.connect()`, checks
  the peer certificate's fingerprint itself, and only writes any
  request bytes — including the Basic Auth header carrying the router's
  admin password — after that check has already passed. If the
  fingerprint doesn't match, the socket is destroyed before a single
  byte of the request goes out.
- **Trust-on-first-use certificate pinning, not blind trust.** RouterOS's
  REST API ships with a self-signed cert by default. The first
  connection in a pairing session captures its SHA-256 fingerprint and
  shows it on-screen for a human to compare against the router's own
  sticker/console before anything changes; every connection after that,
  within the same session, must present that exact fingerprint.
- **Requires the router's admin password, typed in fresh each time.**
  Never stored, never defaulted to blank/factory credentials.
- **Only helps MikroTik routers with the REST API (`www-ssl`) enabled.**
  `LanAutoPair` simply doesn't render its automatic option if
  `window.ReslinkNative` isn't present.
- **The generated RouterOS script faithfully ports the logic of its
  source, but isn't a byte-identical copy.** `routerOsScripts.js`
  reproduces the same HTTP calls, response parsing, and hotspot-user
  command handling as `web-app/reslink-backend/router-scripts/reslink-agent.rsc`
  — this was actually verified by generating real output and diffing it
  against that file directly, not just asserted (see the corrected
  claim in the file's own header comment — an earlier draft overstated
  this as a "byte-identical" port, which the diff showed wasn't quite
  true: the one-shot registration step runs inline instead of as a
  persisted script object, and log wording is paraphrased). That source
  file's own header says it was written against documented RouterOS 7
  syntax, not validated against physical hardware — this generator
  inherits that same status.
- **Gateway detection was caught getting the dependency's API wrong, and
  fixed.** An early version called `defaultGateway.v4()`, based on a
  web search result for an older major version of the `default-gateway`
  package. Actually installing and running it in this environment
  showed the real, current API is `gateway4async()` — a genuine bug
  that would have broken LAN pairing at runtime with a "not a function"
  error, caught only because it was actually executed rather than
  trusted from documentation.
- **Assumes frontend and backend share an origin** — the RouterOS
  script's API base is `SERVER_URL` (this app's own configured URL),
  not a separate setting. True by default in this project's own
  `docker-compose.yml`/Caddy setup; if that ever changes, this needs
  its own config value instead.

## What was actually tested (not just read and assumed)

Every claim below was verified by really running something, in the
environment this was built in — not inferred from reading the code:

- `npm install` — ran for real; resolved cleanly, including the new
  `default-gateway` dependency.
- `node --check` on every new/changed `.js` file — real syntax
  validation via Node's own parser, not a manual read-through.
- The RouterOS script generator — actually **executed**, not just
  read: generated real output for both functions, asserted the pairing
  code substitutes correctly, the API URL's trailing slash gets
  trimmed, invalid pairing codes are rejected with the right error
  type, and diffed the real generated output against
  `web-app/reslink-backend/router-scripts/reslink-agent.rsc` directly
  — which is what caught the "byte-identical" overclaim mentioned
  above.
- `default-gateway`'s actual API — this is the one that mattered most:
  an early version called `.v4()` based on a web search result. Adding
  it as a real dependency and requiring it in this environment showed
  the installed version's real exports are `gateway4async` /
  `gateway4sync` / `gateway6async` / `gateway6sync` — `.v4()` doesn't
  exist and would have thrown `"v4 is not a function"` the first time
  anyone tried LAN pairing. Fixed and re-verified against the
  package's own README.
- **`npm run package:win` — actually run, twice**: once before the
  `--ignore="^/node_modules"` fix (to confirm the bug was real —
  `default-gateway` was genuinely absent from the packaged app), and
  once after, then inspected the resulting `app.asar` directly (via
  `@electron/asar list`) to confirm `default-gateway` is now inside it,
  every new source file (`main.js`, `preload.js`, `picker.html`,
  `native/*.js`) is present, and `electron-packager` itself (a
  devDependency) is correctly absent.
- **The packaged app was actually launched** — under Xvfb (a headless X
  server) with `--no-sandbox` — since this is a genuinely fresh build
  of `main.js` with a new preload script and IPC handlers, and reading
  the code isn't the same as watching it not crash. It opened its
  window, loaded `picker.html` with no thrown errors from `main.js` or
  `preload.js`, and stayed running — the only console output was
  harmless dbus warnings expected in a container with no session bus.

## Honest limitation

What could **not** be tested: the Inno Setup compile step itself (a
Windows-only GUI tool with no command-line equivalent available), and
LAN pairing's actual network behavior against a real router (this
environment has no router to test against, and `gateway4async()`
itself needs the `ip` command on Linux, which this particular sandbox
doesn't have installed — confirmed that's the only remaining failure
mode by checking the error message directly, not guessed). `routerOsClient.js`'s
TOFU/certificate-pinning logic was written to be verifiable by reading
(raw `tls.connect()`, no reliance on Node's advisory-only
`checkServerIdentity` behavior when `rejectUnauthorized: false` — see
that file's own doc comment for why that distinction mattered), but
its first real run against an actual RouterOS device is the true test,
same as the `.rsc` script it drives.

## Windows SmartScreen warning (expected, not a bug)

The first time someone runs `SAFE_Links-Setup.exe` on a machine that
hasn't seen it before, Windows will very likely show a blue "Windows
protected your PC" SmartScreen warning, since the installer isn't
digitally code-signed. This isn't a mistake in the build — it's the
same thing every unsigned Windows app triggers, and it's the direct
equivalent of Android's "install from unknown sources" prompt for the
APK. There's a "More info → Run anyway" link to get past it.

The only real fix is a code-signing certificate from a certificate
authority (DigiCert, Sectigo, etc.) — typically a paid yearly
subscription, and (like the Android release keystore) something you'd
need to obtain and hold yourselves, not something I can generate or
embed on your behalf. Signing removes the warning and is worth doing
before wide distribution, but isn't required to install and run the
app.
