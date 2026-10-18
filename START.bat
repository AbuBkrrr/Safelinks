@echo off
REM SAFE_Links Quick Start Script for Windows
REM This script starts everything needed to test the captive portal system

setlocal enabledelayedexpansion

echo.
echo 🚀 SAFE_Links Captive Portal - Quick Start
echo ==========================================
echo.

set PROJECT_ROOT=%~dp0
set WEB_DIR=%PROJECT_ROOT%web

echo 📂 Project directory: %PROJECT_ROOT%
echo.

REM Check Docker
where docker >nul 2>nul
if errorlevel 1 (
    echo ❌ Docker is not installed or not in PATH
    exit /b 1
)

echo ✅ Docker found
echo.

REM Start services
echo 🔄 Starting web stack...
cd /d "%WEB_DIR%"
docker compose up -d

echo.
echo ⏳ Waiting for services to start...
timeout /t 10 /nobreak

REM Check status
echo.
echo 📊 Service Status:
docker compose ps

echo.
echo 🧪 Testing endpoints...

REM Test backend
for /f "tokens=*" %%i in ('curl -s http://localhost:4000/health 2^>nul') do set HEALTH_RESPONSE=%%i
if "%HEALTH_RESPONSE%"=="" (
    echo ⚠️ Backend API not yet ready (building)
) else if "%HEALTH_RESPONSE:ok=%" NEQ "%HEALTH_RESPONSE%" (
    echo ✅ Backend API is responding
) else (
    echo ⚠️ Backend API not yet ready (building)
)

echo.
echo ════════════════════════════════════════
echo 🎉 SAFE_Links is starting!
echo.
echo 📍 Open your browser:
echo    → http://localhost
echo.
echo 🔐 Test credentials:
echo    Email:    admin@nairobitech.io
echo    Password: reseller123
echo.
echo 💡 What to test:
echo    1. Create a subscription plan (Plans tab)
echo    2. Check router detection (Routers tab)
echo    3. View pending activations
echo    4. Check dashboard monitoring
echo.
echo 📚 Documentation:
echo    → SYSTEM-READY-TO-TEST.md
echo    → COMPLETE-ONE-CLICK-INSTALLER.md
echo.
echo 🛑 To stop all services:
echo    cd web ^&^& docker compose down
echo.

REM Open browser
start http://localhost

