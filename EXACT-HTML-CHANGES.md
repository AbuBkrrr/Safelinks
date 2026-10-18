# EXACT HTML/JS CHANGES NEEDED

## File: `installer/ui/index.html`

### Change 1: Remove Readiness Panel HTML

**FIND THIS SECTION (lines ~750-800 in the modal):**
```html
    <div id="cfg-readiness" class="readiness-panel" style="display:none;">
      <div class="title">Router readiness</div>
      <div id="cfg-overall" class="overall"></div>
      <div id="cfg-checks"></div>
      <div class="btn-row">
        <button id="cfg-check" class="secondary">Check status</button>
        <button id="cfg-repair" class="secondary" style="display:none;">Repair missing items</button>
      </div>
    </div>
```

**DELETE THE ENTIRE SECTION** (all 10 lines)

---

### Change 2: Simplify Button Row

**FIND THIS:**
```html
    <div class="btn-row">
      <button id="cfg-test" class="secondary">Test SSH</button>
      <button id="cfg-apply" class="success">Save setup file</button>
    </div>
```

**REPLACE WITH:**
```html
    <div class="btn-row">
      <button id="cfg-apply" class="success" style="flex:1;">Configure Router</button>
    </div>
```

---

### Change 3: Remove Old JavaScript Handlers

**FIND THIS SECTION (lines ~950+):**
```javascript
document.getElementById('cfg-test').onclick = async function() {
  var ip = document.getElementById('cfg-ip').textContent;
  var user = document.getElementById('cfg-user').value || 'admin';
  var pass = document.getElementById('cfg-pass').value;
  if (!ip) return;
  cfgSetStatus('Testing SSH to ' + ip + '...', '#fbbf24');
  try {
    var r = await invoke('installer_router_test_ssh', { ip: ip, user: user, password: pass });
    cfgSetStatus('SUCCESS\n' + r.identity + '\n' + r.resource, '#22c55e');
  } catch (e) {
    cfgSetStatus('FAILED: ' + e, '#fc8181');
  }
};
```

**DELETE THIS ENTIRE FUNCTION**

---

### Change 4: Replace cfg-apply Handler

**FIND THIS BLOCK:**
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
  cfgSetStatus('Applying configuration to ' + ip + '...\nThis may take 30-60 seconds.', '#fbbf24');
  try {
    var r = await invoke('installer_router_apply_config', {
      ip: ip, user: user, password: pass, ssid: ssid, wifiPassword: wifiPassword
    });
    var tail = r.log.slice(-12).join('\n');
    cfgSetStatus(
      (r.ok ? 'SUCCESS' : 'PARTIAL') + ' -- applied ' + r.applied + ', failed ' + r.failed + '\n\n' + tail,
      r.ok ? '#22c55e' : '#fbbf24'
    );
    // Auto-run readiness check after Apply
    runCheckStatus();
  } catch (e) {
    cfgSetStatus('FAILED: ' + e, '#fc8181');
  }
};
```

**REPLACE ENTIRE FUNCTION WITH:**
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
  cfgSetStatus('🔄 Configuring router…\n\nThis will take 60-90 seconds.\nPlease DO NOT close this window.', '#fbbf24');

  try {
    var result = await invoke('installer_auto_configure', {
      ip: ip,
      user: user,
      password: pass,
      ssid: ssid,
      wifi_password: wifiPassword
    });

    if (result.ok) {
      var msg = '✅ SUCCESS!\n\nConfiguration applied:\n';
      msg += result.steps_completed.map(s => '  ✓ ' + s).join('\n');
      msg += '\n\nNext steps:\n';
      msg += result.next_steps.map(s => '  • ' + s).join('\n');
      cfgSetStatus(msg, '#22c55e');
    } else {
      var msg = '⚠ PARTIAL SUCCESS\n\nCompleted:\n';
      msg += result.steps_completed.map(s => '  ✓ ' + s).join('\n');
      if (result.steps_failed.length > 0) {
        msg += '\n\nFailed:\n';
        msg += result.steps_failed.map(s => '  ✕ ' + s).join('\n');
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

---

### Change 5: Remove Readiness Panel Initialization

**FIND THIS FUNCTION:**
```javascript
async function runCheckStatus() {
  var ip = document.getElementById('cfg-ip').textContent;
  var user = document.getElementById('cfg-user').value || 'admin';
  var pass = document.getElementById('cfg-pass').value;
  if (!ip) return;
  var panel = document.getElementById('cfg-readiness');
  if (!panel) return;
  panel.style.display = 'block';
  var checksEl = document.getElementById('cfg-checks');
  checksEl.innerHTML = '<div style="color:#94a3b8; font-size:12.5px;">Checking router status...</div>';
  try {
    var r = await invoke('installer_router_check_status', { ip: ip, user: user, password: pass });
    renderChecks(r);
  } catch (e) {
    checksEl.innerHTML = '<div style="color:#fc8181; font-size:12.5px;">Check failed: ' + e + '</div>';
  }
}

function renderChecks(status) {
  var checksEl = document.getElementById('cfg-checks');
  var html = '';
  for (var i = 0; i < status.checks.length; i++) {
    var c = status.checks[i];
    var icon, color;
    if (c.ok) { icon = '\u2713'; color = '#22c55e'; }
    else if (c.warn_only) { icon = '!'; color = '#fbbf24'; }
    else { icon = '\u2715'; color = '#fc8181'; }
    html += '<div class="check-row">';
    html += '<span class="check-icon" style="color:' + color + ';">' + icon + '</span>';
    html += '<span class="check-label">' + c.label + '</span>';
    html += '<span class="check-detail">' + c.detail + '</span>';
    html += '</div>';
  }
  checksEl.innerHTML = html;
  var needsRepair = status.checks.some(function(c) { return !c.ok && !c.warn_only; });
  document.getElementById('cfg-repair').style.display = needsRepair ? 'inline-block' : 'none';
  var overall = document.getElementById('cfg-overall');
  if (status.overall_ok) {
    overall.innerHTML = '<span style="color:#22c55e;">Overall: READY</span>';
  } else {
    overall.innerHTML = '<span style="color:#fc8181;">Overall: NOT READY</span>';
  }
}

document.getElementById('cfg-check').onclick = runCheckStatus;
document.getElementById('cfg-repair').onclick = function() {
  var applyBtn = document.getElementById('cfg-apply');
  if (applyBtn) applyBtn.click();
};
// ---------- end readiness panel ----------
```

**DELETE ALL OF THIS** (entire readiness panel functions)

---

### Change 6: Keep These Sections (Do NOT delete)

Keep everything else:
- ✅ `openCfgModal()` - opens the modal
- ✅ `closeCfgModal()` - closes the modal  
- ✅ `cfgSetStatus()` - displays status messages
- ✅ `cfgModal` event handler setup
- ✅ Dashboard and auth buttons

---

## Summary of Changes

| What | Action | Lines |
|------|--------|-------|
| Readiness panel HTML | DELETE | ~10 lines |
| Button row | SIMPLIFY | ~4 lines |
| cfg-test handler | DELETE | ~15 lines |
| cfg-apply handler | REPLACE | ~50 lines |
| Readiness functions | DELETE | ~30 lines |

**Total:** Remove ~50-60 lines, Add ~40 lines = Net -10-20 lines

---

## Validation Checklist

After making these changes, verify:

- [ ] File still opens in browser without JS errors
- [ ] Modal can still open
- [ ] Form fields visible (admin user, password, SSID, WiFi password)
- [ ] "Configure Router" button visible and clickable
- [ ] Status div shows when button clicked
- [ ] No console errors

---

## Testing Flow After Changes

```javascript
// Test in browser console:
window.__TAURI__.core.invoke('installer_auto_configure', {
  ip: '192.168.88.1',
  user: 'admin',
  password: '',
  ssid: 'TestWiFi',
  wifi_password: 'TestPassword123'
})
.then(result => console.log(result))
.catch(err => console.error(err))
```

Should return:
```json
{
  "ok": true/false,
  "message": "...",
  "steps_completed": ["...", "..."],
  "steps_failed": [],
  "next_steps": ["...", "..."],
  "final_status": "..."
}
```

---
