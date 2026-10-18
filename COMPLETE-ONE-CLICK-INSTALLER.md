# COMPLETE ONE-CLICK INSTALLER BLUEPRINT

## Vision
**Single executable:** Download → Click → Runs → Configures everything → Done

```
┌──────────────────────────────────────────────────────────────┐
│  SAFE_Links Installer (One-Click, Multi-Platform)           │
│                                                               │
│  1. User downloads installer (Windows .exe or Android .apk)  │
│  2. User clicks to run/install                               │
│  3. Installer launches                                       │
│  4. Auto-starts network scan (LAN detection)                 │
│  5. Finds MikroTik router(s)                                 │
│  6. User selects router (or auto-selects if only one)        │
│  7. User enters 4 pieces of info:                            │
│     - Admin username (default: admin)                        │
│     - Admin password (often blank)                           │
│     - WiFi SSID name (e.g. "Business-WiFi")                 │
│     - WiFi password (8+ chars)                              │
│  8. Clicks "CONFIGURE & DEPLOY"                             │
│  9. Installer does EVERYTHING:                             │
│     ✓ SSH to router                                         │
│     ✓ Configures hotspot                                    │
│     ✓ Sets up walled garden                                 │
│     ✓ Uploads captive portal files                          │
│     ✓ Starts hotspot service                                │
│     ✓ Verifies SSID broadcasting                            │
│     ✓ Tests portal accessibility                            │
│  10. Shows: "✅ READY - Reseller can now accept customers"  │
│  11. Installer minimizes/closes                             │
│  12. Router is LIVE - users can connect and subscribe       │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

---

## Architecture Rewrite

### Layer 1: Installation (OS-specific)

#### Windows (.exe)
- **Tool:** NSIS (Nullsoft Scriptable Install System) or Inno Setup
- **Executable:** `SAFE_Links-Installer-Windows.exe`
- **On run:**
  1. Extract Tauri app to `C:\Program Files\SAFE_Links`
  2. Create Start Menu shortcut
  3. Launch main app
  4. Register URL scheme: `safelinks-installer://`

#### Android (.apk)
- **Tool:** Android Studio / Gradle
- **Executable:** `SAFE_Links-Installer.apk`
- **On install:**
  1. Extract APK to `/data/app/`
  2. Create launcher shortcut
  3. User taps to launch
  4. Handle deep links for OAuth callback

### Layer 2: Main Application (Tauri + React)

**Architecture:**
```
┌─────────────────────────────────────┐
│         Tauri Frontend              │
│  (React SPA - single screen)        │
├─────────────────────────────────────┤
│      Tauri Backend (Rust)           │
│  - Network scanning                 │
│  - SSH/Router automation            │
│  - File operations                  │
│  - System integration               │
├─────────────────────────────────────┤
│      OS APIs (Windows/Android)      │
│  - Network discovery                │
│  - System dialogs                   │
│  - Background services              │
└─────────────────────────────────────┘
```

### Layer 3: Scanning & Discovery

**What happens:**
1. On app launch, immediately:
   - Scan local subnets (192.168.88.0/24, 10.0.0.0/24, 172.16.0.0/12)
   - Discover routers using:
     - TCP port 22 (SSH)
     - TCP port 8291 (Winbox)
     - TCP port 80 (Web UI)
   - Fingerprint: MikroTik, Ubiquiti, TP-Link, etc.

2. Display results (with auto-select if only one):
   - IP address
   - Router type/brand
   - "Ready to configure" status

### Layer 4: Configuration (SSH Automation)

**Inputs from user:**
1. Admin username (default: "admin")
2. Admin password (can be blank)
3. WiFi SSID (e.g. "MyBusiness-WiFi")
4. WiFi password (validated: 8+ chars)

**Actions (all automated):**
1. SSH connect → verify credentials
2. Generate complete .rsc config with user values
3. Upload to `/tmp/` on router
4. Execute `/import file=/tmp/safelinks-configure.rsc`
5. Monitor logs for completion
6. Verify hotspot running
7. Verify SSID broadcasting
8. Verify walled garden rules
9. Test HTTP redirect (curl → check for 302)
10. Return success/failure + diagnostics

### Layer 5: Portal Deployment

**What gets deployed:**
1. Hotspot login.html (replaced with meta-redirect)
2. Walled garden rules (portal + DNS + OAuth + Payment gateways)
3. Firewall rules (QUIC/UDP443, DNS, SSH/Winbox bypass)
4. DHCP server (192.168.88.10-254)
5. NAT masquerading

**No additional files to upload** - all in the .rsc script which RouterOS executes immediately.

---

## UI/UX Flow

### Screen 1: Install & Scan (Auto-displayed on launch)

```
┌──────────────────────────────────────────┐
│  SAFE_Links Installation & Setup         │
├──────────────────────────────────────────┤
│                                          │
│  🔍 Scanning for routers...              │
│                                          │
│  Found:                                  │
│  ⭐ 192.168.88.1 (MikroTik RB750GL)     │
│     Status: Ready to configure          │
│                                          │
│  [SELECT THIS ROUTER]                    │
│  [SCAN AGAIN] [MANUAL IP]                │
│                                          │
└──────────────────────────────────────────┘
```

### Screen 2: Quick Setup (Auto-fills admin/admin)

```
┌──────────────────────────────────────────┐
│  Configure 192.168.88.1                  │
├──────────────────────────────────────────┤
│                                          │
│  Router admin username:                  │
│  [admin                                ] │
│                                          │
│  Router admin password:                  │
│  [                                     ] │
│  (leave blank for factory default)      │
│                                          │
│  WiFi network name (SSID):               │
│  [MyBusiness-WiFi                      ] │
│                                          │
│  WiFi password (8+ characters):          │
│  [SecurePassword123                    ] │
│                                          │
│         [CONFIGURE & DEPLOY]             │
│         [⬅ BACK]                         │
│                                          │
└──────────────────────────────────────────┘
```

### Screen 3: Configuration Running (Progress)

```
┌──────────────────────────────────────────┐
│  Configuring Router                      │
├──────────────────────────────────────────┤
│                                          │
│  ✓ SSH connection established            │
│  ✓ Admin credentials verified            │
│  ✓ Generated configuration                │
│  ⏳ Uploading to router...               │
│  ⏳ Executing configuration...            │
│                                          │
│  [DO NOT CLOSE THIS WINDOW]              │
│                                          │
│  Time remaining: ~1 minute               │
│                                          │
└──────────────────────────────────────────┘
```

### Screen 4: Success

```
┌──────────────────────────────────────────┐
│  ✅ Router Configured!                   │
├──────────────────────────────────────────┤
│                                          │
│  Configuration Complete:                │
│  ✓ Hotspot enabled                      │
│  ✓ WiFi SSID broadcasting               │
│  ✓ Walled garden active                 │
│  ✓ Captive portal ready                 │
│                                          │
│  WiFi Details:                          │
│  SSID: MyBusiness-WiFi                  │
│  IP Range: 192.168.88.10-254            │
│  Portal: https://www.safelinks.name.ng  │
│                                          │
│  🎉 YOUR ROUTER IS LIVE!                 │
│                                          │
│  Next steps:                            │
│  • Go to your dashboard                  │
│  • Create subscription plans              │
│  • Customers can now connect to WiFi     │
│  • Browsers redirect to subscription page │
│  • After payment, customers get internet  │
│                                          │
│        [GO TO DASHBOARD]  [CLOSE]        │
│                                          │
└──────────────────────────────────────────┘
```

---

## Implementation Breakdown

### Phase 1: Rust Backend (Core Logic)

**New modules:**

1. **`network_discovery.rs`**
   - Scan all subnets
   - Fingerprint router types
   - Detect gateway
   - Return ordered list

2. **`router_configurator.rs`**
   - Full SSH pipeline
   - Generate .rsc dynamically
   - Execute import command
   - Monitor completion
   - Verify each step

3. **`portal_deployer.rs`**
   - Upload hotspot files
   - Set firewall rules
   - Configure DHCP
   - Test accessibility

### Phase 2: React Frontend (UX)

**Single-page app:**

1. **`App.jsx`** - Main component
   - State machine: Scanning → Router Selection → Config Input → Running → Success

2. **`NetworkScanner.jsx`** - Shows router list
   - Auto-selects if only one found
   - Manual IP entry option

3. **`ConfigForm.jsx`** - Input form
   - Admin username/password
   - SSID and WiFi password
   - Validation

4. **`ProgressMonitor.jsx`** - Live progress
   - Shows each step as it completes
   - Real-time status updates

5. **`SuccessScreen.jsx`** - Final screen
   - Summary of what was deployed
   - Next steps for reseller
   - Dashboard link

### Phase 3: Packaging

**Windows:**
- Build with Tauri
- Package with NSIS or Inno Setup
- Sign executable (optional but recommended)
- Output: `SAFE_Links-Installer-1.0.0.exe` (~150MB)

**Android:**
- Build with Tauri Mobile
- Package APK
- Sign with release keystore
- Output: `SAFE_Links-Installer-1.0.0.apk` (~80MB)

---

## Key Differences from Current Installer

| Feature | Current | New |
|---------|---------|-----|
| Login Required | ✅ Yes | ❌ No |
| Manual Winbox | ✅ Required | ❌ Eliminated |
| User enters router config manually | ✅ Yes (complex) | ❌ No (.rsc auto-generated) |
| Separate tools needed | ✅ Yes (Winbox) | ❌ No (all built-in) |
| Learning curve | ⚠️ High | ✅ Very Low |
| Setup time | ⚠️ 15-20 mins | ✅ 5 mins |
| Success rate | ⚠️ 70% (user error) | ✅ 95%+ (automated) |
| Supports multiple router types | ✅ Planned | ✅ Yes (MikroTik first) |

---

## Data Flow: Click to Live Router

```
1. USER CLICKS INSTALLER
   ↓
2. INSTALLER LAUNCHES
   ├─ Extract files to device
   ├─ Launch Tauri app
   └─ Start network scan
   ↓
3. NETWORK SCAN
   ├─ ARP scan: 192.168.88.0/24
   ├─ TCP ports: 22, 80, 8291, 443
   ├─ Fingerprint responses
   └─ Display router list
   ↓
4. USER SELECTS ROUTER (or auto-selected)
   ├─ 192.168.88.1 selected
   └─ Show config form
   ↓
5. USER ENTERS 4 VALUES
   ├─ Username: admin
   ├─ Password: [blank]
   ├─ SSID: MyBusiness-WiFi
   └─ WiFi pass: SecurePass123
   ↓
6. USER CLICKS "CONFIGURE & DEPLOY"
   ↓
7. RUST BACKEND EXECUTES
   ├─ SSH test
   ├─ Generate .rsc with user values
   ├─ Upload to router
   ├─ Execute import
   ├─ Monitor logs
   ├─ Verify hotspot
   ├─ Verify SSID
   ├─ Verify walled garden
   ├─ Test portal redirect
   └─ Report success/failure
   ↓
8. FRONTEND SHOWS PROGRESS
   └─ Real-time status updates
   ↓
9. ROUTER IS CONFIGURED
   ├─ Hotspot enabled
   ├─ SSID broadcasting
   ├─ Walled garden active
   ├─ Captive portal ready
   └─ Users can connect
   ↓
10. INSTALLER SHOWS SUCCESS
    ├─ Summary of setup
    ├─ Dashboard link
    └─ Next steps
    ↓
11. USER GOES TO DASHBOARD
    ├─ Create subscription plans
    ├─ Configure payment methods
    └─ Set portal branding
    ↓
12. FIRST CUSTOMER CONNECTS
    ├─ Connects to WiFi
    ├─ Browser opens
    ├─ Automatically redirects to portal
    ├─ Sees subscription page
    ├─ Selects plan
    ├─ Submits payment reference
    ├─ Portal shows "pending activation"
    ↓
13. RESELLER RECEIVES NOTIFICATION
    ├─ Sees pending payment in dashboard
    ├─ Verifies money received
    └─ Clicks "Confirm"
    ↓
14. SYSTEM CREATES VOUCHER
    ├─ Generates random username/password
    ├─ Sends hotspot user creation to router
    ├─ Router creates hotspot user
    └─ Customer receives credentials
    ↓
15. CUSTOMER LOGS IN
    ├─ Hotspot login form appears
    ├─ Customer enters credentials
    ├─ Hotspot grants internet access
    ├─ All traffic flows through router
    └─ Customer USES INTERNET ✅
    ↓
16. MONEY FLOWS
    ├─ Customer paid reseller
    ├─ Reseller paid platform fee (Super Admin)
    ├─ Super Admin dashboard shows revenue
    └─ Reseller dashboard shows earnings ✅
```

---

## Files to Create/Modify

```
BACKEND (Rust):
  ✅ auto_config.rs → KEEP (already created)
  🆕 network_discovery.rs → NEW
  🆕 router_configurator.rs → NEW (enhanced auto_config)
  🆕 portal_deployer.rs → NEW
  🔄 commands.rs → UPDATE (add network_discovery command)
  🔄 lib.rs → UPDATE (register new modules)

FRONTEND (React):
  🆕 src/App.jsx → NEW (main app with state machine)
  🆕 src/components/NetworkScanner.jsx → NEW
  🆕 src/components/ConfigForm.jsx → NEW
  🆕 src/components/ProgressMonitor.jsx → NEW
  🆕 src/components/SuccessScreen.jsx → NEW
  🔄 ui/index.html → REPLACE (React root)

PACKAGING:
  🆕 installer-win.nsi → NEW (NSIS script for Windows)
  🆕 build-windows.sh → NEW (build script)
  🆕 build-android.sh → NEW (build script)

TEMPLATES:
  ✅ safelinks-configure.template.rsc → KEEP
```

---

## Success Criteria

✅ User downloads one file
✅ User clicks one button
✅ No manual typing of commands
✅ No need for Winbox or SSH client
✅ Works on Windows AND Android
✅ Router is fully configured and live
✅ Customers can connect and subscribe
✅ Money flows correctly through system
✅ Reseller can manage everything from dashboard

---
