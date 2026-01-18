# Quick Fix: hcitool Scan Failure (Input/output error & EALREADY)

## Problem
```
Set scan parameters failed: Input/output error
EALREADY, Operation already in progress (errno 114)
```

When noble scan fails and tries to fall back to hcitool:
1. Noble exits but doesn't fully release the adapter
2. hcitool tries to use the same adapter
3. Both noble and hcitool compete for the same device
4. Scan fails with "Input/output error" or "EALREADY" errors

## Root Cause
Noble's HCI socket isn't completely cleaned up when it exits, leaving the adapter in a conflicted state. When hcitool then tries to use it, the adapter can't set scan parameters.

## Solution
**Aggressively reset the adapter**: DOWN → RESET → UP

This completely releases all HCI bindings before hcitool tries to scan:

```bash
sudo hciconfig hci0 down      # Release all bindings
# wait
sudo hciconfig hci0 reset     # Reset hardware
# wait  
sudo hciconfig hci0 up        # Bring back clean
# wait for stabilization
# NOW hcitool can scan
```

## What Changed
**File**: `src/util/ble-scan.js`

Improved adapter reset in `scanWithHcitool()`:
```javascript
// Bring adapter DOWN to release all HCI bindings
execSync(`${sudoPrefix}hciconfig ${adapter} down`);
// Wait for cleanup
while (Date.now() - resetStart < 500) { /* spin */ }
// Reset hardware
execSync(`${sudoPrefix}hciconfig ${adapter} reset`);
// Wait again
while (Date.now() - resetStart < 1000) { /* spin */ }
// Bring back UP
execSync(`${sudoPrefix}hciconfig ${adapter} up`);
// Final wait
while (Date.now() - resetStart < 2500) { /* spin */ }
```

## Deploy This Fix

```bash
cd /opt/gymnasticon
git pull origin main
npm install --omit=dev

# Test - pedal bike when scan starts
timeout 30 node src/app/cli.js --bike=keiser 2>&1
```

Expected to see:
```
[ble-scan] ⚠ Noble state unknown but hci0 is UP; forcing state to poweredOn...
[ble-scan] ⚠ Noble scan failed...
[ble-scan] ⚠ Falling back to hcitool lescan...
[ble-scan] ⚠ Adapter reset sequence...
[keiser] Found Keiser: KEISER_XXXX at address XX:XX:XX:XX:XX:XX
[connection-manager] Attempting connection...
[connection-manager] Connected successfully
[metrics] Power: XXW Cadence: XXrpm
```

This fix resolves both "Input/output error" and "EALREADY" errors by ensuring noble completely releases the adapter before hcitool uses it.


