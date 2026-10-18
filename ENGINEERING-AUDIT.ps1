#!/usr/bin/env pwsh

# SAFE_Links Engineering Audit

function OK($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function MISS($msg) { Write-Host "  [NO] $msg" -ForegroundColor Red }
function WARN($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function HEAD($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

$root = "C:\Users\DELL\Downloads\safe-links-updated"
Set-Location $root

HEAD "1. WEB PLATFORM - REACT FRONTEND"
$frontendDir = "$root\web\frontend\src"
@(
    ("App.jsx", "$frontendDir\App.jsx"),
    ("api.js", "$frontendDir\api.js"),
    ("ui.jsx", "$frontendDir\ui.jsx"),
    ("Signup.jsx", "$frontendDir\Signup.jsx")
) | ForEach-Object {
    if (Test-Path $_[1]) { OK $_[0] } else { MISS $_[0] }
}

HEAD "2. WEB PLATFORM - NODE.JS BACKEND"
$backendDir = "$root\web\backend\src"
@(
    ("server.js", "$backendDir\server.js"),
    ("db.js", "$backendDir\db.js"),
    ("http.js", "$backendDir\http.js"),
    ("auth.js", "$backendDir\routes\auth.js"),
    ("portal.js", "$backendDir\routes\portal.js"),
    ("reseller.js", "$backendDir\routes\reseller.js"),
    ("superAdmin.js", "$backendDir\routes\superAdmin.js"),
    ("router.js", "$backendDir\routes\router.js"),
    ("agent.js", "$backendDir\routes\agent.js")
) | ForEach-Object {
    if (Test-Path $_[1]) { OK $_[0] } else { MISS $_[0] }
}

HEAD "3. DATABASE SCHEMA"
$dbJs = Get-Content "$backendDir\db.js" -Raw
@("users", "resellers", "super_admins", "plans", "vouchers", "pending_activations", "routers", "router_commands", "payments", "product_keys") | ForEach-Object {
    if ($dbJs -match "CREATE TABLE IF NOT EXISTS $_") { OK "Table: $_" } else { MISS "Table: $_" }
}

HEAD "4. DESKTOP INSTALLER - TAURI"
$tauriDir = "$root\installer\src-tauri\src"
@(
    ("main.rs", "$tauriDir\main.rs"),
    ("scanner.rs", "$tauriDir\scanner.rs"),
    ("ssh_client.rs", "$tauriDir\ssh_client.rs"),
    ("auth.rs", "$tauriDir\auth.rs"),
    ("tauri.conf.json", "$root\installer\src-tauri\tauri.conf.json")
) | ForEach-Object {
    if (Test-Path $_[1]) { OK $_[0] } else { MISS $_[0] }
}

HEAD "5. ROUTER AGENT - MIKROTIK SCRIPTS"
$scriptDir = "$root\web\backend\router-scripts"
@(
    ("safelinks-agent.rsc", "$scriptDir\safelinks-agent.rsc"),
    ("safelinks-configure.rsc", "$scriptDir\safelinks-configure.rsc"),
    ("safelinks-detect.rsc", "$scriptDir\safelinks-detect.rsc")
) | ForEach-Object {
    if (Test-Path $_[1]) { OK $_[0] } else { MISS $_[0] }
}

HEAD "6. INSTALLER UI - REACT COMPONENTS"
$uiDir = "$root\installer\ui\src\components"
@(
    ("LoginScreen.jsx", "$uiDir\LoginScreen.jsx"),
    ("NetworkScanner.jsx", "$uiDir\NetworkScanner.jsx"),
    ("ConfigForm.jsx", "$uiDir\ConfigForm.jsx"),
    ("ProgressMonitor.jsx", "$uiDir\ProgressMonitor.jsx"),
    ("SuccessScreen.jsx", "$uiDir\SuccessScreen.jsx")
) | ForEach-Object {
    if (Test-Path $_[1]) { OK $_[0] } else { MISS $_[0] }
}

HEAD "7. DOCKER DEPLOYMENT"
@(
    ("docker-compose.yml", "docker-compose.yml"),
    ("web backend Dockerfile", "web\backend\Dockerfile"),
    ("web frontend Dockerfile", "web\frontend\Dockerfile")
) | ForEach-Object {
    if (Test-Path $_[1]) { OK $_[0] } else { MISS $_[0] }
}

HEAD "8. SECURITY CHECKS"
$allBackend = Get-ChildItem "$backendDir" -Recurse -Filter "*.js" -ErrorAction SilentlyContinue | Get-Content -Raw | Out-String
@(
    ("JWT authentication", ($allBackend -match "jwt|JWT")),
    ("Password hashing", ($allBackend -match "hash|bcrypt|scrypt")),
    ("Rate limiting", ($allBackend -match "rateLimit|rate_limit")),
    ("CORS headers", ($allBackend -match "Access-Control|CORS"))
) | ForEach-Object {
    if ($_[1]) { OK $_[0] } else { MISS $_[0] }
}

HEAD "9. BACKLOG FEATURES NOT YET IMPLEMENTED"
@(
    "Automated Dunning and Delinquency Management",
    "RADIUS/AAA Server Core",
    "TR-069 Auto Configuration Server",
    "Fair Usage Policy (FUP) and QoS",
    "CRM and Ticketing System (basic exists)",
    "Field Operations and Job Scheduling",
    "White-labeled Mobile App (Android folder exists)",
    "NetFlow/IPFIX Traffic Analysis",
    "On-Premise Deployment Option"
) | ForEach-Object {
    WARN "BACKLOG: $_"
}

HEAD "10. PRODUCTION STATUS"
try {
    $health = Invoke-RestMethod "https://backend-services-production-78d8.up.railway.app/health" -TimeoutSec 5
    if ($health.ok) { OK "Production backend is LIVE on Railway" }
} catch {
    WARN "Production backend check failed"
}

HEAD "AUDIT COMPLETE"
Write-Host "`nStatus:"
Write-Host "  [OK] = Implemented"
Write-Host "  [NO] = Missing (Critical)"
Write-Host "  [!] = Backlog (Future Enhancement)"
