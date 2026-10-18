# INSTALLER REBUILD: Fully Automatic Configuration

**GOAL:** Reseller enters ONLY: username, password, SSID, WiFi password → Installer does EVERYTHING else

**CURRENT FLOW:**
1. Scan LAN → Find router
2. Open modal → user enters admin creds, SSID, WiFi password
3. User clicks "Save setup file" OR "Apply configuration"
4. If "Save setup file" → Reseller imports via Winbox manually
5. If "Apply configuration" → SSH to router, run commands

**NEW FLOW (FULLY AUTOMATIC):**
1. Scan LAN → Find router (SAME)
2. User enters ONLY: admin username, admin password, SSID, WiFi password (SIMPLIFIED FORM)
3. Click "Configure Router" (ONE BUTTON)
4. Installer automatically:
   - Test SSH connection ✓
   - Generate entire safelinks-configure.rsc from template ✓
   - Upload .rsc file to router ✓
   - Execute /import command ✓
   - Verify hotspot is configured ✓
   - Verify walled garden is set up ✓
   - Test that router broadcasts the SSID ✓
   - Show success with next steps ✓

---

## Implementation Plan

### 1. Simplify the Configuration Form

**File:** `installer/ui/index.html` (Modal section)

**REMOVE:**
- "Router readiness" panel section
- "Check status" button
- "Repair missing items" button  
- "Save setup file" button (Option B is gone)

**KEEP:**
- Router IP, admin username, admin password
- SSID field
- WiFi password field
- ONE button: "Configure Router" (replaces "Apply configuration")

### 2. Create Automatic Configuration Logic

**New file:** `installer/src-tauri/src/auto_config.rs`

Implements the core logic:
```rust
pub async fn full_auto_config(
    ip: &str,
    admin_user: &str,
    admin_pass: &str,
    ssid: &str,
    wifi_pass: &str,
) -> Result<ConfigResult, String>
```

Steps:
1. **SSH test** → verify connectivity
2. **Download current config** → backup `/etc/config/network` (for OpenWrt) or read hotspot profile (MikroTik)
3. **Verify prerequisites** → check RouterOS version, required packages
4. **Generate .rsc** → from template with user values (SSID, WiFi password)
5. **Upload .rsc** → via SFTP or SCP
6. **Execute import** → `/import file=safelinks-configure.rsc`
7. **Wait for completion** → poll for "configuration complete" log entry
8. **Verify hotspot** → check `/ip hotspot` exists and is running
9. **Verify SSID broadcast** → check wireless interface has correct SSID
10. **Verify walled garden** → check `/ip hotspot walled-garden` rules exist
11. **Return success** → with final status

### 3. Generate .rsc File Dynamically

**New file:** `installer/src-tauri/resources/safelinks-configure.template.rsc`

Template with placeholders:
```routeros
:set slSsid "{{SSID}}"
:set slWifiPass "{{WIFI_PASSWORD}}"
# ... rest of script unchanged
```

**Rust code** replaces:
- `{{SSID}}` → from user input
- `{{WIFI_PASSWORD}}` → from user input
- `{{API_URL}}` → hardcoded to production backend

### 4. Enhanced Router SSH Commands

**File:** `installer/src-tauri/src/router.rs` (NEW FUNCTIONS)

```rust
/// Verify the configuration succeeded
pub async fn verify_hotspot_configured(ssh: &SshSession) -> Result<bool, String>

/// Wait for the import to complete by watching logs
pub async fn wait_for_import_complete(ssh: &SshSession, timeout_secs: u64) -> Result<(), String>

/// Check that SSID is broadcasting
pub async fn verify_ssid_broadcasting(ssh: &SshSession, ssid: &str) -> Result<bool, String>

/// Check that walled garden rules are in place
pub async fn verify_walled_garden(ssh: &SshSession) -> Result<bool, String>
```

### 5. Update Main Command Handler

**File:** `installer/src-tauri/src/commands.rs`

**Add function:**
```rust
#[tauri::command]
pub async fn installer_auto_configure(
    ip: String,
    user: String,
    password: String,
    ssid: String,
    wifi_password: String,
) -> Result<AutoConfigResult, String>
```

This calls `auto_config::full_auto_config()` and returns:
```rust
pub struct AutoConfigResult {
    pub ok: bool,
    pub message: String,
    pub steps_completed: Vec<String>,
    pub steps_failed: Vec<String>,
    pub next_steps: Vec<String>,
    pub final_status: String,
}
```

### 6. Update UI Handler

**File:** `installer/ui/index.html` (JavaScript)

Replace:
```javascript
document.getElementById('cfg-apply').onclick = async function() {
  // OLD: "Save setup file" or partial "Apply configuration"
}
```

With:
```javascript
document.getElementById('cfg-apply').onclick = async function() {
  var ip = document.getElementById('cfg-ip').textContent;
  var user = document.getElementById('cfg-user').value || 'admin';
  var pass = document.getElementById('cfg-pass').value;
  var ssid = document.getElementById('cfg-ssid').value.trim();
  var wifiPassword = document.getElementById('cfg-wifi-pass').value;

  if (!ip) return;
  if (!ssid) { cfgSetStatus('SSID is required', '#fc8181'); return; }
  if (wifiPassword.length < 8) { cfgSetStatus('WiFi password must be at least 8 characters', '#fc8181'); return; }

  var btn = this;
  btn.disabled = true;
  cfgSetStatus('🔄 Configuring router…\nThis will take 60-90 seconds.\n\nPlease DO NOT close this window.', '#fbbf24');

  try {
    var result = await invoke('installer_auto_configure', {
      ip: ip,
      user: user,
      password: pass,
      ssid: ssid,
      wifi_password: wifiPassword
    });

    if (result.ok) {
      var msg = '✅ SUCCESS!\n\n';
      msg += 'Configuration applied:\n' + result.steps_completed.map(s => '  ✓ ' + s).join('\n');
      msg += '\n\nNext steps:\n' + result.next_steps.map(s => '  • ' + s).join('\n');
      cfgSetStatus(msg, '#22c55e');
    } else {
      var msg = '⚠ PARTIAL SUCCESS\n\n';
      msg += 'Completed:\n' + result.steps_completed.map(s => '  ✓ ' + s).join('\n');
      if (result.steps_failed.length) {
        msg += '\n\nFailed:\n' + result.steps_failed.map(s => '  ✕ ' + s).join('\n');
      }
      msg += '\n\n' + result.final_status;
      cfgSetStatus(msg, '#fbbf24');
    }
  } catch (e) {
    cfgSetStatus('❌ ERROR\n\n' + e, '#fc8181');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Configure Router';
  }
};
```

### 7. Simplify Modal HTML

**File:** `installer/ui/index.html` (Modal HTML)

**Remove:**
```html
<div id="cfg-readiness" class="readiness-panel" ...>
  <!-- REMOVE entire readiness panel -->
</div>
```

**Simplify button row:**
```html
<div class="btn-row">
  <button id="cfg-apply" class="success" style="flex:1;">Configure Router</button>
</div>
```

---

## File Changes Summary

| File | Change | Purpose |
|------|--------|---------|
| `installer/ui/index.html` | Remove readiness panel, simplify form, update button handler | Simplified UI |
| `installer/src-tauri/src/commands.rs` | Add `installer_auto_configure` | Entry point for auto config |
| `installer/src-tauri/src/auto_config.rs` | NEW: Full automation logic | Core logic: SSH → config → verify |
| `installer/src-tauri/src/router.rs` | Add verification functions | Check that config succeeded |
| `installer/src-tauri/src/lib.rs` | Register new module `mod auto_config` | Module registration |
| `installer/src-tauri/resources/safelinks-configure.template.rsc` | Template with `{{SSID}}`, `{{WIFI_PASSWORD}}` | Dynamic .rsc generation |

---

## User Experience After Rebuild

```
1. Installer opens
   ↓
2. Reseller signs in
   ↓
3. Clicks "Scan LAN"
   ↓ (finds router at 192.168.88.1)
   ↓
4. Clicks "Configure" on router row
   ↓
5. Modal opens - Reseller fills:
   - Admin username: admin
   - Admin password: [blank]
   - WiFi SSID: MyBusiness-WiFi
   - WiFi password: SecurePass123
   ↓
6. Clicks "Configure Router"
   ↓ (ONE CLICK - that's it!)
   ↓
7. Installer shows progress:
   ✓ SSH connected
   ✓ Generated configuration
   ✓ Uploaded to router
   ✓ Imported into RouterOS
   ✓ Hotspot verified as running
   ✓ SSID verified broadcasting
   ✓ Walled garden verified
   ✓ SUCCESS!
   
   Next steps:
   • End-users can now connect to WiFi
   • Browsers will redirect to portal
   • Reseller can manage vouchers from dashboard
   ↓
8. Reseller closes installer
   Done!
```

---

## Testing Checklist

- [ ] Compiles without errors
- [ ] SSH connection test works
- [ ] .rsc template renders with correct SSID and WiFi password
- [ ] File upload to router succeeds
- [ ] /import command executes
- [ ] Hotspot verification detects configured hotspot
- [ ] SSID broadcast check works
- [ ] Walled garden rules verification passes
- [ ] UI shows success message with next steps
- [ ] End-user can connect to WiFi and see captive portal
- [ ] Reseller can confirm payment and create vouchers
- [ ] Voucher login to hotspot works

---

## Implementation Priority

1. **Phase 1 (CRITICAL):** `auto_config.rs` main logic + template generation
2. **Phase 2 (HIGH):** `router.rs` verification functions
3. **Phase 3 (HIGH):** UI simplification + button handler update
4. **Phase 4 (MEDIUM):** Error handling + timeout logic
5. **Phase 5 (POLISH):** Progress messages + logging

---

## Code Skeleton - auto_config.rs

```rust
use crate::router;
use crate::ssh::SshSession;
use serde::Serialize;

#[derive(Serialize)]
pub struct AutoConfigResult {
    pub ok: bool,
    pub message: String,
    pub steps_completed: Vec<String>,
    pub steps_failed: Vec<String>,
    pub next_steps: Vec<String>,
    pub final_status: String,
}

pub async fn full_auto_config(
    ip: &str,
    admin_user: &str,
    admin_pass: &str,
    ssid: &str,
    wifi_pass: &str,
) -> Result<AutoConfigResult, String> {
    let mut result = AutoConfigResult {
        ok: true,
        message: String::new(),
        steps_completed: vec![],
        steps_failed: vec![],
        next_steps: vec![],
        final_status: String::new(),
    };

    // Step 1: SSH test
    let ssh = match router::test_ssh(ip, admin_user, admin_pass).await {
        Ok(session) => {
            result.steps_completed.push("SSH connected".to_string());
            session
        }
        Err(e) => {
            result.ok = false;
            result.steps_failed.push(format!("SSH connection failed: {}", e));
            result.final_status = "Could not connect to router".to_string();
            return Ok(result);
        }
    };

    // Step 2-10: ... (implementation in subsequent phases)

    result.next_steps = vec![
        "End-users can now connect to the WiFi".to_string(),
        "Browsers will redirect to the captive portal".to_string(),
        "Go to your dashboard to create plans and manage vouchers".to_string(),
    ];

    result.final_status = if result.ok {
        "Configuration complete! Router is ready to accept end-users.".to_string()
    } else {
        "Some steps failed. Check the errors above and try again.".to_string()
    };

    Ok(result)
}
```

---
