# TESTING CHECKLIST - SAFE_LINKS SYSTEM

## Pre-Testing Setup ✅

- [x] Docker stack running
  ```
  docker ps
  # Should show: frontend (80), backend (4000), postgres (5432) all UP
  ```

- [x] Backend responding
  ```
  curl http://localhost:4000/health
  # Should return: {"ok":true,"service":"safelinks-backend"}
  ```

- [x] Frontend loads
  ```
  Open: http://localhost
  # Should see: SAFE_Links login page
  ```

- [x] Installer built
  ```
  File: safelinks-installer.exe (11.7 MB)
  Location: installer/src-tauri/target/release/
  Status: Ready to run
  ```

---

## PHASE 1: Portal Testing (Browser)

### Test 1A: Voucher Redemption
- [ ] Open http://localhost/portal/r_8841
- [ ] See: "Connected to SAFE_Links_WiFi"
- [ ] Click: "Already have a voucher?"
- [ ] Enter: v-6mq54999
- [ ] Click: "Connect" button
- [ ] Verify: ✅ Connected! (checkmark icon)
- [ ] Watch: 30-second countdown starts
- [ ] After 30s: "Start Browsing" button appears (active)
- [ ] Result: No errors, smooth flow

### Test 1B: QR Code Scanning
- [ ] Go to: http://localhost (dashboard)
- [ ] Login: admin@nairobitech.io / reseller123
- [ ] Vouchers tab → "Download QR Codes"
- [ ] On phone: Open camera → scan QR
- [ ] Phone: Portal loads and auto-enters code
- [ ] Verify: Same flow as Test 1A works
- [ ] Result: QR scanner works

### Test 1C: Bank Transfer Flow
- [ ] Portal: Click "Subscribe Now"
- [ ] Select: Any plan (e.g., "Weekly Standard")
- [ ] Fill: Name, Email, Phone, optional Business
- [ ] Select: "Bank Transfer"
- [ ] Enter: Reference number (e.g., TEST123)
- [ ] Click: "Submit Payment"
- [ ] Verify: Redirects to waiting screen with clock icon
- [ ] Message: "Waiting for reseller to verify..."
- [ ] Keep tab open

### Test 1D: Reseller Confirms Bank Transfer
- [ ] New tab: http://localhost (dashboard)
- [ ] Login: admin@nairobitech.io / reseller123
- [ ] Go to: "Pending Payments" tab
- [ ] See: Notification with customer name + plan + amount
- [ ] Click: "Confirm" button
- [ ] Verify: Toast notification "Payment confirmed"
- [ ] Back to Test 1C tab:
  - [ ] Portal shows: ✅ Connected! screen
  - [ ] Shows countdown + Start Browsing button
- [ ] Result: Full manual flow works

### Test 1E: Card/USSD Payment (Instant)
- [ ] Portal: Click "Subscribe Now"
- [ ] Select: Any plan
- [ ] Fill: Customer details
- [ ] Select: "Card" or "USSD"
- [ ] Click: "Proceed to Payment"
- [ ] Redirects: To Flutterwave/Paystack (test mode)
- [ ] In test dashboard: Mark payment successful
- [ ] Portal redirects back with: ✅ Connected!
- [ ] Countdown: Should be at ~0s or completed
- [ ] Result: Instant payment works (no reseller confirmation needed)

---

## PHASE 2: Dashboard Testing

### Test 2A: Voucher Expiry Countdown
- [ ] Dashboard: http://localhost
- [ ] Login: admin@nairobitech.io / reseller123
- [ ] Go to: "Vouchers" tab
- [ ] Look for: "EXPIRES" column
- [ ] Verify you see:
  - [ ] Clock icon 🕐
  - [ ] Time remaining (e.g., "5d", "2h", "15m", "30s")
  - [ ] Date below in smaller text
- [ ] Watch: Countdown decreases every 1 second
  - [ ] 5d → 4d 23h 59m → ... (live update)
- [ ] Colors:
  - [ ] Green/Primary: Active voucher
  - [ ] Red: Expired
- [ ] Result: Countdown is live and accurate

### Test 2B: Active Sessions Countdown
- [ ] Dashboard: http://localhost
- [ ] Login: admin@nairobitech.io / reseller123
- [ ] Go to: "Clients" tab → "Active sessions"
- [ ] If NO devices connected:
  - [ ] See: "No devices connected right now"
  - [ ] (Connect a device first - see Test 3)
- [ ] If devices ARE connected, verify:
  - [ ] Device name + MAC + IP shown
  - [ ] On right side: Clock icon + countdown (e.g., "🕐 3h")
  - [ ] Countdown updates every 1 second
- [ ] When < 5 minutes to expiry:
  - [ ] Row background turns yellow (warning)
  - [ ] Time text turns warning color
- [ ] Result: Session countdown is live and accurate

### Test 2C: Dashboard Responsiveness
- [ ] Resize browser window to mobile (375px)
- [ ] Verify:
  - [ ] Counters still visible
  - [ ] Clock icon still showing
  - [ ] Text is readable (no overflow)
  - [ ] Colors are distinct (accessible)
- [ ] On tablet (768px):
  - [ ] Tables are scrollable
  - [ ] Layout is clean
  - [ ] No broken elements
- [ ] Result: Responsive design works

---

## PHASE 3: Desktop Installer Testing

### Test 3A: Installer Launches
- [ ] Double-click: safelinks-installer.exe
- [ ] Verify: Windows window opens (Tauri app)
- [ ] No errors in console
- [ ] UI loads: Login screen visible
- [ ] Result: App starts without errors

### Test 3B: Installer Login
- [ ] Email: admin@nairobitech.io
- [ ] Password: reseller123
- [ ] Click: "Sign In"
- [ ] Verify: Login succeeds
- [ ] Next screen: Router scan or dashboard
- [ ] Result: Authentication works

### Test 3C: Network Scan
- [ ] Click: "Scan Network" or "Start"
- [ ] Watch: App scans LAN (spinning loader)
- [ ] Takes ~30 seconds
- [ ] Results show:
  - [ ] IP addresses found
  - [ ] Ports detected (22, 8291, 80)
  - [ ] Router brand detected (MikroTik, Ubiquiti, etc.)
- [ ] Find your MikroTik:
  - [ ] IP: 192.168.88.1 (or your IP)
  - [ ] Status: "mikrotik" or "router"
  - [ ] Ports: 22 and/or 8291
- [ ] Result: Scanner found your router

### Test 3D: Router Selection & Configuration
- [ ] Click: Select your MikroTik from list
- [ ] Form appears asking for:
  - [ ] Admin username
  - [ ] Admin password
  - [ ] WiFi SSID (name)
  - [ ] WiFi password
- [ ] Fill in your credentials
- [ ] Click: "Configure" button
- [ ] Watch progress:
  - [ ] "Connecting to router..."
  - [ ] "Uploading configuration..."
  - [ ] "Verifying hotspot..."
  - [ ] "Starting polling agent..."
- [ ] Final result: "✅ Configuration Complete!"
- [ ] Result: Full provisioning works

### Test 3E: Configuration Verification
- [ ] On your MikroTik:
  - [ ] Verify hotspot is created
  - [ ] Check SSID is broadcasting (the one you set)
  - [ ] Verify DHCP client on WAN
- [ ] From phone/laptop:
  - [ ] Connect to the WiFi hotspot
  - [ ] Verify: Captive portal redirect works
  - [ ] Portal URL: Should contain reseller ID
- [ ] Result: Router is fully configured

---

## PHASE 4: End-to-End Test (Live Internet)

### Test 4A: Device Connects to WiFi
- [ ] On phone/tablet: Find WiFi network (SSID you set)
- [ ] Connect to network
- [ ] Enter WiFi password
- [ ] Verify: Connected ✓

### Test 4B: Captive Portal Redirect
- [ ] Open browser on device
- [ ] Try to visit any website (e.g., google.com)
- [ ] Verify: Redirected to captive portal
- [ ] Portal shows:
  - [ ] Reseller branding (logo, colors)
  - [ ] WiFi SSID displayed
  - [ ] "Already have a voucher?" OR "Subscribe" buttons
- [ ] Result: Captive portal redirect works

### Test 4C: Get Internet Access
- [ ] On device: Redeem a voucher OR subscribe
- [ ] Follow portal flow
- [ ] See: ✅ Connected! screen
- [ ] After 30s wait: Click "Start Browsing"
- [ ] On phone: Browser now works
- [ ] Try: Open google.com
- [ ] Verify: Loads successfully ✓
- [ ] Result: Internet access granted!

### Test 4D: Monitor on Dashboard
- [ ] While device is connected:
  - [ ] Open dashboard on PC/laptop
  - [ ] Go to "Clients" → "Active sessions"
  - [ ] See your phone device listed:
    - [ ] MAC address
    - [ ] IP address
    - [ ] Connected time
    - [ ] 🕐 Expiry countdown (live)
  - [ ] Watch countdown tick down every second
  - [ ] If < 5 min: Row turns yellow
- [ ] Result: Dashboard monitoring works

---

## FAILURE SCENARIOS (What to Check If Something Breaks)

### If Portal Doesn't Load
```
[ ] Check: Backend running
    docker ps | grep backend
    
[ ] Check: API responding
    curl http://localhost:4000/health
    
[ ] Check: Browser console (F12)
    Look for: Red errors
    
[ ] Fix: docker compose restart
```

### If Countdown Doesn't Update
```
[ ] Check: Browser isn't frozen
    Try: Refresh page (Ctrl+R)
    
[ ] Check: JavaScript enabled
    Settings > JavaScript toggle
    
[ ] Check: Console errors (F12)
    
[ ] Fix: Close and reopen browser
```

### If Installer Won't Connect
```
[ ] Check: MikroTik is powered on
    Try: Ping 192.168.88.1
    
[ ] Check: SSH enabled on router
    Winbox > System > Services > SSH
    
[ ] Check: Credentials correct
    Test manually: ssh admin@192.168.88.1
    
[ ] Check: Firewall blocking
    Windows Defender > Virus settings
```

### If Device Won't Get Internet
```
[ ] Check: 30 seconds passed
    Wait full countdown before testing
    
[ ] Check: Router is online
    Dashboard > Routers > Status
    
[ ] Check: Command was queued
    Dashboard > Routers > Pending commands
    
[ ] Check: MikroTik hotspot running
    /ip hotspot print (in MikroTik terminal)
```

---

## SUCCESS CHECKLIST (All Tests Passing)

- [ ] ✅ Portal loads
- [ ] ✅ Voucher redeem works
- [ ] ✅ QR code scanner works
- [ ] ✅ Bank transfer flow works
- [ ] ✅ Card payment works (instant)
- [ ] ✅ Countdown timers live (every 1s)
- [ ] ✅ Active sessions show countdown
- [ ] ✅ Dashboard responsive (mobile/tablet)
- [ ] ✅ Installer launches
- [ ] ✅ Installer scans network
- [ ] ✅ Installer configures router
- [ ] ✅ MikroTik hotspot online
- [ ] ✅ Device connects to WiFi
- [ ] ✅ Captive portal redirects
- [ ] ✅ Device gets internet access
- [ ] ✅ Dashboard shows active session
- [ ] ✅ Countdown accurate

---

## FINAL SIGN-OFF

When ALL tests pass:

**System is production-ready** ✅

- No breaking changes
- All features working
- Live countdown timers
- Instant payments
- Device monitoring
- Router provisioning
- End-to-end verified

Ready to deploy to production!
