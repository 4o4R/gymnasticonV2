# Understanding the "Noble State Unknown" Issue

## The Problem You're Seeing

```
[gym-cli] Bluetooth initialized; noble state: unknown
[ble-scan] ⚠ Noble scan failed: Could not start scanning, state is unknown (not poweredOn)
[gym-app] adapter hci0 is UP (verified via hciconfig); noble state is unknown
[gym-app] proceeding despite noble state mismatch (some Pi/BlueZ combinations have this issue)
```

## What This Means

### The Contradiction
- **What noble thinks**: Bluetooth is OFF (unknown state)
- **What the system actually is**: Bluetooth is ON (verified via hciconfig)
- **Result**: Scan tries to start, fails, but app continues anyway

### Why It Happens
On Raspberry Pi with certain BlueZ versions:
1. The Bluetooth adapter IS powered on
2. But noble (the BLE scanning library) can't detect the state correctly
3. So noble reports "unknown" instead of "poweredOn"
4. This prevents noble's scan from starting

### But The App Handles It!
Look at these log lines:
```
[gym-app] adapter hci0 is UP (verified via hciconfig); noble state is unknown
[gym-app] proceeding despite noble state mismatch (some Pi/BlueZ combinations have this issue)
```

The app:
1. Detects the mismatch
2. Verifies the adapter IS actually up via hciconfig
3. **Continues anyway** - this is the fix!
4. Falls back to `hcitool lescan` (command-line scanning)

---

## Why This Fallback Exists

### Noble Scan (Preferred, but fails here)
```
node → noble → libbluetooth → HCI
```
- Fast, integrated
- But needs correct state detection
- Fails when noble can't detect state

### hcitool Fallback (Slower, but reliable)
```
node → shell → hcitool → HCI
```
- Slower (spawns external process)
- But doesn't require state detection
- Works even with state mismatch

---

## Why You're Seeing Scan Stop

The sequence in your logs:
```
[keiser] Starting Keiser bike scan (timeout: disabled)...
[ble-scan] ⚠ Noble scan failed: Could not start scanning, state is unknown (not poweredOn)
[ble-scan] ⚠ Falling back to hcitool lescan...
pi@raspberrypi:/opt/gymnasticon $
```

Then the prompt returns. This suggests:

1. ✅ Noble scan tried (failed as expected)
2. ✅ Fallback to hcitool initiated
3. ❓ hcitool scan didn't produce output
4. ❓ App may have exited or timed out

---

## What Should Happen

### Good Scenario 1: Noble works
```
[keiser] Starting Keiser bike scan...
[ble-scan] Starting noble scan...
[ble-scan] Found Keiser: KEISER_1234 at address CC:AA:BB:DD:EE:FF
[keiser] Connecting...
[connection-manager] Connected successfully
```

### Good Scenario 2: Falls back to hcitool, still works
```
[keiser] Starting Keiser bike scan...
[ble-scan] Noble scan failed: state is unknown
[ble-scan] Falling back to hcitool lescan...
[ble-scan] hcitool scan found: KEISER_1234 (CC:AA:BB:DD:EE:FF)
[keiser] Connecting...
[connection-manager] Connected successfully
```

### Bad Scenario: Nothing found
```
[keiser] Starting Keiser bike scan...
[ble-scan] Noble scan failed: state is unknown
[ble-scan] Falling back to hcitool lescan...
# Scans for timeout period, finds nothing
[keiser] Bike not found
```

---

## How to Check What's Happening

### Test Noble Directly
```bash
# This will show if noble can scan
cd /opt/gymnasticon
DEBUG=noble node -e "
const noble = require('@abandonware/noble');
noble.on('stateChange', state => console.log('Noble state:', state));
noble.startScanning();
setTimeout(() => process.exit(), 5000);
"
```

Expected: Should change state or at least log attempts.

### Test hcitool Directly
```bash
# This will show if hcitool can find your bike
sudo hcitool -i hci0 lescan
# Should show: CC:AA:BB:DD:EE:FF KEISER_1234
# (or whatever your Keiser's MAC is)
# Press Ctrl+C to stop after ~10 seconds
```

### Check Bluetooth Service
```bash
# Full status
sudo systemctl status bluetooth

# Restart if needed
sudo systemctl restart bluetooth
sleep 2

# Verify adapters
hcitool dev
sudo hciconfig
```

---

## Why This Issue Exists (Technical)

### The Root Cause
noble uses the BlueZ D-Bus interface to check Bluetooth state:
```
noble → D-Bus → BlueZ Manager → Adapter State
```

On some Raspberry Pi + BlueZ combinations:
- The D-Bus interface has issues
- The state query returns "unknown"
- But the actual adapter IS powered on

### Why We Don't Fix It
We can't "fix" this in noble because:
1. It's a BlueZ/system issue, not a code issue
2. noble is not part of this project
3. The workaround (hcitool fallback) is better

### Why The Workaround Works
hcitool uses raw HCI commands:
```
hcitool → HCI device file → Adapter
```

This bypasses the D-Bus issue entirely:
- No state checks needed
- Direct hardware communication
- Always works if adapter is actually up

---

## The Fix in Your Code

This is handled in `src/util/ble-scan.js`:

```javascript
// Attempt noble scan
try {
  await noble.startScanningAsync(...);
  // If noble works, great!
} catch (error) {
  if (error.message.includes('state is unknown')) {
    // Check if adapter is actually up
    if (isAdapterUp()) {
      // Fall back to hcitool
      return fallbackToHcitool();
    }
  }
  throw error;
}
```

Key points:
1. ✅ Tries noble first (faster)
2. ✅ Detects state mismatch error
3. ✅ Verifies adapter is actually up
4. ✅ Falls back to hcitool
5. ✅ Continues transparently

---

## What You Should See

### With Your Fix Installed
In the logs during startup:
```
[gym-app] adapter hci0 is UP (verified via hciconfig); noble state is unknown
[gym-app] proceeding despite noble state mismatch
```

This shows:
✅ System detected the issue
✅ System handled it automatically
✅ No user action needed

---

## Troubleshooting Steps

### If Scan Still Doesn't Work

**Step 1**: Verify adapters are actually up
```bash
sudo hciconfig
```
Should show:
```
hci0:   Type: Primary  Bus: USB
        UP RUNNING
```

**Step 2**: Verify hcitool works
```bash
sudo hcitool -i hci0 lescan
# Should find nearby devices including your bike
```

**Step 3**: Check if Keiser bike is powered on and advertising
```bash
# Look for your Keiser in the scan output
# MAC should look like: CC:AA:BB:DD:EE:FF
# Name should show as: KEISER_XXXX
```

**Step 4**: Restart Bluetooth service
```bash
sudo systemctl restart bluetooth
sleep 2
sudo hciconfig
```

---

## Summary

| State | What noble sees | What's actually true | What app does |
|-------|---|---|---|
| Working perfectly | poweredOn | UP RUNNING | Scans immediately with noble |
| Your situation | unknown | UP RUNNING | Falls back to hcitool, continues |
| Actual error | unknown | DOWN | Error, stops |

**You're in the middle row** - this is handled gracefully.

The logs showing "state is unknown" **does not mean broken** - it means the app is working around a BlueZ quirk on Raspberry Pi.

---

## Next Steps

1. **Make sure adapters are up**:
   ```bash
   sudo hciconfig hci0 up
   sudo hciconfig hci1 up
   ```

2. **Verify hcitool finds your bike**:
   ```bash
   sudo hcitool -i hci0 lescan
   ```
   (Look for your Keiser's MAC address)

3. **Run the test again**:
   ```bash
   timeout 30 node src/app/cli.js --bike=keiser 2>&1
   ```
   (Pedal bike during test)

4. **If still nothing**, check:
   - Is the bike powered on?
   - Is Bluetooth enabled on the bike?
   - Are you close enough to the bike (5-10 feet)?

