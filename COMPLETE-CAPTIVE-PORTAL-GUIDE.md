# SAFE_Links Captive Portal - End-to-End Working Guide

**OBJECTIVE:** Users connect to MikroTik WiFi/LAN → get redirected to captive portal → subscribe → pay → get internet access.

**STATUS:** Production live on www.safelinks.name.ng. Local testing on PC (192.168.88.253) with MikroTik router (192.168.88.1).

---

## Architecture Overview

```
┌─ MikroTik Router (192.168.88.1) ─────────────────────────────┐
│ Configured with:                                               │
│ - WiFi SSID + Hotspot (broadcasts WiFi OR wired access)       │
│ - Walled Garden: allows www.safelinks.name.ng (portal domain) │
│ - Captive Portal: redirects all HTTP to portal login page     │
│ - Redirects to: https://www.safelinks.name.ng/login           │
└─────────────────────────────────────────────────────────────────┘
                            │
                  [End-User Device]
                     (connects to WiFi)
                            │
                 Browser → HTTP request to any site
                            │
         MikroTik Hotspot intercepts & redirects
                            │
      https://www.safelinks.name.ng/login (PORTAL)
                            │
     ┌─ SAFE_Links Portal Server ────────────────────────────────┐
     │                                                             │
     │ Docker Stack (Backend + Frontend)                          │
     │ - Backend API (Node.js + Postgres):                        │
     │   • /api/portal/:resellerId/info                           │
     │   • /api/portal/:resellerId/plans                          │
     │   • POST /api/portal/:resellerId/signup (create voucher)   │
     │                                                             │
     │ - Frontend (React): Portal UI                              │
     │   • User signs up: name, email, phone                      │
     │   • Selects plan                                           │
     │   • Submits payment reference (bank transfer or USSD)      │
     │   • API creates "pending_activations" record              │
     │                                                             │
     └─────────────────────────────────────────────────────────────┘
                            │
     ┌─ Reseller Dashboard ──────────────────────────────────────┐
     │                                                             │
     │ - Sees pending activation                                 │
     │ - Reviews payment details from end-user                   │
     │ - Confirms receipt of money                               │
     │ - Clicks "Confirm" → creates voucher                      │
     │   (username/password for hotspot login)                   │
     │                                                             │
     └─────────────────────────────────────────────────────────────┘
                            │
     ┌─ MikroTik Router (Agent) ──────────────────────────────────┐
     │                                                             │
     │ - Receives new voucher via API check-in                   │
     │ - Adds hotspot user with voucher credentials              │
     │                                                             │
     └─────────────────────────────────────────────────────────────┘
                            │
       ┌─ End-User Logs in to Hotspot ────────────┐
       │ Username: [voucher user]                  │
       │ Password: [voucher pass]                  │
       │ → Internet access granted!                │
       └──────────────────────────────────────────┘
```

---

## What's Already Built (and Working)

✅ **Backend (Node.js + Postgres):**
- Routes: `/api/auth/*` (login/signup), `/api/portal/*` (captive portal), `/api/reseller/*` (dashboard)
- Database: Postgres, auto-migrated on first boot
- Demo data: seeded with Super Admin + 3 test Resellers

✅ **Frontend (React):**
- Super Admin dashboard (manage resellers, monitor routers, settings)
- Reseller dashboard (manage routers, plans, vouchers, pending activations, billing)
- Captive Portal (end-user signup, plan selection, payment submission)

✅ **Router Scripts (.rsc):**
- `safelinks-configure.rsc`: Configure hotspot + walled garden + DNS redirect
- `safelinks-agent.rsc`: Auto-register router + check-in scheduler + voucher sync

---

## QUICK START: Local Testing

### Step 1: Start the Docker Stack

```powershell
cd C:\Users\DELL\Downloads\safe-links-updated

# First time: builds images (takes ~10 minutes)
docker compose up

# Subsequent: just runs
docker compose up -d
```

### Step 2: Wait for Services

```powershell
# Check status
docker compose ps

# Expected:
#   NAME                STATUS               PORTS
#   postgres            Up (healthy)         5432
#   backend             Up                   4000:4000
#   frontend            Up                   80:80
```

### Step 3: Verify Backend

```powershell
# Test API
curl http://localhost:4000/health
# Expected: {"ok":true,"service":"safe-links-backend"}

# Check database logs
docker compose logs postgres | Select-String "ready"
```

### Step 4: Access the Portals

| Role | URL | Email | Password |
|---|---|---|---|
| **Super Admin** | http://localhost | admin@SAFELINKS.io | admin123 |
| **Reseller** | http://localhost | admin@nairobitech.io | reseller123 |
| **Portal (End-User)** | http://localhost/login | (self-signup) | — |

---

## Configure MikroTik Hotspot

### Option A: Via Winbox (Easiest - GUI)

1. **Download Winbox** from mikrotik.com
2. **Connect:** IP = 192.168.88.1, user = admin (no password usually)
3. **Upload Script:**
   - Files menu → Upload `safelinks-configure.rsc` (located at `C:\Users\DELL\Downloads\safe-links-updated\installer\src-tauri\resources\safelinks-configure.rsc`)
4. **Import Script:**
   - New Terminal → type:
   ```
   /import file=safelinks-configure.rsc
   ```
   - Wait ~30 seconds for script to complete
5. **Verify Hotspot:**
   - Check IP → Hotspot → Profiles: should see `safelinks-profile`
   - Check IP → Hotspot → Servers: should see `safelinks-hotspot` running

### Option B: Via SSH (Command Line)

```bash
# From your PC
ssh admin@192.168.88.1
# (password: usually blank or "admin")

# Once connected:
/import file=safelinks-configure.rsc
```

---

## Test the Captive Portal Flow

### From Your PC (Simulating End-User on WiFi)

1. **If Router has WiFi Enabled:**
   - Connect your smartphone or second PC to the WiFi SSID (`SafeLinks-WiFi` by default)
   - Open a browser, go to any HTTP site (e.g., `http://google.com`)
   - **Expected:** Auto-redirect to `http://192.168.88.1:8080/login`

2. **If Testing via LAN Cable:**
   - Connect a device via Ethernet to the router's LAN port
   - Open a browser, go to `http://192.168.88.1:8080/login`
   - **Expected:** Portal login page loads

3. **What You Should See:**
   - SAFE_Links captive portal page
   - End-user signup form (name, email, phone, select plan)
   - Payment method options (Bank Transfer / USSD)
   - Reseller's bank details OR USSD code

### End-to-End Test Sequence

#### 1. End-User Signs Up via Portal

```
Action: End-user fills signup form
  Name: John Doe
  Email: john@example.com
  Phone: +234 701 234 5678
  Plan: Select any plan (e.g., "1GB - 1 Day")
  Payment: Bank Transfer
  Reference: TX123456789

Click: "Subscribe"

Result: Portal shows "Payment pending. Your reseller will confirm soon."
```

#### 2. Reseller Sees Pending Activation

```
Navigate to:
  Dashboard → Pending Activations

Reseller sees:
  Name: John Doe
  Email: john@example.com
  Plan: 1GB - 1 Day
  Amount: $5 (or platform currency)
  Status: Awaiting Confirmation
  Reference: TX123456789
```

#### 3. Reseller Confirms Payment

```
Action: Reseller reviews bank/USSD payment received
  (simulated — assume they received the money)

Click: "Confirm" button

Result:
  - Voucher created (username + password)
  - Status changes to "Confirmed"
  - Router receives command to add hotspot user
  - End-user can now log in to hotspot
```

#### 4. Verify Voucher in Reseller Dashboard

```
Navigate to:
  Dashboard → Vouchers

Reseller sees:
  Username: auto-generated (e.g., vch_john_001)
  Password: auto-generated
  Status: Active
  Remaining: 1GB / 1 Day
  Created: [timestamp]
```

#### 5. End-User Logs in to Hotspot

```
Device connects to WiFi (or LAN via router)

Hotspot Login Prompt:
  Username: [voucher username]
  Password: [voucher password]

Click: Login

Result: Internet works!
```

---

## Common Issues & Fixes

### "Captive portal doesn't show up"

**Check:**
1. **MikroTik hotspot is running:**
   ```powershell
   docker exec <backend> curl -v telnet://192.168.88.1:8080
   # Should connect
   ```

2. **DNS redirect is configured:**
   - Winbox: IP → Hotspot → Profiles → select `safelinks-profile`
   - Check: `dns-name` = `hotspot.local` (not `www.safelinks.name.ng`)

3. **Walled garden includes the portal:**
   - Winbox: IP → Hotspot → Walled Garden
   - Should list: `safelinks.name.ng`, `www.safelinks.name.ng`, `backend-services-production-78d8.up.railway.app`

### "Portal loads but API calls fail"

**Check:**
1. **Backend is running:**
   ```powershell
   docker compose ps backend
   docker compose logs backend --tail 20
   ```

2. **Router can reach backend:**
   ```powershell
   # From router SSH:
   /tool fetch url=http://192.168.88.253:4000/health
   # Should succeed
   ```

3. **Database is healthy:**
   ```powershell
   docker compose logs postgres | Select-String "ready"
   ```

### "Voucher creation fails"

**Check:**
1. **Reseller exists in database:**
   ```powershell
   docker exec <postgres> psql -U SAFELINKS -d SAFELINKS -c "SELECT * FROM resellers LIMIT 1;"
   ```

2. **Reseller has active license:**
   ```powershell
   docker exec <postgres> psql -U SAFELINKS -d SAFELINKS -c "SELECT status, subscription_expiry FROM resellers WHERE id = <reseller_id>;"
   ```

3. **Check backend logs:**
   ```powershell
   docker compose logs backend | Select-String "error|ERROR"
   ```

---

## Next Steps After Testing

### 1. Configure Reseller Portal Settings

```
As Reseller, navigate to:
  Dashboard → Portal Settings

Set:
  - Contact Email: [reseller's email]
  - Contact WhatsApp: [reseller's WhatsApp number]
  - Bank Details: [reseller's bank account]
  - OR USSD Code: [if applicable]

End-users see this info when subscribing
```

### 2. Create Custom Plans

```
As Reseller:
  Dashboard → Plans → Create New Plan

Set:
  - Plan Name: e.g., "5GB Weekly"
  - Data Limit: 5GB
  - Duration: 7 Days
  - Price: [in platform currency]
  - Status: Active

Now available for end-users to purchase
```

### 3. Test Router Agent (Zero-Touch Registration)

```
As Reseller:
  Dashboard → Routers → "Pair a New Router"
  
Copy pairing code shown (6-character, 15-min expiry)

On MikroTik SSH:
  /import file=safelinks-agent.rsc
  /system script run safelinks-register
  (paste pairing code when prompted)

Result: Router auto-registers and appears online
```

---

## Monitoring & Debugging

###Check Router Status

```powershell
# Via Reseller Dashboard:
#  Dashboard → Routers
#  Online/Offline: computed live (last check-in <90s ago)
#  Uptime: % time online since registration

# Via CLI:
docker exec <backend> psql -U SAFELINKS -d SAFELINKS -c "
  SELECT name, last_check_in, online 
  FROM routers 
  LIMIT 5;
"
```

### Check Voucher Usage

```powershell
# Via Reseller Dashboard:
#  Dashboard → Vouchers
#  Data used, time remaining, status

# Via CLI:
docker exec <backend> psql -U SAFELINKS -d SAFELINKS -c "
  SELECT username, status, data_limit, created_at 
  FROM vouchers 
  WHERE reseller_id = <reseller_id>;
"
```

### Check Payment History

```powershell
# Via Super Admin Dashboard:
#  Dashboard → License Payments
#  Shows all reseller license payment requests

# Via Reseller Dashboard:
#  Dashboard → Billing
#  Shows history of paid licenses
```

---

## Data Flow Summary

| Step | Source | API | Destination | Data |
|---|---|---|---|---|
| 1 | End-User Portal | POST /api/portal/:resellerId/signup | Backend DB | name, email, phone, plan, payment ref |
| 2 | Backend | — | DB (pending_activations) | Record created, status="pending" |
| 3 | Reseller Dashboard | GET /api/reseller/pending-activations | Backend | Fetches list |
| 4 | Reseller Dashboard | PUT /api/reseller/pending-activations/:id | Backend | Submits decision="confirmed" |
| 5 | Backend | — | DB (vouchers) | Creates new voucher record |
| 6 | Backend | — | Message queue | Enqueues "create_user" command for router |
| 7 | MikroTik Router | POST /api/router/checkin | Backend | Polls for commands |
| 8 | Backend | Response | Router | Returns "create_user" command |
| 9 | Router | /ip hotspot user add | Router DB | Creates hotspot user with voucher creds |
| 10 | Router | POST /api/router/commands/:id/ack | Backend | Confirms command executed |
| 11 | End-User Device | Login with voucher | Router | Connects hotspot |
| 12 | Router | — | Internet | Routes traffic (if bandwidth allows) |

---

## Production Deployment

**For going live to www.safelinks.name.ng:**

See `DEPLOYMENT.md` (VPS) or `RAILWAY.md` (Railway) in the repo root.

The local Docker stack uses the **same code** — only configuration (domain, certificates, database credentials) differs.

---

## Support & Testing Checklist

- [ ] Backend health endpoint responds: `curl http://localhost:4000/health`
- [ ] Frontend loads: `http://localhost`
- [ ] Super Admin can log in
- [ ] Reseller can log in
- [ ] MikroTik hotspot is configured and running
- [ ] End-user can access portal via browser
- [ ] End-user signup is created
- [ ] Reseller sees pending activation
- [ ] Reseller can confirm payment
- [ ] Voucher is created
- [ ] Router receives voucher
- [ ] End-user can log in with voucher credentials
- [ ] Internet access works after login

---
