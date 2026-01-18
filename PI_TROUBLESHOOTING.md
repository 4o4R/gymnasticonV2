# Raspberry Pi Troubleshooting Guide

## Issue Summary

You have two problems on the Pi:

1. **Git Conflict**: Local changes to `src/util/ble-scan.js` blocking merge
2. **Noble State Issue**: Bluetooth state showing as "unknown" instead of "poweredOn"

---

## Problem 1: Git Conflict - Local Changes to ble-scan.js

### What Happened
You made edits to `src/util/ble-scan.js` on the Pi that conflict with the latest code from main branch.

### Quick Fix (Recommended)
```bash
cd /opt/gymnasticon

# Option 1: Discard your local changes and use latest version
git checkout -- src/util/ble-scan.js
git pull origin main

# Option 2: If you want to keep your changes
git stash
git pull origin main
git stash pop  # Reapply your changes after merge
```

### Which Option?
- **Use Option 1** if: You don't remember why you edited ble-scan.js or the edits aren't critical
- **Use Option 2** if: You made important customizations that need to be preserved

Since you likely edited it as a workaround and our new fixes address the underlying issues, **Option 1 is safer**.

---

## Problem 2: Noble State "Unknown" vs "PoweredOn"

### What's Happening
```
[gym-cli] Bluetooth initialized; noble state: unknown
[ble-scan] ⚠ Noble scan failed: Could not start scanning, state is unknown (not poweredOn)
```

This means noble doesn't think the Bluetooth adapter is powered on, even though it is.

### Root Cause
This is a **known issue on Raspberry Pi** with certain BlueZ versions. The adapter IS actually on, but noble isn't detecting the state correctly.

### Solution
The code already handles this! Look at these logs:
```
[gym-app] adapter hci0 is UP (verified via hciconfig); noble state is unknown
[gym-app] proceeding despite noble state mismatch (some Pi/BlueZ combinations have this issue)
[gym-app] Bluetooth adapter ready (poweredOn)
```

✅ **This is working correctly** - it detects the mismatch and continues anyway.

However, it then falls back to hcitool and seems to stop. Let me show you why:

---

## Problem 3: Scan Not Starting After Fallback

### What You're Seeing
```
[ble-scan] ⚠ Falling back to hcitool lescan...
pi@raspberrypi:/opt/gymnasticon $
```

The prompt returns without actually scanning. This suggests the scan timed out or the app exited early.

### Why It Happens
1. Noble scan fails due to state mismatch
2. Falls back to hcitool
3. But the fallback isn't showing output

### Check the Full Logs
When you run the test, capture all output:
```bash
cd /opt/gymnasticon
timeout 30 node src/app/cli.js --bike=keiser 2>&1 | tee test.log
```

Then check:
```bash
tail -100 test.log
```

Look for:
- `[ble-scan]` messages (showing scan progress)
- `[keiser]` messages (showing bike detection)
- Any error messages

---

## Step-by-Step Resolution

### Step 1: Clean Up Git
```bash
cd /opt/gymnasticon

# Show what's changed
git diff src/util/ble-scan.js

# Discard local changes
git checkout -- src/util/ble-scan.js

# Pull latest
git pull origin main

# Check status
git status
```

Expected: `nothing to commit, working tree clean`

### Step 2: Reinstall Dependencies
```bash
npm install --omit=dev
```

Expected: Should complete without blocking errors.

### Step 3: Restart Bluetooth
```bash
sudo systemctl restart bluetooth
sleep 2

# Verify adapters are up
sudo hciconfig
```

Expected output for both hci0 and hci1:
```
hci0:   Type: Primary  Bus: USB
        BD Address: XX:XX:XX:XX:XX:XX  ACL MTU: 310:10  SCO MTU: 64:8
        UP RUNNING
        RX bytes: ... TX bytes: ...

hci1:   Type: Primary  Bus: USB
        ...
        UP RUNNING
```

### Step 4: Test Keiser Bike
```bash
timeout 30 node src/app/cli.js --bike=keiser 2>&1
```

**During the test**, pedal the Keiser bike:
- Use light pedaling (don't go hard)
- Pedal for 15-20 seconds
- Should see power/cadence data in logs

### Step 5: Expected Log Output

**Good** (bike connects):
```
[keiser] Starting Keiser bike scan...
[ble-scan] Found Keiser: KEISER_XXXX at address XX:XX:XX:XX:XX:XX
[keiser] Connecting to bike...
[connection-manager] Attempting connection to KEISER_XXXX
[connection-manager] Connected successfully
[keiser] Bike initialized ✓
[metrics] Power: 145W Cadence: 88rpm
```

**Also Good** (falls back to hcitool but still works):
```
[ble-scan] ⚠ Noble scan failed: Could not start scanning, state is unknown
[ble-scan] ⚠ Falling back to hcitool lescan...
[ble-scan] Scanning via hcitool...
[keiser] Found Keiser: KEISER_XXXX at address XX:XX:XX:XX:XX:XX
```

**Problem** (scan times out):
```
[keiser] Starting Keiser bike scan (timeout: disabled)...
[ble-scan] ⚠ Noble scan failed...
[ble-scan] ⚠ Falling back to hcitool lescan...
# Then nothing happens
```

---

## If Scan Times Out

### Check 1: Are Adapters Actually Up?
```bash
hcitool dev
sudo hciconfig
```

Both should show both hci0 and hci1 with `UP RUNNING`.

### Check 2: Is hcitool Working?
```bash
sudo hcitool -i hci0 lescan
# Should show nearby BLE devices including your Keiser bike
# Press Ctrl+C to stop
```

### Check 3: Are You Close to the Bike?
Keiser bikes have limited Bluetooth range. Make sure you're within 5-10 feet.

### Check 4: Is the Bike in Pairing Mode?
Some bikes need to be in pairing mode. Check your Keiser's manual for how to enable Bluetooth advertising.

---

## Verify the Fixes are Working

After you get it running, check for these in the logs:

### Fix #55 (Noble Crash Prevention)
Look for:
```
[connection-manager] ⚠ Peripheral disconnected during connection attempt
```
(Only appears if disconnect happens during connection - not every time, only on issues)

### Fix #95 (Exponential Backoff)
Look for:
```
[connection-manager] Retry 1/3 after XXms backoff
```
(Only appears if connection retry is needed - not every time, only on failures)

### Fix #99 (Dual Output)
Look for:
```
[gym-app] BLE server adapters: hci1
```
or if dual:
```
[gym-app] BLE server adapters: hci1, hci2
```

---

## Quick Commands Reference

```bash
# Go to app directory
cd /opt/gymnasticon

# Show git status
git status

# Discard local changes
git checkout -- src/util/ble-scan.js

# Pull latest
git pull origin main

# Check Bluetooth adapters
hcitool dev
sudo hciconfig

# Restart Bluetooth
sudo systemctl restart bluetooth

# Check Bluetooth service status
sudo systemctl status bluetooth

# Test with Keiser bike
timeout 30 node src/app/cli.js --bike=keiser 2>&1

# Test with detailed logging
DEBUG=* timeout 30 node src/app/cli.js --bike=keiser 2>&1

# View last 50 lines of logs
tail -50 /var/log/syslog | grep -i bluetooth
```

---

## Common Issues & Solutions

| Issue | Symptom | Fix |
|-------|---------|-----|
| Git conflict | `would be overwritten by merge` | `git checkout -- src/util/ble-scan.js` |
| Noble state unknown | `state is unknown (not poweredOn)` | Normal on Pi, app handles it, check hcitool fallback |
| Adapters down | `hcitool dev` shows nothing | `sudo systemctl restart bluetooth` |
| Scan timeout | App starts but doesn't find bike | Check you're close to bike, bike is powered on |
| Bike not found | Scan runs but no Keiser | Check bike's Bluetooth is on |

---

## After Fix Verification

Once you have it working, create a test run log:

```bash
cd /opt/gymnasticon

# Clean previous test logs
rm -f test.log

# Run 30-second test (pedal bike during this)
timeout 30 node src/app/cli.js --bike=keiser 2>&1 | tee test.log

# Show the last 30 lines
tail -30 test.log
```

Should show:
- ✅ Bike connected
- ✅ Metrics flowing (Power/Cadence/HR)
- ✅ No crashes or exceptions
- ✅ Clean shutdown after timeout

---

## Next Steps

1. **Try the git fix** first:
   ```bash
   cd /opt/gymnasticon
   git checkout -- src/util/ble-scan.js
   git pull origin main
   ```

2. **Restart Bluetooth**:
   ```bash
   sudo systemctl restart bluetooth
   sleep 2
   ```

3. **Test with Keiser**:
   ```bash
   timeout 30 node src/app/cli.js --bike=keiser 2>&1
   ```

4. **Report back** with:
   - Did the git pull work?
   - Did Bluetooth restart succeed?
   - What does the test show?

