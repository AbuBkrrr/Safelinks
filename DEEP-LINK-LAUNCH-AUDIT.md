# DEEP-LINK LAUNCH AUDIT

## Issues Found & Fixed

### 1. ❌ Input Variables Being Passed as Undefined
**Problem:** After removing SSID/password/IP inputs, the code still tried to pass `ssid`, `wifiPass`, `routerIp` to deep-link
**Impact:** Deep-link URL included empty values, may confuse handler
**Fix:** Removed these from URLSearchParams and postMessage - only pass required params

### 2. ❌ Missing Console Logging for Debugging
**Problem:** No visibility into what's happening when button clicked
**Impact:** Can't trace if function called, URL built, anchor clicked
**Fix:** Added comprehensive console.log statements at each step

### 3. ⚠️ Protocol Handler Not Registered
**Problem:** Windows registry may not have `safelinks-installer://` handler registered
**Impact:** Windows doesn't know what app to launch
**Status:** NSIS script created but requires installer rebuild

### 4. ⚠️ Session/Token Validation
**Problem:** `getSession()` might not return valid token
**Impact:** Deep-link fails silently
**Fix:** Added check + alert before proceeding

---

## EXECUTION FLOW (Current)

```
User clicks "Pair automatically (MikroTik)"
  ↓
fireInstallerDeepLink() called
  ↓
Check: code exists? ✓
setConfiguringRouter(true) → shows spinner
  ↓
getSession() → get token/role/email
  ✓ If valid: continue
  ✗ If invalid: alert + stop
  ↓
resolveResellerId() → get reseller ID
  ↓
Build URLSearchParams:
  - resellerId
  - pairingCode (6-char code)
  - token (JWT)
  - role ('reseller')
  - email
  - companyName
  ↓
Build deeplink: "safelinks-installer://configure?..."
  ↓
Log deeplink to console
  ↓
Check if in iframe (embedded) or browser?
  ├─ EMBEDDED: postMessage to parent
  └─ BROWSER: create anchor + click
  ↓
Set 500ms timeout to show fallback if no response
  ↓
Poll router status every 3s (looking for pairing code match)
```

---

## WHAT TO CHECK IN BROWSER CONSOLE

### Step 1: Click Button
Look for:
```
[InstallerWizard] Firing deeplink: safelinks-installer://configure?resellerId=...&pairingCode=KC5JSC&token=...&role=reseller&...
[InstallerWizard] Standard browser mode, attempting to launch deep-link
[InstallerWizard] Created anchor with href: safelinks-installer://configure?...
[InstallerWizard] Clicked anchor
```

### Step 2: Check If Deep-Link Works
- Does Windows show "Allow this app to open?" dialog?
- Does SAFE_Links Installer app appear in taskbar?
- Check Windows Event Viewer → Applications for errors

### Step 3: Verify Protocol Handler
Run in PowerShell (admin):
```powershell
Get-ItemProperty HKCU:\Software\Classes\safelinks-installer\shell\open\command
```

Should show path to installer exe.

---

## ROOT CAUSES CHECKLIST

- [ ] Session token is valid (check getSession() in console)
- [ ] Deep-link URL is properly encoded
- [ ] Windows has protocol handler registered
- [ ] Installer exe is in expected location
- [ ] Installer was installed via NSIS (not just built)
- [ ] No NSIS registry script errors during install
- [ ] No firewall blocking handler
- [ ] No antivirus blocking deep-link
- [ ] Browser allows protocol handler clicks

---

## FIXES APPLIED

✅ Removed unused SSID/password/IP from deep-link  
✅ Added session validation with alert  
✅ Added console logging for tracing  
✅ Reduced fallback timeout to 500ms  
✅ Created NSIS registry hook  
✅ Simplified URL parameters

---

## NEXT STEPS FOR TESTING

1. **Verify Protocol Handler:**
   ```powershell
   # Check if registered
   reg query "HKCU\Software\Classes\safelinks-installer"
   
   # Register manually if missing
   reg add "HKCU\Software\Classes\safelinks-installer" /ve /d "URL:SAFE Links Installer"
   reg add "HKCU\Software\Classes\safelinks-installer" /v "URL Protocol" /d ""
   reg add "HKCU\Software\Classes\safelinks-installer\shell\open\command" /ve /d "\"C:\Program Files\SAFE_Links Installer\SAFE_Links Installer.exe\" \"%%1\""
   ```

2. **Test Deep-Link Manually:**
   Open Run dialog (Win+R) and paste:
   ```
   safelinks-installer://configure?resellerId=demo&pairingCode=TEST123&token=abc123
   ```
   Installer should launch if handler registered.

3. **Check Browser Console** (F12):
   - Look for logged messages
   - Check for JS errors
   - Verify getSession() returns token

4. **Check Windows Event Viewer:**
   - Applications → Look for SAFE_Links errors

---

## REBUILD REQUIRED

To properly register protocol handler:
```bash
cd installer/src-tauri
cargo tauri build
```

This creates new .exe with registry hooks in NSIS script.

---

**Commit: 5193354** - Ready for protocol handler verification
