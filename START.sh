#!/bin/bash
# SAFE_Links Quick Start Script
# This script starts everything needed to test the captive portal system

set -e

echo "🚀 SAFE_Links Captive Portal - Quick Start"
echo "=========================================="
echo ""

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$PROJECT_ROOT/web"

echo "📂 Project directory: $PROJECT_ROOT"
echo ""

# Check Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed"
    exit 1
fi

echo "✅ Docker found"
echo ""

# Start services
echo "🔄 Starting web stack..."
cd "$WEB_DIR"
docker compose up -d

echo ""
echo "⏳ Waiting for services to start..."
sleep 10

# Check status
echo ""
echo "📊 Service Status:"
docker compose ps

echo ""
echo "🧪 Testing endpoints..."

# Test backend
if curl -s http://localhost:4000/health | grep -q "ok"; then
    echo "✅ Backend API is responding"
else
    echo "⚠️ Backend API not yet ready (building)"
fi

# Test frontend  
if curl -s http://localhost > /dev/null 2>&1; then
    echo "✅ Frontend is responding"
else
    echo "⚠️ Frontend not yet ready (building)"
fi

echo ""
echo "════════════════════════════════════════"
echo "🎉 SAFE_Links is starting!"
echo ""
echo "📍 Open your browser:"
echo "   → http://localhost"
echo ""
echo "🔐 Test credentials:"
echo "   Email:    admin@nairobitech.io"
echo "   Password: reseller123"
echo ""
echo "💡 What to test:"
echo "   1. Create a subscription plan (Plans tab)"
echo "   2. Check router detection (Routers tab)"
echo "   3. View pending activations"
echo "   4. Check dashboard monitoring"
echo ""
echo "📚 Documentation:"
echo "   → SYSTEM-READY-TO-TEST.md"
echo "   → COMPLETE-ONE-CLICK-INSTALLER.md"
echo ""
echo "🛑 To stop all services:"
echo "   cd web && docker compose down"
echo ""
