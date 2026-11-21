# Going live: settings, payments, messaging, routers

This is the checklist for running SAFE_Links as a working ISP platform. For
hosting the web app itself, follow `DEPLOYMENT.md` (VPS) or `RAILWAY.md`.

## 1. Backend environment variables

| Variable | Required | What it does |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection |
| `JWT_SECRET` | yes | Signs logins (long random string) |
| `SUPER_ADMIN_EMAIL` | yes | Your super-admin login email |
| `SUPER_ADMIN_PASSWORD` | yes | Its password (10+ characters). Applied on every start; also removes the demo `admin@safelinks.io` account |
| `APP_URL` | yes | Public site URL, e.g. `https://www.safelinks.name.ng`. Captive portal and renew links use it |
| `PUBLIC_API_URL` | yes | Public backend URL routers download their setup from, e.g. `https://api.safelinks.name.ng` |
| `PAYSTACK_SECRET_KEY` | yes (NG) | Card, USSD and Instant Transfer payments; reseller payouts |
| `PLATFORM_FEE_PCT` | no (5) | Your cut of every customer payment when a reseller has payouts on |
| `TERMII_API_KEY` | recommended | Sends SMS/WhatsApp: reminders, OTP, receipts, alerts, broadcasts |
| `TERMII_SENDER_ID` | no | Approved sender name (default `SafeLinks`) |
| `TERMII_CHANNEL` | no | `generic`, `dnd` or `whatsapp` |
| `BUSINESS_TZ_OFFSET` / `BUSINESS_TZ` | no | Default `1` / `Africa/Lagos`: happy hour, daily summary, receipts |
| `DAILY_SUMMARY_HOUR` | no | Hour (local) of the reseller's earnings message, default 21 |
| `DOWNLOADS_BASE` | no | Where `/downloads/*` redirects; defaults to this repo's latest GitHub release |

Without `TERMII_API_KEY` messages are not delivered but are still recorded in
each reseller's **Growth → Messages** outbox.

## 2. Paystack

1. Dashboard → Settings → API keys: put the **secret key** in `PAYSTACK_SECRET_KEY`.
2. Settings → Webhooks: `https://<PUBLIC_API_URL>/api/payments/webhook/paystack`.
3. Ask Paystack to enable **Pay with Transfer** (Instant Transfer in the portal).
4. Resellers turn on automatic payouts themselves in **Growth → Payouts**
   (bank + account number; the name is verified with Paystack).

Payments are confirmed by the webhook **and** by the portal polling Paystack,
so a lost webhook never strands a customer; a payment can only be fulfilled once.

## 3. Setting up a router (any computer, any app)

Every path runs the same single line on the MikroTik, so every copy of every
app always applies the current script:

* **Dashboard → Routers → "Add a router — one line"**: enter the WiFi name
  (and PPPoE details if the ISP needs them), copy the line, paste it in
  Winbox → New Terminal.
* **Windows installer / desktop app / Android app**: they request the same
  line from the backend and run it for you.

The router configures WAN, LAN bridge, WiFi (old and new MikroTik WiFi
packages), DHCP, DNS, NAT, the hotspot, the pages that hand customers to the
portal, and the pre-login allow list (portal + payment sites only), then pairs
itself and checks in every 15 seconds. Re-running it is safe; a re-installed
router keeps its record. Requirements: MikroTik RouterOS 7 (6.45+ should
work), internet on `ether1` (or PPPoE), LAN on the other ports/WiFi.

The script lives in `web/backend/router-scripts/safelinks-setup.rsc`; edit it
there only.

## 4. Apps

`.github/workflows/build-apps.yml` builds the Windows installer, the desktop
app and the Android APK on every change and publishes them to the latest
GitHub release on `main`. The site's download buttons point there.

## 5. What customers and resellers get

* Customers: pay by Instant Transfer / card / USSD, get logged in automatically;
  speed, device count, data cap and time are enforced by the router; a reminder
  1 hour before expiry with a one-tap renew link (same login, no reconnect);
  wallet with auto-renew; free trial; promo and referral codes; loyalty
  (every Nth purchase free); time/data remaining bar.
* Resellers: same-day payouts, earnings by day/plan/hour/router, daily
  earnings message, router-down/back-up alerts and remote reboot, promo codes,
  happy hour, printed voucher cards with agent commission, customer list and
  SMS/WhatsApp broadcast.
