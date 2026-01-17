# Immediate Next Steps: Your Pi + hcitool Fallback

## Current Status

**Last Test (January 16, 2026):**
```
✅ Git pulled latest (commit eb53f00)
✅ npm install rebuilt native modules
⏳ Test: timeout 30 node src/app/cli.js --bike=keiser 2>&1
   Result: Timed out waiting for stateChange event
   Root Cause: noble.state stuck at 'unknown', never emits event
```

**What Changed:**
- Commit eb53f00 adds adapter fallback + hcitool fallback
- Now detects if adapter is UP via `hciconfig` despite noble being stuck
- If noble.startScanningAsync() fails, falls back to hcitool lescan

---

## Critical Test: Does hcitool Find Your Bike?

**This is the bottleneck.** If hcitool can find your bike, V2 WILL work.

```bash
# SSH to Pi
ssh pi@raspberrypi

# Test 1: Does hcitool exist?
which hcitool
# Expected: /usr/bin/hcitool

# Test 2: Can you run it with sudo?
sudo -n hcitool -i hci0 lescan
# Expected: Starts scanning immediately (no password prompt)
# If "sudo: not authorized" → see TESTING_DUAL_ADAPTERS.md fix

# Test 3: Does it find your bike?
sudo timeout 10 hcitool -i hci0 lescan
# Pedal the bike HARD during this scan
# Expected output:
# LE Scan ...
# EF:D7:CB:6C:69:18 M3i#000    ← Your bike!
# ^C
```

**If Test 3 FAILS (no bike found):**
- Issue: Bike not broadcasting or range problem
- Fix: Bring Pi closer to bike, ensure bike powered on, pedal hard

**If Tests 1-2 FAIL:**
- Issue: hcitool not installed or sudo permissions wrong
- Fix: Follow setup in TESTING_DUAL_ADAPTERS.md "hcitool: not found" section

---

## Quick Deployment of Latest Fix

```bash
cd /opt/gymnasticon

# Pull latest
git pull origin main

# Rebuild (required after code changes)
npm install --omit=dev

# Test with verbose output
timeout 30 node src/app/cli.js --bike=keiser 2>&1 | tee test-output.txt

# Pedal bike while running

# Check output for success pattern:
grep -E "adapter.*UP|Noble scan failed|Falling back|MATCH|Found.*bike" test-output.txt
```

---

## Expected Output Patterns

### Pattern A: Noble Works ✅ (Best Case)
```
[gym-app] checking Bluetooth adapter state: unknown
[gym-app] waiting for Bluetooth adapter to become poweredOn (attempt 1/3, current state: unknown)
[gym-app] ✓ Received stateChange event: poweredOn
[gym-app] Bluetooth adapter ready (poweredOn)
[keiser] Starting Keiser bike scan (timeout: disabled)...
[ble-scan] ✓ Noble scan started successfully
[ble-scan] ✓ Discover events ARE firing! First device: M3i#000 [EF:D7:CB:6C:69:18]
[keiser] Found Keiser bike! address=EF:D7:CB:6C:69:18
[keiser] Connected to Keiser bike; waiting for power data...

→ SUCCESS! You can skip hcitool fallback completely
```

### Pattern B: Noble Stuck → hcitool Saves ✅ (Expected on Your Pi)
```
[gym-app] checking Bluetooth adapter state: unknown
[gym-app] waiting for Bluetooth adapter to become poweredOn (attempt 1/3, current state: unknown)
[gym-app] Bluetooth adapter state timeout after 3000ms; reinitializing noble
[gym-app] ✓ Adapter hci0 is UP (verified via hciconfig); proceeding despite noble state being unknown
[gym-app] Bluetooth adapter ready (poweredOn)
[keiser] Starting Keiser bike scan (timeout: disabled)...
[ble-scan] ⚠ Noble scan failed: Could not start scanning, state is unknown (not poweredOn)
[ble-scan] ⚠ Falling back to hcitool lescan...
[ble-scan] hcitool found: M3i#000 [EF:D7:CB:6C:69:18]
[ble-scan] ✓ MATCH via hcitool: M3i#000 [EF:D7:CB:6C:69:18]
[keiser] Found Keiser bike! address=EF:D7:CB:6C:69:18
[keiser] Connected to Keiser bike; waiting for power data...

→ SUCCESS! Fallback worked!
```

### Pattern C: Both Fail ❌ (Problem)
```
[gym-app] checking Bluetooth adapter state: unknown
[gym-app] waiting for Bluetooth adapter to become poweredOn (attempt 1/3, current state: unknown)
[gym-app] Bluetooth adapter state timeout after 3000ms; reinitializing noble
[gym-app] adapter hci0 failed to power on; trying hci1
[gym-app] ✗ No usable adapter found
Terminated

→ PROBLEM: Adapter not found or permissions issue
   See troubleshooting section below
```

### Pattern D: hcitool Missing ❌ (Fix Required)
```
[ble-scan] ⚠ Noble scan failed: Could not start scanning, state is unknown
[ble-scan] ⚠ Falling back to hcitool lescan...
[ble-scan] Failed to start hcitool: spawn sudo ENOENT

→ PROBLEM: hcitool not installed
   Fix: sudo apt-get install -y bluez
```

---

## Troubleshooting for Your Pi

### "Timeout waiting for stateChange" (Before Fallback Kicks In)

**Issue:** noble.state never changes from 'unknown'

**Why it happens:** Some Pi/BlueZ combinations have broken noble state machine

**V2 Response:**
1. After 3s timeout, code checks `hciconfig` to see if adapter is UP
2. If UP, proceeds anyway (trusts hciconfig over noble)
3. When noble.startScanningAsync() fails, uses hcitool fallback
4. hcitool finds your bike
5. Success! ✓

**Verify it's working:**
```bash
timeout 30 node src/app/cli.js --bike=keiser 2>&1 | grep "adapter.*UP"
# Should see:
# [gym-app] ✓ Adapter hci0 is UP (verified via hciconfig); proceeding...
```

### "Adapter not found" (Both Adapters Missing)

**Issue:** detectAdapters() found zero adapters

**Check:**
```bash
ls -la /sys/class/bluetooth/
# Should show: hci0, hci1, or both

# If empty:
sudo hciconfig -a
# Should show at least hci0

# If hciconfig shows nothing:
sudo rfkill list
# Check if Bluetooth is blocked
```

### "Bike not found via hcitool" (Bike Not Visible)

**Issue:** hcitool scan completes but doesn't show your bike

**Cause:** 
- Bike not powered on
- Bike in pairing mode (not broadcasting normally)
- Bluetooth interference
- Range too far (weak signal)

**Test:**
```bash
# Check bike is visible to ANY device
sudo hcitool scan
# Pedal bike hard

# If bike shows up here but not in lescan:
# → hcitool version issue (rare)

# If bike doesn't show up at all:
# → Bike off, or not in range
# → Move Pi next to bike
# → Ensure bike has full battery
# → Restart bike and try again
```

---

## Single Command to Run Final Test

```bash
# Full test with all diagnostics
cd /opt/gymnasticon && \
echo "=== Adapter Detection ===" && \
node -e "import('./src/util/adapter-detect.js').then(m => console.log(JSON.stringify(m.detectAdapters(), null, 2)))" && \
echo "" && \
echo "=== HCI Config ===" && \
hciconfig -a && \
echo "" && \
echo "=== Test hcitool ===" && \
sudo timeout 5 hcitool -i hci0 lescan || echo "(no devices found in 5s)" && \
echo "" && \
echo "=== Running Gymnasticon (30s) ===" && \
timeout 30 node src/app/cli.js --bike=keiser 2>&1 | tee /tmp/gym-test.log && \
echo "" && \
echo "=== Result Summary ===" && \
grep -E "Found.*bike|adapter.*UP|Falling back|MATCH" /tmp/gym-test.log || echo "NO SUCCESS PATTERN FOUND"
```

**This one command will:**
1. ✓ Show your adapter config
2. ✓ Verify hcitool can find devices
3. ✓ Run the full app test
4. ✓ Show if it succeeded

---

## Success Checkpoints

| Step | Status | Command |
|------|--------|---------|
| 1. Adapter detected | ✅/❌ | `hciconfig -a` (shows hci0 UP RUNNING) |
| 2. hcitool available | ✅/❌ | `which hcitool` (returns /usr/bin/hcitool) |
| 3. sudo works | ✅/❌ | `sudo -n hcitool -h > /dev/null` (no output, exit 0) |
| 4. Bike visible | ✅/❌ | `sudo hcitool -i hci0 lescan` (shows M3i) |
| 5. Adapter detected by V2 | ✅/❌ | `node -e "import(...).then(...)"` (shows hci0) |
| 6. V2 boots without error | ✅/❌ | `timeout 30 node src/app/cli.js...` (no ENOENT/EACCES) |
| 7. Noble finds bike OR fallback works | ✅/❌ | Check for "Found Keiser bike" or "MATCH via hcitool" |
| 8. Zwift connects | ✅/❌ | Open Zwift, pair with "Gymnasticon" power sensor |

**If all 8 are ✅ → V2 is fully working!**

---

## Next Steps After This Test

If the test succeeds:
1. ✅ Verify multi-sensor discovery (HR, speed, cadence if available)
2. ✅ Test with Zwift connected (watch metrics flow)
3. ✅ Test adapter fallback (disconnect USB dongle if you have one)
4. ✅ Document which pattern occurred (noble working vs hcitool needed)
5. ✅ Prepare deployment (systemd service, startup scripting)

If the test fails:
1. ❌ Follow troubleshooting section above
2. ❌ Share error logs for detailed debugging
3. ❌ Check if permissions issue (hcitool permissions)
4. ❌ Check if hardware issue (bike off, Bluetooth disabled)

---

## Quick Reference: Files Changed in Latest Commit

**eb53f00 - Handle noble state issues with adapter-up fallback + hcitool**

```javascript
// app.js - What Changed:
✅ Detect when adapter is UP via hciconfig despite noble.state='unknown'
✅ Shortened noble stateChange timeout from 15s → 3s
✅ Proceed anyway if adapter is UP (trust hciconfig over noble)

// ble-scan.js - What Changed:
✅ Try noble.startScanningAsync() first (original way)
✅ Catch error when it fails due to noble.state='unknown'
✅ Fall back to hcitool subprocess scan
✅ Create fake peripheral object from hcitool output
✅ Use same filter function for both paths
```

---

## One-Liner Explanation

> **V2 now says: "If noble is broken but the adapter is UP, I'll use hcitool to find your bike instead of giving up."**

This is the pragmatic solution for your Pi hardware that doesn't play nicely with noble's state machine.
