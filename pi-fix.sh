#!/bin/bash
# Fix Guide for Raspberry Pi Deployment Issues
# Run this on the Pi to resolve git conflicts and noble state issues

echo "🔧 Gymnastic Pi Fix Guide"
echo "================================"
echo ""

# Step 1: Check current directory
echo "Step 1: Verify you're in the correct directory"
pwd

if [ ! -d "/opt/gymnasticon" ]; then
    echo "❌ /opt/gymnasticon not found"
    exit 1
fi

cd /opt/gymnasticon
echo "✅ In /opt/gymnasticon"
echo ""

# Step 2: Show what local changes exist
echo "Step 2: Checking for local changes..."
git status
echo ""

# Step 3: Option A - Discard local changes (recommended for ble-scan.js)
echo "Step 3: Handling local changes..."
echo "Local changes found. Checking if they're important..."
git diff src/util/ble-scan.js

echo ""
echo "Options:"
echo "  A) Discard local changes and use latest version (RECOMMENDED)"
echo "  B) Stash changes and reapply after merge"
echo ""
echo "Proceeding with Option A (discard)..."
echo ""

# Discard the local changes
git checkout -- src/util/ble-scan.js
echo "✅ Local changes discarded"
echo ""

# Step 4: Pull latest code
echo "Step 4: Pulling latest code from main branch..."
git pull origin main
if [ $? -eq 0 ]; then
    echo "✅ Git pull successful"
else
    echo "❌ Git pull failed"
    exit 1
fi
echo ""

# Step 5: Verify connection-manager.js is in place
echo "Step 5: Verifying critical bug fixes are present..."
if grep -q "calculateBackoff" src/util/connection-manager.js; then
    echo "✅ Bug fix #95 (exponential backoff) present"
else
    echo "❌ Bug fix #95 missing!"
fi

if grep -q "Peripheral disconnected during connection attempt" src/util/connection-manager.js; then
    echo "✅ Bug fix #55 (disconnect handling) present"
else
    echo "❌ Bug fix #55 missing!"
fi
echo ""

# Step 6: Reinstall dependencies
echo "Step 6: Reinstalling dependencies..."
npm install --omit=dev
if [ $? -eq 0 ]; then
    echo "✅ npm install successful"
else
    echo "⚠️ npm install had warnings, but continuing..."
fi
echo ""

# Step 7: Check Bluetooth adapters
echo "Step 7: Checking Bluetooth adapters..."
hcitool dev
echo ""

# Step 8: Restart bluetooth service
echo "Step 8: Restarting Bluetooth service..."
sudo systemctl restart bluetooth
sleep 2
echo "✅ Bluetooth service restarted"
echo ""

# Step 9: Verify adapters are up
echo "Step 9: Verifying adapter states..."
sudo hciconfig
echo ""

echo "================================"
echo "✅ Fix complete! Ready to test."
echo ""
echo "Next: Run the Keiser test"
echo "  timeout 30 node src/app/cli.js --bike=keiser 2>&1"
echo ""
