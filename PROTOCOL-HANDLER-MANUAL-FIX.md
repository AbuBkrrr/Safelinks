# PROTOCOL HANDLER REGISTRATION - MANUAL FIX

## Problem
- Desktop installer not launching when clicking "Pair automatically"
- Deep-link handler not registered in Windows registry
- Build process timing out

## Solution: Reference Industry Standards

### How Electron/Tauri Apps Handle This
1. **Slack**, **Discord**, **VS Code** - All use deep-links registered at install-time
2. **Standard approach:** Registry entries in `HKCU\Software\Classes\{scheme}`
3. **Tauri v2** - `tauri-plugin-deep-link` should auto-register on Windows

### Why Manual Registration Works
- Bypasses installer build delay
- Immediately testable
- Same registry entries that installer would create

## Manual Registration Script

```powershell
# Run as current user (no admin needed for HKCU)
$scheme = "safelinks-installer"
$exe = "C:\Program Files\SAFE_Links Installer\SAFE_Links Installer.exe"

# Create registry key
reg add "HKCU\Software\Classes\$scheme" /ve /d "URL:SAFE Links Installer" /f
reg add "HKCU\Software\Classes\$scheme" /v "URL Protocol" /f

# Register command handler
reg add "HKCU\Software\Classes\$scheme\shell\open\command" /ve /d "`"$exe`" `"%%1`"" /f

# Verify
reg query "HKCU\Software\Classes\$scheme"
```

## Test Steps

1. **Register protocol (in PowerShell):**
   ```powershell
   $scheme = "safelinks-installer"
   $exe = "C:\Program Files\SAFE_Links Installer\SAFE_Links Installer.exe"
   reg add "HKCU\Software\Classes\$scheme" /ve /d "URL:SAFE Links Installer" /f
   reg add "HKCU\Software\Classes\$scheme" /v "URL Protocol" /f
   reg add "HKCU\Software\Classes\$scheme\shell\open\command" /ve /d "`"$exe`" `"%%1`"" /f
   ```

2. **Test deep-link manually (Win+R):**
   ```
   safelinks-installer://configure?resellerId=test&pairingCode=ABC123&token=xyz
   ```
   - Should see "Allow this app to open?" dialog
   - Click "Open" or "SAFE_Links Installer"
   - App should launch

3. **If dialog doesn't appear:**
   - Check if installer exe exists at path
   - Verify registry entries: `reg query "HKCU\Software\Classes\safelinks-installer"`
   - Check Windows Event Viewer → Applications for errors

## Once Working

After manual registration works:
1. Update installer build to embed same registry entries
2. OR rely on Tauri plugin to auto-register (it should)
3. Test with browser: click "Pair automatically" button

## Root Cause Analysis

| Issue | Cause | Fix |
|-------|-------|-----|
| Build timeout | Node/Cargo memory issue | Skip build, register manually |
| App not launching | No registry entries | Register entries |
| Registry entries wrong | Path to exe incorrect | Use absolute path |
| Malformed deep-link | URL encoding issue | Console.log to verify |

## References

- **Tauri deep-link plugin:** https://tauri.app/v1/guides/features/deep-linking/
- **Windows protocol handlers:** https://docs.microsoft.com/en-us/windows/win32/fileassoc/registering-an-application-to-a-url-scheme
- **Electron approach:** Similar pattern, Tauri does same thing
