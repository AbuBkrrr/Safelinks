# Reslink

A white-label ISP-reselling platform: a Super Admin who runs the
platform, Resellers who run their own branded WiFi business on top of
it, and end-users who pay for internet access through a Captive
Portal. Two pieces, both real, wired together:

- **`reslink-backend/`** — the API. Postgres-backed, real dependencies
  are `pg` and `nodemailer` (optional — see "Email sending" below).
  Everything else is Node built-ins. See `reslink-backend/README.md`
  for the full endpoint list, the router check-in protocol, and — importantly
  — an honest **Limitations** section on what's still open.
- **`frontend/`** — the three UIs (Super Admin dashboard, Reseller
  dashboard, Captive Portal) plus the router installer and reseller
  signup/password-reset flows, all making real calls to the backend
  above.

**Payments are manual transfer only, everywhere** — bank transfer or
USSD, verified by a human, never a gateway. **Most email/WhatsApp is
manual too** — Super Admin and each reseller just store a contact
address/number for voucher delivery and support; the one exception is
license-expiry notices, which send real email (see "Email sending").
Password reset doesn't use email at all — see "Account recovery" below.

## Reseller onboarding is self-serve

Anyone can create a reseller account (`POST /api/auth/signup` /
the "Create an account" link on the Reseller Admin login screen) and
lands in a working dashboard immediately — there's no Super Admin
approval gate. The account starts `pending` with an already-elapsed
subscription, same as any reseller who hasn't paid yet, so the License
tab prompts them to submit their first payment. Super Admin cannot
create a reseller account directly; this is the only path one comes
into existence.

**Account recovery:** no email involved. Every reseller sets a secret
security question (a preset list, or their own custom question) at
signup — required, not optional, since it's the only way back in.
"Forgot password?" on the login screen asks for that question, checks
the answer, and on a match issues a short-lived reset session right
there in the browser (`POST /api/auth/password-reset/question` →
`/verify-answer` → `/confirm`) — no SMTP dependency for this flow at
all.

**Product keys (offline/manual activation):** Super Admin generates a
batch of one-time activation codes for a payment already received
outside the system, and hands them out through whatever channel fits
a non-internet-facing deployment. A reseller redeems one from their
License tab for instant activation — no waiting on confirmation. A
second, independent path onto an active license alongside the
existing bank-transfer flow; a deployment can use either or both.
Full detail in `reslink-backend/README.md`.

**Referral program:** every reseller has their own referral code and a
Referrals tab (log an email/phone invite, or just share a
`/?ref=CODE` link — Signup.jsx prefills it). Someone signing up with a
valid code gets tracked automatically; the bonus itself is a manual
payout Super Admin marks paid from their own Referrals tab, same
pattern as every other payment in this system. Duplicate invites to
the same email are rejected, a same-email-different-trick heuristic
flags likely self-referrals (see backend README), and Super Admin can
adjust an individual bonus amount before paying it out. Full detail in
`reslink-backend/README.md`.

**Voice commands & accessibility:** every dashboard (Reseller, Super
Admin, and the pre-login landing page) has a floating voice-command
widget, bottom-right — say things like "vouchers", "read
notifications", or "log out" instead of clicking. It requires
SpeechRecognition (Chrome/Edge; Safari/Firefox don't support it and
the mic button disables itself there with an explanation) but every
response is also written into an `aria-live` region regardless of
browser, so a screen-reader user gets it read back by their own
assistive tech even where voice input itself isn't available. The
sidebar is also now real `<nav>`/`<button>` markup with
`aria-current`, and there's a "skip to main content" link for keyboard
users. This has NOT been tested with a real screen reader (VoiceOver/
NVDA/JAWS) or on an actual blind or motor-impaired user — it's built
to the relevant ARIA patterns, not verified by anyone who actually
relies on this daily. Please have it checked by someone who does
before treating it as reliable.

## Local development

Three terminals:

```bash
# terminal 1 — Postgres (or point DATABASE_URL at one you already run)
docker run -d --name reslink-pg -e POSTGRES_USER=reslink -e POSTGRES_PASSWORD=reslink -e POSTGRES_DB=reslink -p 5432:5432 postgres:16-alpine

# terminal 2 — backend
cd reslink-backend
npm install
DATABASE_URL=postgres://reslink:reslink@localhost:5432/reslink node src/server.js
# -> http://localhost:4000, migrates + seeds demo data on first run
# (SMTP_HOST etc are optional — see "Email sending" below; unset is fine for local dev)

# terminal 3 — frontend
cd frontend
npm install
npm run dev
# -> http://localhost:5173, proxies /api to localhost:4000
```

This exact setup (real local Postgres, not a stand-in) has been
run and smoke-tested by hand — login, signup, password reset,
referrals, the Captive Portal → voucher pipeline, and the zero-touch
router pairing flow all confirmed working against a live database.
One real bug turned up and got fixed in the process (a rate-limiter
type bug that only a real Postgres connection could have surfaced —
see `reslink-backend/README.md` → "Tested flows" for the detail).
That's real confidence for the flows listed there; everything else
in this app is still only `node --check`-verified or covered by the
mocked test suite, not run against a live database.

Open `http://localhost:5173`:
- `/` — Reseller welcome screen ("Create an account" / "Log in" /
  "Forgot password?"), with a small Super Admin login link tucked in
  the top-right corner
- `/portal/r1` — the Captive Portal for demo reseller "Nairobi Tech
  Solutions" (try `r2`, `r3` too)
- `/install` — the standalone router installer

**Demo logins** (see `reslink-backend/README.md` for the full table):
| Role | Email | Password |
|---|---|---|
| Super Admin | `admin@reslink.io` | `admin123` |
| Reseller | `admin@nairobitech.io` | `reseller123` |

## Email sending

License-expiry notices send real email via `nodemailer` if `SMTP_HOST`
(+`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM`) is set — see
`.env.example`. **Leave it unset and the system still works**: it
falls back to a Super Admin notification containing the full message,
so a human can send it by hand instead. The no-SMTP fallback path is
tested end-to-end; actual SMTP delivery isn't (no network access to
install `nodemailer` in the environment this was built in) — send
yourself a test expiry notice before trusting this in production.
Password reset doesn't touch this at all — it's answered by a security
question set at signup, entirely in-app. Full detail in
`reslink-backend/README.md`.

## Installing as an app

Both the reseller's router installer and the Super Admin dashboard are
installable as standalone apps (a real home-screen icon and app-like
window, via the browser's native install feature — no app store or
separate mobile build needed):

- **Reseller — `/install`**: open it in Chrome/Safari on the phone
  that'll be used in the field, then "Add to Home Screen" (iOS) or
  "Install app" (Android/Chrome). It launches straight into the
  router-pairing flow, no browser chrome, under the name "Reslink
  Installer".
- **Super Admin — `/`**: same idea from the root URL; installs as
  "Reslink Admin". Session persists per device, so after the first
  login it reopens straight into the dashboard.

This only works over HTTPS (or `localhost`) — it's inert during local
`npm run dev` over plain HTTP, which is expected.

## Deploying to a VPS

```bash
git clone <this repo> && cd reslink
cp .env.example .env        # set JWT_SECRET, POSTGRES_PASSWORD; SMTP_* optional
# edit Caddyfile: replace yourdomain.com with your real domain (DNS A record must already point here)
docker compose up -d --build
```

That's it — Caddy fetches a Let's Encrypt certificate automatically on
first boot, and Postgres runs as its own container with a persistent
volume. Already running your own nginx (or your own Postgres)? See
`deploy/README.md` for that path instead.

**Before real customers touch it:**
1. Log in as Super Admin → **Settings** and set your real contact
   email/WhatsApp + bank details (resellers pay their license fee
   here).
2. Set `SMTP_*` in `.env` if you want real license-expiry-suspension
   emails instead of the manual-notification fallback (password reset
   doesn't use email at all — see "Account recovery" above).
3. Change the seeded demo passwords / remove the demo accounts
   (`reslink-backend/src/db.js`'s `seed()` function) before going live
   — they're meant for evaluation, not production.
4. Read `reslink-backend/README.md`'s **Limitations** section. What
   matters most now: the router scripts (MikroTik native + generic
   Linux/CoovaChilli — see `router-scripts/README.md`) are real but not
   fully hardware-tested, so validate on a spare device first.

## What's genuinely wired end-to-end right now

- Self-serve reseller signup (auto-login on success) and password
  reset (real email or manual-fallback notification) — real JWTs, real
  password hashing throughout
- Reseller: vouchers, sessions, routers, delivery logs, plans, portal
  branding, pending-payment confirmation, billing, license renewal,
  support tickets — all hitting the real API
- Super Admin: resellers, platform plans, installations, sessions,
  monitoring, license payment confirmation, support, notifications,
  settings — all hitting the real API
- Captive Portal: real plan lookup, real manual-transfer submission,
  always lands as "pending" (there is no instant path — matches the
  backend, which has no gateway)
- Installer: two real paths — zero-touch pairing (generates a
  short-lived code; the router registers itself via a real MikroTik
  RouterOS script or a real, tested generic-Linux shell script; nobody
  types in the router's model/firmware/IP) and manual entry (any other
  vendor) — both return a real one-time API key
- Postgres (not SQLite) with indexes on every hot lookup column —
  ready for hundreds of resellers' worth of concurrent router
  check-ins, not just one demo tenant
- Two recurring sweeps: router-offline detection (30s),
  license-expiry auto-suspend + email (hourly) — instead of only
  computing status reactively when someone loads a dashboard
- Rate limiting on every public, unauthenticated endpoint (login,
  signup, password reset, pairing/router check-in, portal signup) —
  Postgres-backed, correct across multiple backend instances
