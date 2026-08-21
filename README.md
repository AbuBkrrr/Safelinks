# SAFE_Links — complete package

A product of A I Brains Ventures. This repo has everything built so
far: the actual web application, native Android and Windows apps that
wrap it, a clickable offline demo, and a standalone testing tool. Each
piece has its own detailed README — this file is just the map.

**New here? Start with [`DEPLOYMENT.md`](./DEPLOYMENT.md)** — a
complete, no-assumptions, step-by-step guide from an empty checkout to
a live production deployment.

## Start here: deployment order matters

The Android and Windows apps are **empty shells without the web app
deployed somewhere first** — they're just windows that load a URL. Build
in this order:

1. **`web-app/`** — deploy this first. It's the actual system: the
   Node/Postgres backend and the React frontend (Super Admin dashboard,
   Reseller dashboard, Captive Portal). See `web-app/README.md` and
   `web-app/deploy/README.md` — Docker Compose + Caddy gets you a live
   HTTPS domain in one command.
2. **`android-app/`** — once step 1 is live, edit
   `android-app/capacitor.config.json` with your real domain, then open
   `android-app/android/` in Android Studio. See `android-app/README.md`.
3. **`desktop-app/`** — same idea for Windows: edit
   `desktop-app/src/main.js` with your real domain, run
   `npm run package:win`, then compile `desktop-app/SAFE_Links.iss` in
   Inno Setup Compiler. See `desktop-app/README.md`.

One app, one login system — a person signs in once on any of these
(web, Android, or Windows) and lands on their own dashboard based on
their account role. The router-pairing wizard is reachable from the
same app too, but **not via a link on the welcome screen** — an earlier
version of this README claimed that; checked directly against
`web-app/frontend/src/App.jsx`'s `Landing` component, and the text
pointing people to `/install` is plain, non-clickable text meant for a
browser user who can type a URL, not an actual link. Since neither the
Android nor Windows app has an address bar, that left field technicians
with genuinely no way to reach the wizard from either native app. Both
now show a small native picker on first launch — "I'm a Reseller /
Admin" or "I'm pairing a router" — which is what actually makes
`/install` reachable from a cold app launch. See either app's own
README for the fuller writeup.

## `system-demo/`

A single self-contained HTML file — open it directly in any browser,
no server or deployment needed. Click through mocked versions of all
three surfaces (Reseller Admin, Super Admin, Captive Portal) with fake
data, useful for showing someone what the system looks like before it's
actually deployed anywhere. Nothing in it reads from or writes to your
real system.

## `tools/lan-pairing-test/`

A small standalone script for testing LAN router auto-pairing's
network-detection code directly against your real router, on your own
machine — no app build required. See that folder's own README. Not
needed to deploy or go live; useful whenever you get around to testing
that specific feature for real.

## What's been fixed / added, most recent first

- **LAN router auto-pairing**, on both native apps — pairs a MikroTik
  router directly over the local network instead of typing the pairing
  code into the router's console by hand, using trust-on-first-use
  certificate pinning (not blind trust) so it fails closed if anything
  about the router's identity looks wrong mid-pairing. Wired into the
  same `LanAutoPair` component in `web-app/frontend/src/InstallerWizard.jsx`
  for both apps, feature-detecting whichever native bridge is present
  so it's a no-op everywhere else (plain browser, PWA, iOS). See either
  app's own README for the full security writeup — it's worth reading
  before turning this on for real users, not just enabling it.
- **Native first-launch picker on both apps** ("I'm a Reseller / Admin"
  vs "I'm pairing a router") — see the corrected claim above. This is
  what actually fixed the missing-`/install`-access gap; a first
  version of this README described the gap as already solved when it
  wasn't.
- **A real packaging bug caught and fixed**: the desktop app's
  `package:win` script explicitly ignored `node_modules`, which was
  harmless when it had zero runtime dependencies but would have
  silently stripped LAN pairing's one new dependency
  (`default-gateway`) out of every distributed `.exe`. Confirmed both
  the bug and the fix by actually running `npm run package:win` and
  inspecting the resulting `app.asar` directly, not just reading the
  script.
- **A real dependency-API bug caught and fixed**: an early version of
  the desktop LAN-pairing code called `defaultGateway.v4()`, based on a
  web search result for an older major version of that package.
  Actually installing and running it in the environment this was built
  in showed the real, current API is `gateway4async()` — caught only
  because it was executed, not because it was read carefully enough.
- **A documentation overclaim corrected**: both the Android and desktop
  LAN-pairing code originally described the generated RouterOS script
  as a "byte-identical"/"line-for-line" copy of
  `web-app/reslink-backend/router-scripts/reslink-agent.rsc`. Actually
  diffing generated output against that file showed real (harmless)
  differences — the one-shot registration step runs inline instead of
  as a persisted script object, and log wording is paraphrased. Fixed
  the claim in both apps' code comments and READMEs to describe what's
  actually true: faithful to the logic, not a byte-for-byte copy.
- Desktop app: single-instance lock (launching while already running
  now focuses the existing window instead of opening a duplicate).
- Android app: four native-layer gaps fixed beyond the default
  Capacitor scaffold — "view receipt" links now actually open,
  voice-note recording permission properly declared, hardware back
  button navigates within the app instead of exiting it, keyboard no
  longer covers input fields on forms.
- Android app converted from an installer-only app to the universal
  app described above.
- Full SAFE_Links rebrand (was "Reslink") — every user-visible string,
  the platform's default support contact, license payee name.
- Real file/voice-note upload support on every support-ticket surface.
- Fixed: a crash on the Super Admin Referrals tab (a missing state
  declaration — `editingBonusId` was used but never initialized).
- Fixed: server errors no longer leak internal error text to the
  client; full detail still goes to your server log.
- Fixed: negative-price validation gap on reseller voucher plans.

## What was actually verified this pass, not just read

Everything above involving LAN pairing was checked by really running
it, in the environment this was built in — not inferred from reading
the code:

- `node --check` on every new `.js` file (real syntax validation).
- The RouterOS script generator was actually executed and its output
  diffed against the real `.rsc` source file directly — this is what
  caught the documentation overclaim above.
- `npm install` actually run for the desktop app, including the new
  `default-gateway` dependency.
- `npm run package:win` actually run, twice (before/after the
  packaging fix), with the resulting `app.asar` inspected directly to
  confirm the fix worked.
- The packaged Electron app was actually launched (headless, via Xvfb)
  and stayed running with no thrown errors.
- **The entire frontend was built through its real production Vite
  pipeline** (`npm run build` in `web-app/frontend/`) — 2,313 modules
  transformed, zero errors, including the new `LanAutoPair.jsx` and the
  modified `InstallerWizard.jsx`. This is the strongest verification
  in this pass — a real compile of the real toolchain, not a read-through.
- What could **not** be verified: the Android app (no JVM/Android SDK
  in this environment — verified by reading Capacitor's own library
  source directly instead, and cross-checking the Java LAN-pairing code
  structurally against the independently-verified Node version), the
  Inno Setup compile step (Windows-only GUI tool), and LAN pairing's
  actual behavior against a real router (nothing to test against here).

## Support

A I Brains Ventures — aibrainsventures@gmail.com — +234 803 254 0215
