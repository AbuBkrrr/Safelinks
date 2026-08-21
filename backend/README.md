# Reslink Backend

A real, runnable API backend for the Reslink ISP-reselling platform —
Super Admin + Reseller Admin, vouchers issued through the Captive
Portal, a real router polling-agent protocol, and manual-transfer-only
payments at every level.

**One real dependency: `pg` (Postgres).** Everything else is Node's
built-ins:
- `node:http` — the server (`src/http.js`, a ~90-line hand-rolled router)
- `pg` — Postgres driver. This used to be `node:sqlite` for a zero-dependency
  build, but SQLite is single-writer and doesn't hold up once you have
  hundreds of resellers each with routers polling every 30s — see
  "Why Postgres" below.
- `node:crypto` — password/API-key hashing (`scrypt`) and a hand-rolled JWT (HS256, same wire format as the real spec)

## Run it

Needs a reachable Postgres instance. Easiest local option — Docker:

```bash
docker run -d --name reslink-pg -e POSTGRES_USER=reslink -e POSTGRES_PASSWORD=reslink -e POSTGRES_DB=reslink -p 5432:5432 postgres:16-alpine
```

Then:

```bash
npm install
DATABASE_URL=postgres://reslink:reslink@localhost:5432/reslink node src/server.js
```

Listens on `http://localhost:4000` (`PORT=xxxx` to override). First run
migrates the schema and seeds demo data automatically — the server
checks for existing rows before seeding, so it's safe to restart
against the same database. To reset, drop and recreate the database
(or just `docker rm -f reslink-pg` and re-run the `docker run` above
for a clean one).

**Demo logins:**
| Role | Email | Password |
|---|---|---|
| Super Admin | `admin@reslink.io` | `admin123` |
| Reseller (Nairobi Tech Solutions) | `admin@nairobitech.io` | `reseller123` |
| Reseller (Lagos Connect Hub) | `ops@lagosconnect.ng` | `reseller123` |
| Reseller (Kampala Office Net) | `hello@kampalanet.ug` | `reseller123` |

**Demo router API keys** (for testing `/api/router/*` — see below):
`RTR-8841-Q3F` / `sk_demo_r1_router1` and `RTR-3327-M1D` / `sk_demo_r2_router1`.

## Why Postgres (and what changed to get there)

`node:sqlite` was genuinely fine for evaluating this as a demo — but
it's a single file with a single writer, which becomes the actual
bottleneck once there are hundreds of resellers' routers each polling
`/api/router/checkin` every 30 seconds. The migration kept the route
files themselves almost untouched: `db.js` still exposes
`db.prepare(sql).get()/.all()/.run()`, same as before, just async now
and translating `?` placeholders to Postgres's `$1, $2, ...` under the
hood — so every call site just gained an `await`. Two real bugs got
fixed along the way (both would've bitten in production regardless of
database): an N+1 query pattern in the resellers/routers list
endpoints, and `undefined` request-body fields being passed straight
into parameterized queries (now normalized to `null`, which is what
the `COALESCE(?, col)` patterns throughout actually wanted). Timestamp
columns became `BIGINT` (Postgres's plain `INTEGER` is 32-bit and
epoch-ms overflows it), and there are now indexes on every
foreign-key-ish lookup column (`reseller_id`, `voucher_id`,
`(reseller_id, status)`, etc.) that the original schema didn't have.

## Router polling protocol (Primary Method: NAT-safe)

This is the piece that lets a router behind CGNAT, a home connection, or
any network with no public IP still be centrally managed — **it never
needs to be reachable from outside**. The router always calls out.

1. Every 30 seconds, the router's own scheduler (RouterOS
   `/system/scheduler`, an OpenWRT cron job, EdgeOS cron, etc.) POSTs to
   `/api/router/checkin` with its `routerId` and `apiKey`.
2. The server marks it online (`last_check_in = now`) and returns
   whatever commands are queued for it.
3. The router executes each command locally (create/enable/disable/
   delete a hotspot user, in RouterOS terms something like
   `/ip hotspot user add/set/remove`), then POSTs the result to
   `/api/router/commands/:id/ack`.
4. A router is considered **offline** the moment 90 seconds pass with no
   check-in — computed live (`effectiveRouterStatus()` in
   `src/routes/router.js`), not by a background job, since nothing here
   runs a continuous scheduler process. A real deployment would run this
   as an actual periodic job so it can *push* the alert; here it's
   accurate on every read, which is the same end result for a demo.

**Commands are queued automatically** whenever voucher state changes —
pausing/resuming a voucher enqueues `enable_user`/`disable_user` to
every router the reseller owns; deleting one enqueues `delete_user`;
confirming a pending bank-transfer purchase enqueues `create_user`.
Registering a brand-new router (the installer's Agent Registration
step) also syncs every currently-active voucher onto it immediately, so
a freshly provisioned router doesn't start from an empty list.

**Router auth is separate from user auth.** Routers present
`{ routerId, apiKey }` on every call — not a JWT, since they aren't
users and never call `/api/auth/login`. The API key is generated once
at `POST /api/reseller/routers` (called by the installer app), returned
in plaintext exactly that one time, and stored hashed (scrypt) from then
on — same pattern as a password.

```
POST /api/router/checkin
     { routerId, apiKey } -> { commands: [...], nextCheckInSeconds: 30 }

POST /api/router/commands/:id/ack
     { routerId, apiKey, status: 'executed'|'failed', detail? }
     A 'failed' ack notifies the reseller automatically.
```

## Zero-touch provisioning — the self-registering agent (`/api/agent/*`)

`POST /api/reseller/routers` above is the manual path: you already know
the router's model/firmware/IP and type them in. There's also a
zero-touch path where the router registers **itself**, so nobody types
in anything about the device by hand — see `router-scripts/README.md`
for the real MikroTik RouterOS script that speaks this protocol
end-to-end, and `router-scripts/reslink-agent.rsc` for the script
itself.

The device-facing endpoints speak plain `KEY value`-per-line text, not
JSON — RouterOS's scripting language has no real JSON parser, but
splitting on newlines and spaces is a few lines of RouterOS script:

```
POST /api/agent/register
     form-encoded: code, model, firmware, identity
     -> "STATUS OK\nROUTER_ID ...\nAPI_KEY ...\nSYNCED_VOUCHERS N\n"
     `code` is a short-lived pairing code from
     POST /api/reseller/pairing-codes (reseller-authenticated, 15min
     expiry) — the ONE thing a human types in anywhere in this flow.

POST /api/agent/checkin
     form-encoded: router_id, api_key
     -> "STATUS OK\nNEXT_CHECKIN 30\nCOMMAND_COUNT N\nCMD <id> <type> <user> <pass> <deviceLimit> <bandwidth>\n..."

POST /api/agent/commands/:id/ack
     form-encoded: router_id, api_key, status: executed|failed, detail?
```

The reseller-side pairing endpoints:
```
POST /api/reseller/pairing-codes           -> { code, expiresAt }
GET  /api/reseller/pairing-codes/:code     -> { status: pending|used|expired, router? }
```
The installer wizard generates a code, shows it, and polls the second
endpoint until the router calls `/api/agent/register` with it.

**Tested:** the full backend-side flow (pairing code → register →
checkin → command execution → ack → re-checkin shows the queue
drained) end-to-end, both in this repo's test suite and, separately,
by hand against a real running Postgres instance (see "Tested flows"
below). **Not tested:** the RouterOS script itself against real
hardware — see its header comment.

## Payments — manual transfer only, no gateway, anywhere

There is no Stripe/PayPal/M-PESA/crypto integration, by design. Every
payment in the system is a manual bank transfer or USSD push, verified
by a human before anything activates:

- **End-user → Reseller** (voucher purchase, Captive Portal): the
  portal shows the reseller's own bank details (or USSD code), the
  end-user submits a reference, and the reseller confirms it against
  their account before a voucher is issued. See `pending_activations`.
- **Reseller → Super Admin** (license fee): same shape, one level up.
  `GET /api/reseller/platform-bank-info` gives the reseller Super
  Admin's bank details; `POST /api/reseller/license/renew` submits the
  reference; `PUT /api/admin/license-payments/:id` is where Super Admin
  confirms it, which is what actually extends the subscription.

Nothing is ever issued or activated on submission alone — always on
confirmation.

## Email / WhatsApp — manual only, by design (two exceptions)

There is no automated sending for vouchers, delivery, or contact info
— no SendGrid, no Twilio, no WhatsApp Business API.
`GET`/`PUT /api/admin/settings` and `GET`/`PUT /api/reseller/portal-settings`
just store a plain **contact email + WhatsApp number**
(`contactEmail`, `contactWhatsapp`) for the platform and for each
reseller respectively. Resellers see Super Admin's contact info when
they need help; end-users see the reseller's contact info on the
Captive Portal. When a voucher is issued, the reseller emails/WhatsApps
the credentials to the customer themselves — `delivery_logs` just lets
them track that they did it and mark a missed one as sent.

**Two flows genuinely need automated email and now have it:** password
reset can't be secure without an out-of-band channel, and license-
expiry needs to reach a reseller who might not have the dashboard open.
See "Email sending" below — both degrade gracefully to the same
manual-notification pattern if SMTP isn't configured, so this remains
true out of the box with zero mail setup.

## Email sending

`src/email.js` sends real email via `nodemailer` if `SMTP_HOST` is set
(also needs `SMTP_PORT`, `SMTP_USER`/`SMTP_PASS`, `SMTP_FROM` —
see `.env.example`). If it's **not** set — or the send fails for any
reason — `sendEmail()` never throws; it falls back to creating a
Super Admin notification containing the full message, so a human can
send it by hand. This is used by:
- `jobs.js`'s license-expiry sweep — the suspension notice

Password reset no longer uses email at all — see "Account recovery"
under Auth endpoints below. `nodemailer` isn't installed in the
sandbox this was built in (no network access to install it), so the
`getTransporter()` code path that only runs when `SMTP_HOST` is set
has not been exercised against a real mail server; the no-SMTP
fallback path (license-expiry notice → Super Admin notification) is
tested end-to-end. Send yourself a test expiry notice before relying
on real SMTP delivery in production.

## Product keys — offline/manual activation

A second, independent path onto an active license, alongside the
existing bank-transfer-then-confirm flow (`license_payment_requests`
above) — built for deployments that aren't internet-facing, where
"submit a reference number and wait for Super Admin to confirm" isn't
the right shape. Super Admin generates a batch of random keys *for a
payment they've already received outside this system* — vetting
happens before generation, not after — and hands the codes out
however fits (printed cards, a spreadsheet, read aloud over the
phone). A reseller redeems one themselves from their License tab for
**instant** activation; no pending state, no confirmation step.

Keys are formatted `XXXX-XXXX-XXXX-XXXX`, generated from the same
ambiguity-free alphabet as referral/pairing codes (no `0`/`O`, `1`/`l`/`I`
— matters more here than almost anywhere else in the app, since these
get read aloud or typed off a printed card) and always stored
uppercase. Redemption normalizes whatever the reseller types — strips
punctuation, uppercases — before comparing, so `pu9c tmun datc wrsj`
and `PU9C-TMUN-DATC-WRSJ` both work.

```
POST /api/admin/product-keys/generate       { count (1-5000), planId, durationDays?, batchLabel? } -> { batchLabel, count, keys[] }
GET  /api/admin/product-keys/summary        -> { batches: [{ batch_label, total, unused, used, revoked, created_at }] }
GET  /api/admin/product-keys                ?status&batchLabel&limit -> { keys[] }
GET  /api/admin/product-keys/export         ?status&batchLabel -> text/plain download, one key per line
PUT  /api/admin/product-keys/:id/revoke              only an unused key
PUT  /api/admin/product-keys/revoke-batch   { batchLabel } -> revokes every still-unused key in that batch

POST /api/reseller/product-key/redeem       { key } -> { ok, plan, subscriptionExpiry }
     Sets subscription_expiry to now+duration_days, same non-stacking
     convention as a confirmed license payment — it does not add to
     remaining time on an already-active license. Rate-limited
     10/hour/reseller.
```

**A real bug this local-testing pass caught before shipping:**
`genCode()`'s alphabet is mixed-case by default (existing codebase
convention is to `.toUpperCase()` it for referral/pairing codes — see
`routes/auth.js` and `routes/reseller.js`), and the key generator here
initially skipped that step. Since the redeem endpoint always
uppercases the reseller's input before comparing, **every generated
key would have been permanently unredeemable** — a bug that
`node --check` is structurally incapable of catching, since it's a
data-consistency issue between two functions, not a syntax error.
Only surfaced by actually generating a key and trying to redeem it
against a real database. Fixed by uppercasing at generation time.

**A second real bug, same session:** the batch/status filter queries
(`GET /api/admin/product-keys` and its `/export` sibling) used a
placeholder purely in an `IS NULL` check with no adjacent
type-fixing comparison — `(? IS NULL OR pk.status = ?)` — which
Postgres's extended query protocol can't infer a type for on its own,
throwing `could not determine data type of parameter $1` the moment a
filter was actually supplied. Fixed with an explicit `::text` cast on
the `IS NULL` occurrence. Also invisible to `node --check`; only
showed up against a real Postgres connection.

## Referral program

Every reseller gets a unique `referral_code` at signup (visible on
their own Referrals tab). They can share it as a link
(`/?ref=CODE` — Signup.jsx prefills the field from that query param)
or hand it out directly, and can also log specific invites — name plus
email and/or phone — from that same tab, which start as `invited`.

When someone signs up using a reseller's code, `POST /api/auth/signup`
either updates a matching `invited` row (matched by email) to
`signed_up`, or creates one on the spot if there was no prior invite.
Nothing pays out automatically: a `signed_up` referral sits in Super
Admin's Referrals tab until they've actually sent the bonus and mark
it `bonus_paid` — the same manual-transfer-then-confirm pattern as
license payments and pending customer activations elsewhere in this
system. The bonus amount itself is a single platform-wide setting
(`referral_bonus_amount`, Super Admin → Settings, default 10 in the
platform currency), snapshotted onto each referral row at invite/signup
time so a later change to the setting doesn't retroactively alter a
bonus already promised — Super Admin can still override one specific
referral's amount individually (`PUT /api/admin/referrals/:id`) before
paying it, e.g. for a manually-negotiated bonus.

**Abuse mitigations, and their honest limits:**
- Duplicate invites (same referrer + same still-`invited` email) are
  rejected with a 409, and `POST /api/reseller/referrals` is
  rate-limited to 20/hour/reseller.
- A self-referral heuristic flags (rather than blocks) a conversion
  where either the invite's phone matches the referrer's own
  `contact_whatsapp`, or the signup email normalizes to the same
  address as the referrer's own account email — catching the classic
  Gmail dots/`+tag` trick (`jane.doe@gmail.com` vs
  `janedoe+2@gmail.com`). A flagged referral is visible to Super Admin
  but can't be marked paid until reviewed. **This is one real check,
  not a fraud system** — it does nothing to stop someone using a
  genuinely different email/phone for a second account, which would
  need real identity verification this system doesn't have.

## Endpoints

### Auth (public)
```
POST /api/auth/login                       { email, password } -> { token, role, user }

POST /api/auth/signup                      { email, password, companyName, securityQuestion, securityAnswer, referralCode? } -> { token, role, user }
     Self-serve reseller onboarding — creates the account AND logs them
     straight in. Starts status='pending', subscription_expiry already
     elapsed (same shape as any not-yet-paid reseller), so the
     dashboard prompts a license payment rather than treating signup
     itself as activation. Super Admin can't create resellers directly
     — this is the only way one comes into existence. securityQuestion
     is any non-empty string (frontend offers presets from
     SECURITY_QUESTIONS + a custom option); securityAnswer is required,
     min 2 chars, hashed the same way as passwords (see "Account
     recovery" below) — this is the ONLY recovery path, so signup
     enforces both fields rather than treating them as optional. Every
     new reseller also gets their own unique referral_code here,
     regardless of whether they used one themselves. referralCode is
     optional — someone else's code, entered by this signer — a
     bad/unknown code is silently ignored rather than blocking signup;
     see "Referral program" below.

Account recovery — no email anywhere in this flow. A correct answer to
the reseller's own security question IS the identity proof; the reset
token comes straight back in the response, not via a mailed link.

POST /api/auth/password-reset/question     { email } -> { question }
     Looks up the security question set at signup. To avoid leaking
     which emails are registered, an unrecognized email still gets a
     200 with a plausible generic question rather than a 404 — the
     real enumeration protection is at verify-answer below, which
     fails identically either way.

POST /api/auth/password-reset/verify-answer { email, answer } -> { resetToken }
     Answer is normalized (trimmed + lowercased) before comparison. On
     a match, issues a reset token valid 15 minutes — shorter than the
     old emailed link's 1 hour, since there's no inbox-delivery delay
     to account for here. Rate-limited per-email (5/hour) tighter than
     login's per-IP limit, since security answers (birthplaces, pet
     names) are more guessable than a real password.

POST /api/auth/password-reset/confirm      { token, newPassword } -> { ok, message }
     Single use — confirming invalidates every other outstanding reset
     token for that account too. Unchanged in shape from before; only
     where the token comes from changed.
```

### Router polling (public — router API key, not JWT)
```
POST /api/router/checkin
POST /api/router/commands/:id/ack
```

### Router self-registration agent (public — pairing code or router API key, not JWT)
```
POST /api/agent/register              (plain text in/out — see router-scripts/)
POST /api/agent/checkin
POST /api/agent/commands/:id/ack
```

### Captive Portal (public — no auth, end-users never log in)
```
GET  /api/portal/:resellerId/info     (branding + bank/USSD payment details)
GET  /api/portal/:resellerId/plans
POST /api/portal/:resellerId/signup   { name, email, phone, business?, planId, method: 'Bank Transfer'|'USSD', reference }
                                       -> always 202 pending; reseller must confirm
```

### Super Admin (role=super_admin)
```
GET  /api/admin/resellers
PUT  /api/admin/resellers/:id/status
GET  /api/admin/platform-plans
PUT  /api/admin/platform-plans/:id
GET  /api/admin/installations
GET  /api/admin/sessions                     (global, across every reseller)
GET  /api/admin/monitoring                   (router uptime, delivery + command queue depth)
GET  /api/admin/license-payments             (reseller license fee transfers awaiting confirmation)
PUT  /api/admin/license-payments/:id         { decision: confirmed|rejected }
GET  /api/admin/support
PUT  /api/admin/support/:id
GET  /api/admin/notifications
PUT  /api/admin/notifications/read-all
GET  /api/admin/settings                     (contact email/WhatsApp + platform bank info + referral bonus amount)
PUT  /api/admin/settings
GET  /api/admin/referrals                    (every reseller's invites, platform-wide)
PUT  /api/admin/referrals/:id/mark-paid      only valid from status='signed_up' — records a manual payout, same pattern as license payments
```

### Reseller (role=reseller — every route scoped server-side to the caller's own resellerId)
```
GET    /api/reseller/vouchers
PUT    /api/reseller/vouchers/:id/status     { status: active|paused } — also enqueues a router command
DELETE /api/reseller/vouchers/:id            — also enqueues delete_user

GET    /api/reseller/sessions
DELETE /api/reseller/sessions/:id

GET    /api/reseller/routers                 (live-computed online/offline)
POST   /api/reseller/routers                 { model, firmware, ssid, ip, location } -> { routerId, apiKey, syncedVouchers } (manual path)
POST   /api/reseller/pairing-codes           -> { code, expiresAt } (zero-touch path — see "Zero-touch provisioning" above)
GET    /api/reseller/pairing-codes/:code     -> { status, router? }
GET    /api/reseller/commands                 (audit trail: every command queued to this reseller's routers)

GET    /api/reseller/delivery-logs
POST   /api/reseller/delivery-logs/:id/retry

GET    /api/reseller/plans
POST   /api/reseller/plans
PUT    /api/reseller/plans/:id
DELETE /api/reseller/plans/:id
GET    /api/reseller/platform-plans           (read-only catalog — what Super Admin charges, for the license renewal screen)

GET    /api/reseller/portal-settings          (includes contactEmail/contactWhatsapp shown to end-users)
PUT    /api/reseller/portal-settings

GET    /api/reseller/pending-activations
PUT    /api/reseller/pending-activations/:id { decision: confirmed|rejected } — enqueues create_user on confirm

GET    /api/reseller/billing
GET    /api/reseller/platform-bank-info       (where to send the license fee)
GET    /api/reseller/license                  (includes pendingPayment if one is outstanding)
POST   /api/reseller/license/renew            { planId, method, reference } -> 202 pending

GET    /api/reseller/referrals                -> { referralCode, bonusAmount, currency, referrals }
POST   /api/reseller/referrals                { name?, email?, phone? } — at least one of email/phone required
DELETE /api/reseller/referrals/:id            only while status='invited' — a converted referral can't be withdrawn

GET    /api/reseller/notifications
PUT    /api/reseller/notifications/read-all

GET    /api/reseller/support
POST   /api/reseller/support
```

## Tested flows

Two different kinds of "tested" below, kept distinct on purpose —
they catch different classes of bug and neither substitutes for the
other:

**Frontend, actually executed (not just built):** no real browser
binary was installable in the environment this was verified in — so
this used `jsdom` to genuinely execute the compiled React app (as a
classic-script rebuild via esbuild, since jsdom does not execute
`<script type="module">` at all — confirmed directly in its own
source), served through a small proxy to the real running backend,
with real login and real data. Every tab in both the Reseller (13)
and Super Admin (12) dashboards was clicked through with a real
authenticated session and confirmed to render real fetched data (not
just static labels) with zero thrown errors. One genuine, if minor,
accessibility bug turned up and was fixed: unread-count badges (e.g.
"Referrals" + a "1" pill) were running together into one screen-reader
announcement ("Referrals1") — now separated via a proper `aria-label`
("Referrals, 1 unread"), with the visual badge marked
`aria-hidden="true"` to avoid double-announcing.

**Worth being honest about:** the first pass at this reported "all
tabs render cleanly" when in fact a bug in the *test harness itself*
(`window.fetch` wired to Node's fetch, which — unlike a real browser's
fetch — throws immediately on a relative URL instead of resolving it
against the page's own address) meant every data-fetching call in the
app was silently failing, and only static markup had actually been
confirmed. Caught by chasing down a component that looked stuck on
"Loading forever," not by the initial pass itself. Real browser
testing by an actual person, in an actual browser, has still never
happened and remains the biggest open gap — this is a meaningfully
better substitute than nothing, not equivalent to it.

**Verified against a real, locally-running Postgres instance** (not a
stand-in — an actual `postgres` server, actual driver, actual network
round trip):
- Login, wrong-password rejection, wrong-role rejection, cross-role
  403, no-token 401, and post-fix rate limiting (see below) actually
  returning a sane `retryAfterSeconds`
- Password reset end-to-end: get the security question (including the
  generic-fallback question for an unknown email, so the endpoint
  can't be used to enumerate accounts) → wrong answer rejected →
  correct answer accepted case/whitespace-insensitively → reset token
  issued → password actually changes → old password stops working
- Referral program end-to-end: signing up with a valid code converts a
  matching pending invite in place (no duplicate row) and notifies the
  referrer; duplicate invites to the same still-pending email are
  rejected; a Gmail-style `+tag` self-referral is correctly caught and
  `flagged`; Super Admin can't mark a flagged referral paid; a
  signed-up referral's bonus can be edited before payout and is locked
  after
- Every Super Admin and Reseller dashboard endpoint (resellers,
  platform-plans, installations, monitoring, license-payments,
  support, notifications, settings; vouchers, sessions, routers,
  delivery-logs, plans, portal-settings, pending-activations, billing,
  license, support, notifications) returns real data shaped the way
  the frontend expects
- The full Captive Portal → voucher pipeline: end-user signup → lands
  in `pending-activations` → reseller confirms → real voucher exists
  and works
- The full zero-touch MikroTik pairing flow: reseller generates a
  code → agent registers with it → router check-in → shows `online`
  in monitoring with correct uptime% → command issued → acked
- Portal support ticket → lands in the right reseller's customer
  support queue

**One real bug this surfaced, now fixed:** the rate limiter was
silently broken. `pg` returns Postgres `BIGINT` columns as JS
*strings* (not numbers), and `rateLimit.js` was computing
`row.window_start + windowMs` — with `row.window_start` a string, `+`
does concatenation, not addition, so a legitimate 15-minute lockout
was reporting a `retryAfterSeconds` in the quadrillions instead of
`900`. This is exactly the kind of bug that only a real database
connection can catch — every earlier pass on this file was
`node --check` (syntax only), which is silent on driver-level type
behavior like this. Fixed by explicitly coercing `count` and
`window_start` to numbers right after the query; reverified the
bucket now reports `900` and clears correctly after the window. Swept
the rest of the codebase for the same pattern (BIGINT field + `+`) —
no other instances found.

**Verified against a stand-in query engine** (this repo's own test
suite, not a real Postgres connection) — still real coverage of
routing/logic bugs, just not of driver-level behavior like the one
above:
- Cross-tenant isolation: reseller B given reseller A's voucher ID
  directly → 404, not 403 — genuinely invisible, not just denied
- **Router check-in → command queued → router picks it up → acks it
  executed → gone from the pending list → visible in the audit trail**
- A **failed** ack correctly raises a reseller notification, and that
  notification is actually readable via `GET /api/reseller/notifications`
  (this surfaced a real gap on first pass — that endpoint didn't exist
  yet; added and reverified)
- Registering a new router auto-syncs existing active vouchers as
  queued `create_user` commands
- Portal signup rejects the old instant methods (`Card` → 400) and
  accepts `Bank Transfer`/`USSD`, always landing in `pending`
- Reseller confirming a pending voucher purchase → voucher created +
  `create_user` command enqueued; double-confirming → 409
- Full manual license-payment loop: reseller fetches Super Admin's bank
  info → submits a reference → 409 on a second submission while one's
  pending → Super Admin confirms → reseller's plan/expiry actually
  updates
- Settings write/read round-trip for the platform's contact email/
  WhatsApp number and bank info
- Postgres migration: full regression pass after the `node:sqlite` →
  `pg` swap — login, N+1-fixed list endpoints, partial-update routes
  with omitted fields (the `undefined`-param bug), router registration
  + auto-sync, router check-in/ack, portal signup → pending → confirm,
  license renewal → confirm, delete/read-all routes' `changes` counts
  (originally tested against a stand-in query engine, since Postgres
  itself wasn't installable in that particular sandbox at the time —
  since superseded by the real-Postgres pass above, which is the one
  worth trusting)
- Both recurring sweeps (`src/jobs.js`): router-offline detection fires
  once on the online→offline transition and stays silent on repeat
  ticks; license-expiry now auto-suspends `active` resellers (leaves
  `pending`/already-`suspended` alone), fires once per expiry timestamp,
  and correctly stays silent after, via the same
  `UPDATE ... RETURNING`-based dedup
- The generic Linux agent script (`router-scripts/reslink-agent-linux.sh`):
  registration and check-in run for real against a live backend — real
  HTTP, real credential file, real command dispatch and ack (with a
  stand-in for the actual hotspot backend — see that file's header)

## Limitations / what a production build adds

- ~~SQLite → Postgres~~ **done** — see "Why Postgres" above.
- ~~90-second offline detection computed on read only~~ **done** —
  `src/jobs.js` now runs two recurring sweeps: router-offline detection
  (every 30s) and license-expiry notification (hourly), each a single
  `UPDATE ... RETURNING` so they stay correct — no duplicate
  notifications, no distributed lock needed — even with multiple
  backend instances running concurrently. Deliberately **not** a real
  job queue (Redis/BullMQ/pg-boss): this system has no external side
  effects to retry with backoff — no payment gateway, no automated
  email/WhatsApp — so a queue library would be infrastructure for a
  workload that doesn't exist. If that changes (e.g. real email sending
  gets added later), that's when a queue actually earns its place.
- **Router protocol translation: MikroTik and generic Linux, both real,
  neither fully hardware-verified.** `router-scripts/reslink-agent.rsc`
  (MikroTik, native `/ip hotspot user`) and `reslink-agent-linux.sh`
  (OpenWRT/EdgeOS/generic Linux, via a pluggable `apply_command()`
  defaulting to CoovaChilli) between them cover the large majority of
  routers capable of running custom firmware at all — this is no
  longer a MikroTik-only gap. But: the RouterOS script is written
  against documented syntax with zero hardware runs (no RouterOS
  available to test against); the Linux script's registration/check-in/
  ack IS genuinely tested end-to-end against a live backend, but its
  default CoovaChilli command execution is not (no CoovaChilli install
  available either). Closed consumer firmware with no shell access at
  all (stock Netgear/TP-Link, etc.) remains genuinely out of reach —
  that's a hardware/firmware decision, not a software gap.
- ~~No real email/WhatsApp sending~~ **partially done** — see "Email
  sending" above. License-expiry notices send real email (with a
  manual-notification fallback if SMTP isn't configured); password
  reset no longer uses email at all (security-question based, see
  "Account recovery" above); voucher delivery and contact info remain
  100% manual by design.
- ~~License expiry doesn't auto-suspend~~ **done** — `sweepLicenseExpiry()`
  now flips `active` → `suspended` and emails the reseller directly, in
  addition to the existing in-app notifications. Reinstating happens
  the same way it already did: Super Admin confirming a license
  payment sets status back to `active`.
- ~~No reseller onboarding~~ **done** — `POST /api/auth/signup` is
  fully self-serve; see the root README's "Reseller onboarding" section.
- ~~No rate limiting~~ **done** — `src/rateLimit.js`, Postgres-backed
  (correct across multiple backend instances, no Redis needed) rather
  than in-memory. Covers login (10/15min/IP), signup (5/hour/IP),
  password-reset-question and password-reset-verify-answer (10/hour/IP
  **and** 5/hour/target-email independently — the second one stops an
  attacker spread across many IPs from brute-forcing one reseller's
  security answer), pairing-code registration (20/15min/IP, matching
  the code's own expiry window), router/agent check-in and ack
  (120/15min/IP, generous enough for several routers behind one NAT),
  and captive-portal signup (30/hour/IP, deliberately loose since real
  customers can share one IP at a busy location).
  Tested directly (window resets correctly, independent keys don't
  interfere, blocked requests get 429 + `retryAfterSeconds`) and via
  real HTTP against the live server (11th rapid login attempt from one
  IP gets blocked — including a subsequently-correct password, which is
  the intended behavior — 6th password-reset-verify-answer attempt for
  one email gets blocked regardless of IP).
- **Single-process, but horizontally scalable now.** JWT auth is
  already stateless and Postgres is shared, so running multiple
  backend instances behind a load balancer is mostly a docker-compose
  change away — nothing in the request-handling code assumes one process.
