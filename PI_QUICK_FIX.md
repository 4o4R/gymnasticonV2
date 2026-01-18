# Quick Fix Checklist for Raspberry Pi

## Copy & Paste These Commands

Run these on your Raspberry Pi **in order**:

### Step 1: Clean Up Git Conflict (2 minutes)
```bash
cd /opt/gymnasticon
git checkout -- src/util/ble-scan.js
git pull origin main
git status
```

**Expected**: `nothing to commit, working tree clean`

---

### Step 2: Reinstall Dependencies (1 minute)
```bash
npm install --omit=dev
```

**Expected**: Completes without blocking errors

---

### Step 3: Restart Bluetooth (1 minute)
```bash
sudo systemctl restart bluetooth
sleep 2
sudo hciconfig
```

**Expected**: Both hci0 and hci1 show `UP RUNNING`

---

### Step 4: Test with Keiser (30 seconds)
```bash
timeout 30 node src/app/cli.js --bike=keiser 2>&1
```

**During test**: Pedal the Keiser bike (light pedaling, 15-20 seconds)

**Expected**: See lines like:
```
[keiser] Connecting...
[connection-manager] Connected successfully
[metrics] Power: 145W
[metrics] Cadence: 88rpm
```

---

## If Something Goes Wrong

### Git Conflict Persists
```bash
git log --oneline -5          # See recent commits
git diff src/util/ble-scan.js # See what's different
git checkout -- .             # Reset all files
git pull origin main          # Try again
```

### Bluetooth Adapters Not Showing
```bash
hcitool dev                   # Check if adapters exist
sudo systemctl restart bluetooth  # Restart service
sudo hciconfig -a             # Show all details
```

### Still No Bike Found
```bash
# Verify hcitool works
sudo hcitool -i hci0 lescan
# (You should see your Keiser bike's MAC address)
# Press Ctrl+C to stop
```

---

## Verify the Bug Fixes

After successful test, check these appear in logs:

**✓ Exponential Backoff** (if retries needed):
```
[connection-manager] Retry 1/3 after XXms backoff
```

**✓ Disconnect Handling** (if disconnect occurs):
```
[connection-manager] ⚠ Peripheral disconnected during connection attempt
```

**✓ Dual Output** (shows adapters):
```
[gym-app] BLE server adapters: hci1
```

---

## Success Criteria

All should be ✅:
- [x] Git pull succeeds
- [x] npm install completes
- [x] Bluetooth adapters UP
- [x] Keiser bike connects
- [x] Metrics show in logs
- [x] No crashes or errors
- [x] Timeout cleanly exits

If all ✅, **you're done!**

---

## Need More Help?

See [PI_TROUBLESHOOTING.md](PI_TROUBLESHOOTING.md) for detailed explanations.

