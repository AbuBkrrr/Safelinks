# LOCAL TEST SETUP FOR MIKROTIK HOTSPOT INTEGRATION

**PRODUCTION SAFETY:** www.safelinks.name.ng is LIVE on Railway.app. This guide is for LOCAL ONLY testing. The web stack runs in isolated Docker containers on your PC (192.168.88.253) and does NOT affect production.

---

## Architecture

```
Your PC (192.168.88.253)
├── Docker: Postgres + Backend + Frontend + Caddy (all on localhost:80/443)
│
└── MikroTik Router (192.168.88.1) — connected via Ethernet
    ├── No hotspot configured yet
    └── Will receive .rsc script to configure hotspot + walled garden
```

---

## Prerequisites

- ✅ Docker Desktop (already installed, verified)
- ✅ MikroTik router on same LAN (192.168.88.1)
- ✅ Backend code (Node.js, no Prisma — hand-rolled `pg` driver)
- ✅ Frontend (React/Vite)

---

## Step 1: Verify Network Connectivity

```powershell
# Check PC is on 192.168.88.0/24 network
ipconfig /all

# Ping router
ping 192.168.88.1
# Should see: Reply from 192.168.88.1: bytes=32 time<1ms TTL=64

# Verify no production containers running
docker ps --format "table {{.Names}}\t{{.Ports}}" | Select-String "80\|443"
# Should show: (empty or only local dev containers)
```

---

## Step 2: Start Local Test Stack

```powershell
cd C:\Users\DELL\Downloads\safe-links-updated\web

# Verify .env exists and has dev values
Get-Content .env

# Start the stack (Postgres + Backend + Frontend + Caddy)
docker compose up -d

# Wait 30 seconds for services to start, then verify
Start-Sleep -Seconds 30
docker compose ps

# Expected output:
#   web-postgres-1    running  (healthy after ~10s)
#   web-backend-1     running  (after Postgres healthy)
#   web-frontend-1    running
#   web-caddy-1       running
```

---

## Step 3: Verify Backend is Running

```powershell
# Check backend logs for schema creation
docker compose logs backend --tail 20

# Expected: "migrations complete" or similar DB init messages

# Test health endpoint
curl http://localhost:4000/health
# Expected: {"ok":true,"service":"safe-links-backend"}

# Test Postgres connection
$dbUrl = "postgres://SAFELINKS:SafeLinks_Dev_Pass_2026@localhost:5432/SAFELINKS"
# Can test with: psql $dbUrl -c "SELECT 1"
# Or via docker: docker exec web-postgres-1 psql -U SAFELINKS -d SAFELINKS -c "SELECT 1"
```

---

## Step 4: Verify Frontend is Running

```powershell
# Test frontend (served by nginx behind Caddy)
curl http://localhost:80
# Should return HTML of the login page (no error 500/502)

# Open in browser
Start-Process http://localhost

# Expected: SAFE_Links login/signup page loads
#   - Can see "Log in as Super Admin" or signup form
#   - No console errors in browser DevTools
```

---

## Step 5: Access the System

### As Super Admin

```
Email:    admin@SAFELINKS.io
Password: admin123
```

- Dashboard → Settings: review contact email/WhatsApp and bank details
- Dashboard → Installations: see router list (empty at start)

### As Reseller

```
Email:    admin@nairobitech.io
Password: reseller123
```

- Dashboard → Routers: create a new router or pair one
- Dashboard → Plans: view available plans to sell to end-users

### As End-User (via Captive Portal)

Once a router has hotspot configured, end-users will see:
```
http://192.168.88.1:8080/login → redirects to http://localhost/login
```

---

## Step 6: Prepare MikroTik for Hotspot

**GOAL:** The router broadcasts WiFi; any client opening a browser gets redirected to the SAFE_Links portal to subscribe.

### Option A: Manual SSH (Advanced)

```bash
# From your PC, SSH to router
ssh admin@192.168.88.1
# Default password is usually blank or "admin"

# Once logged in, import the configure script
# (script is at: C:\Users\DELL\Downloads\safe-links-updated\installer\src-tauri\resources\safelinks-configure.rsc)

# To import:
/import file=safelinks-configure.rsc
```

### Option B: Use Winbox (Easiest)

1. Download Winbox from mikrotik.com (Windows app)
2. Connect: IP=192.168.88.1
3. Files → Upload `safelinks-configure.rsc`
4. New Terminal → `/import file=safelinks-configure.rsc`

---

## Step 7: Test Hotspot Flow

Once router is configured:

```powershell
# From a separate device on the router's WiFi, open a browser and go to:
http://google.com
# Expected: redirected to http://192.168.88.1:8080/login → portal

# Or directly:
http://192.168.88.1:8080/login
```

---

## Step 8: Test Portal Signup → Voucher Flow

1. **End-user opens portal:** signs up with name, email, phone
2. **Portal shows bank transfer details** (reseller's bank info from portal-settings)
3. **End-user submits reference number** (simulate a bank payment)
4. **Pending activation created** in Reseller dashboard
5. **Reseller confirms** the payment → voucher issued
6. **Reseller views vouchers** with username/password to give customer
7. **Customer logs into hotspot** with voucher → internet works

---

## Troubleshooting

### "Connection refused" at localhost:80

```powershell
# Caddy may not have started. Check:
docker compose logs caddy --tail 20

# Restart Caddy:
docker compose restart caddy

# Wait 5 seconds, then retry:
Start-Sleep -Seconds 5
curl http://localhost
```

### Backend logs show "Prisma schema validation" error

This is a cached old image. Clean and rebuild:

```powershell
cd C:\Users\DELL\Downloads\safe-links-updated\web
docker compose down --remove-orphans
docker system prune -f --volumes
docker compose up -d --build
```

### "VITE_API_URL" errors in browser console

The frontend build already has `VITE_API_URL` set to `http://localhost:4000`. If wrong, rebuild:

```powershell
docker compose up -d --build frontend
```

### MikroTik can't reach backend

Check firewall — port 4000 must be accessible from router's LAN:

```powershell
# From router SSH:
/tool fetch url=http://192.168.88.253:4000/health
# Should show: "ok: true"
```

---

## Cleanup / Stop Everything

```powershell
cd C:\Users\DELL\Downloads\safe-links-updated\web
docker compose down

# If you want to reset database:
docker volume rm web_SAFELINKS_pgdata
```

---

## What to Test

- [ ] Super Admin login works
- [ ] Reseller login works
- [ ] Reseller can create a router (manual entry or pairing code)
- [ ] Router appears online/offline correctly in dashboard
- [ ] Reseller can create a plan
- [ ] Reseller can view plans to sell
- [ ] End-user can sign up via portal
- [ ] Reseller sees pending activation
- [ ] Reseller confirms → voucher created
- [ ] Voucher appears in Reseller's vouchers list
- [ ] MikroTik hotspot page redirects to portal
- [ ] End-user hotspot login with voucher credentials works

---

## Next: Router Agent Testing

Once hotspot is live, you can test the zero-touch pairing flow:

1. Reseller generates pairing code: Dashboard → Routers → "Pair a new router"
2. Router SSH: `/import file=safelinks-agent.rsc`
3. Edit pairing code in script, run once: `/system script run safelinks-register`
4. Router should auto-register and enable check-in scheduler
5. Reseller should see router go online in Routers tab

(Tested end-to-end against a real Postgres backend — see backend README.)

---

## DO NOT TOUCH

- ❌ `https://www.safelinks.name.ng` (production on Railway)
- ❌ Railway project settings
- ❌ Production Postgres credentials
- ✅ Only use local Docker compose in this folder

---
