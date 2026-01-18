# Expected Log Output: Verification Guide

This document shows what you should see in the logs to verify all three fixes are working.

---

## Test Scenario 1: Single Adapter, Normal Connection

### Command
```bash
node src/app/cli.js --bikeAdapter hci0 --serverAdapter hci1
```

### Expected Log Output
```
[gym-app] Starting Gymnastic IC4 mode with Bluetooth connection
[gym-app] BLE server adapters: hci1
[gym-app] starting BLE server (from CLI)
[gym-app] BLE server advertising

[adapter-detect] Scanning for IC4 on hci0...
[ble-scan] Found IC4: IC4_8A7C at address c4:ef:51:12:8a:7c
[bikes] Creating IC4 bike instance

[connection-manager] Attempting connection to IC4_8A7C
[connection-manager] Connected successfully

[ic4] Initializing bike... ✓
[gym-app] IC4 connected, starting metrics stream
```

### What This Shows
✅ All components initialized
✅ Single adapter for server (hci1)
✅ Connection successful on first attempt (no retry needed)

---

## Test Scenario 2: IC4 Adapter with Retry (Testing #95)

### Command
```bash
node src/app/cli.js --bikeAdapter hci0 --serverAdapter hci1
```

### Expected Log Output (when IC4 disconnects midway)
```
[ble-scan] Found IC4: IC4_8A7C at address c4:ef:51:12:8a:7c
[connection-manager] Attempting connection to IC4_8A7C

[connection-manager] ⚠ Peripheral disconnected during connection attempt
[connection-manager] Retry 1/3 after 96ms backoff

[connection-manager] Attempting connection to IC4_8A7C
[connection-manager] ℹ MTU update skipped: Insufficient privileges

[connection-manager] Connected successfully
[ic4] Initializing bike... ✓
```

### What This Shows
✅ **#55 Fixed**: Disconnect listener caught the disconnection
✅ **#95 Fixed**: Exponential backoff (96ms calculated with ±20% jitter)
✅ **#55 Fixed**: MTU failure handled gracefully (non-fatal)
✅ Connection succeeded after retry

---

## Test Scenario 3: Dual Adapter Output (Testing #99)

### Command
```bash
node src/app/cli.js --bikeAdapter hci0 --serverAdapter hci1 --serverAdapter hci2
```

### Expected Log Output
```
[gym-app] Starting Gymnastic IC4 mode with Bluetooth connection
[gym-app] BLE server adapters: hci1, hci2
[gym-app] configuring multi-role (1 adapter, 2 servers, 2 controllers)
[gym-app] starting BLE server (from CLI)
[gym-app] BLE server advertising on hci1
[gym-app] BLE server advertising on hci2

[adapter-detect] Scanning for IC4 on hci0...
[ble-scan] Found IC4: IC4_8A7C at address c4:ef:51:12:8a:7c
[bikes] Creating IC4 bike instance
[connection-manager] Connected successfully

[ic4] Initializing bike... ✓
[gym-app] IC4 connected, starting metrics stream

[metrics-processor] HR: 82 bpm
[ble-server-hci1] Broadcasting HR: 82 bpm
[ble-server-hci2] Broadcasting HR: 82 bpm

[metrics-processor] Power: 145 W
[ble-server-hci1] Broadcasting power: 145 W
[ble-server-hci2] Broadcasting power: 145 W
```

### What This Shows
✅ **#99 Working**: Multiple adapters listed (hci1, hci2)
✅ **#99 Working**: Both servers advertising
✅ **#99 Working**: Metrics sent to both adapters

---

## Test Scenario 4: Adapter Fallback on Failure (Testing #99)

### Command
```bash
node src/app/cli.js --bikeAdapter hci0 --serverAdapter hci1 --serverAdapter hci2
```

### Expected Log Output (if hci1 fails to start)
```
[gym-app] BLE server adapters: hci1, hci2
[gym-app] starting BLE server (from CLI)

[ble] failed to start server on hci1: Device not found
[gym-app] BLE server advertising on hci2

[metrics-processor] HR: 82 bpm
[ble-server-hci2] Broadcasting HR: 82 bpm
```

### What This Shows
✅ **#99 Working**: One adapter failure doesn't stop the app
✅ **#99 Working**: Remaining adapter continues broadcasting

---

## Test Scenario 5: Connection Retry with Multiple Failures (Testing #95)

### Command
```bash
node src/app/cli.js --bikeAdapter hci0 --serverAdapter hci1
```

### Expected Log Output (with IC4 connection issues)
```
[ble-scan] Found IC4: IC4_8A7C at address c4:ef:51:12:8a:7c
[connection-manager] Attempting connection to IC4_8A7C

[connection-manager] ⚠ Peripheral disconnected during connection attempt
[connection-manager] Retry 1/3 after 98ms backoff

[connection-manager] Attempting connection to IC4_8A7C
[connection-manager] ⚠ Peripheral disconnected during connection attempt
[connection-manager] Retry 2/3 after 204ms backoff

[connection-manager] Attempting connection to IC4_8A7C
[connection-manager] Connected successfully
[ic4] Initializing bike... ✓
```

### What This Shows
✅ **#55 Fixed**: Each disconnect caught and logged
✅ **#95 Fixed**: Backoff increases: 98ms → 204ms (exponential)
✅ **#95 Fixed**: Jitter applied (variation of ±20%)
✅ Connection succeeded on third attempt

---

## Test Scenario 6: MTU Negotiation Success (Testing #55)

### Command
```bash
node src/app/cli.js --bikeAdapter hci0 --serverAdapter hci1
```

### Expected Log Output (with premium adapter supporting MTU)
```
[connection-manager] Attempting connection to IC4_8A7C
[connection-manager] Requesting MTU: 247
[connection-manager] MTU negotiated successfully: 247
[connection-manager] Connected successfully
[ic4] Initializing bike... ✓
```

### What This Shows
✅ **#55 Fixed**: MTU request attempted after connection stabilizes
✅ MTU negotiation succeeded (no error skipping)

---

## Test Scenario 7: MTU Negotiation Skip (Testing #55)

### Command
```bash
node src/app/cli.js --bikeAdapter hci0 --serverAdapter hci1
```

### Expected Log Output (with basic adapter not supporting MTU)
```
[connection-manager] Attempting connection to IC4_8A7C
[connection-manager] Requesting MTU: 247
[connection-manager] ℹ MTU update skipped: Insufficient privileges
[connection-manager] Connected successfully
[ic4] Initializing bike... ✓
```

### What This Shows
✅ **#55 Fixed**: MTU request attempted but error handled gracefully
✅ Connection continues even if MTU not supported
✅ This is expected and not an error

---

## Backoff Timing Examples

### Expected Backoff Delays (with jitter)

**Scenario: Exponential Strategy (default)**

```
Attempt 1: Success immediately
  └─ No retry needed

Attempt 1: Fail → Retry 1
  └─ After ~100ms ± 20ms (80-120ms)

Attempt 1: Fail → Attempt 2: Fail → Retry 2
  └─ After ~200ms ± 40ms (160-240ms)

Attempt 1: Fail → Attempt 2: Fail → Attempt 3: Fail → Retry 3
  └─ After ~400ms ± 80ms (320-480ms)

Attempt 1: Fail → Attempt 2: Fail → Attempt 3: Fail → Attempt 4: Fail → Retry 4
  └─ After ~800ms ± 160ms (640-960ms)
```

### Total Connection Time (Worst Case)
```
Retry 1:      ~100ms  (total: ~100ms)
Retry 2:      ~200ms  (total: ~300ms)
Retry 3:      ~400ms  (total: ~700ms)
Final timeout: 10000ms (total: ~10700ms max)
```

### What You'll See in Logs
```
[connection-manager] Retry 1/3 after 103ms backoff
[connection-manager] Retry 2/3 after 207ms backoff
[connection-manager] Retry 3/3 after 412ms backoff
[connection-manager] Max connection retries exceeded
```

---

## Diagnostic Commands

### Check if fixes are active
```bash
node verify-fixes.js
```

### Enable full debug logging
```bash
DEBUG=* node src/app/cli.js --bikeAdapter hci0 --serverAdapter hci1
```

### Check BLE adapters available
```bash
hcitool dev
```

### Check adapter status
```bash
hciconfig hci0
```

### Monitor real-time logs
```bash
node src/app/cli.js --bikeAdapter hci0 | grep -E "\[connection-manager\]|\[ble\]|\[retry\]"
```

---

## Summary of What to Look For

| Fix | Look For | Location |
|-----|----------|----------|
| #55 | "Peripheral disconnected during connection attempt" | Early in connection phase |
| #55 | "MTU update skipped:" | After initial connection |
| #95 | "Retry X/3 after Xms backoff" | When connection fails |
| #99 | "BLE server adapters: hci1, hci2" | During startup |
| #99 | "Broadcasting HR:" (multiple times) | During metrics phase |

---

## Troubleshooting Log Issues

### If you DON'T see retry messages
- Connection succeeded on first attempt (normal, expected)
- Retry logic only shows when needed

### If you see MTU warnings
- This is expected and normal
- MTU negotiation is optional
- Connection continues even if MTU fails

### If you see "Max connection retries exceeded"
- All three retry attempts failed
- Check if adapter is working: `hciconfig`
- Try restarting: `sudo systemctl restart bluetooth`

### If you see "No BLE adapters available"
- No adapters were successfully initialized
- Verify `--serverAdapter` argument is correct
- Check with `hcitool dev`

---

## Performance Indicators in Logs

### Good Performance Indicators
- ✅ Connection on first attempt
- ✅ Dual adapters both advertising
- ✅ Metrics flowing to both servers
- ✅ No MTU warnings

### Warning Signs
- ⚠️ Multiple retry attempts needed
- ⚠️ One adapter failing to start
- ⚠️ Frequent disconnects (not retry-related)

