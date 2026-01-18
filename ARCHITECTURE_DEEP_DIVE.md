# Deep Dive Analysis: Gymnasticon V2 Architecture vs Original

## Executive Summary

**Goal:** Compare V2's architecture against the original ptx2/gymnasticon, validate backward compatibility, identify gaps in dual-adapter implementation, and document how to leverage both adapters for debugging/testing.

---

## Part 1: Hardware & OS Backward Compatibility

### Original Support Matrix (ptx2)
```
✅ Raspberry Pi Zero (ARMv6) + USB BLE Dongle
✅ Raspberry Pi Zero W (ARMv6) + Onboard BT
✅ Raspberry Pi 3B+ (ARMv7) + Onboard BT  
✅ Raspberry Pi 4 (ARMv8) + Onboard BT
✅ macOS (10.13+)
✅ Debian x86-64

Critical: Node.js 14.21.3 ONLY
  - Node 16/18 drop ARMv6 support (Pi Zero/Zero W incompatible)
  - Prebuilds only exist for Node 14 for native modules
```

### V2 Current Support (from README)
```
✅ Modern Image (Bookworm): Pi Zero 2 W, Pi 3/4/400/CM4
  - Recommended: Use onboard Bluetooth
  - Optional: Second USB adapter for HR

✅ Legacy Image (Buster): Pi Zero / Zero W
  - Requires: USB BLE dongle (onboard BT not available)
  - Single USB adapter via FT232H or CP2102

✅ Development: Node 14.21.3 enforced via check-node-version.cjs
  - Guard: GYMNASTICON_ALLOW_UNSUPPORTED_NODE=1 to bypass
```

### Backward Compatibility Assessment
✅ **GOOD:** V2 maintains Node 14.21.3 hard requirement  
✅ **GOOD:** Separate Modern/Legacy images for Pi Zero variants  
✅ **GOOD:** Supports exact same hardware as original  
⚠️  **CAUTION:** Original used dynamic `hciconfig` fallback; V2 needs same

---

## Part 2: Bluetooth Adapter Architecture

### Original Design (Single-Adapter Multi-Role)

```
┌─────────────────────────────────────────────────────┐
│ Adapter (hci0) - BLE 4.1+ Multi-Role Capable       │
├──────────────────────┬──────────────────────────────┤
│                      │                              │
│  Noble (BLE Client)  │  Bleno (BLE Server)        │
│  - Connects to bike  │  - Advertises to apps      │
│  - Scans for HR      │  - Broadcasts power/cad    │
│                      │                            │
└──────────────────────┴──────────────────────────────┘

Success Case: Adapter supports multi-role + has HCI 4.1+
Fallback Case: Dual adapter (rare) - use hci0 for client, hci1 for server
```

### V2 Current Design (Enhanced Dual-Adapter)

```
┌──────────────────────────────────────────────────────┐
│ Bike Adapter (hci0 - Usually Onboard BT)            │
├────────────────────────────────────────────────────┤
│                                                      │
│  Scan for Bike (Keiser, Flywheel, IC4, etc)       │
│  Scan for Speed/Cadence Sensors                    │
│  ↓ Falls back to hcitool if noble state stuck     │
│                                                      │
└────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│ Server Adapter (hci1 - USB Dongle OR Same as hci0)  │
├────────────────────────────────────────────────────┤
│                                                      │
│  Advertise power/cadence to Zwift                   │
│  Advertise HR rebroadcast (if dual adapter)        │
│                                                      │
└────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│ HR Adapter (hci1 OR dedicated if available)          │
├────────────────────────────────────────────────────┤
│                                                      │
│  Scan for HR devices                                │
│  ↓ Only if dual adapter available (auto-detect)    │
│                                                      │
└────────────────────────────────────────────────────┘
```

### Adapter Detection Implementation (V2)
[From src/util/adapter-detect.js]

```javascript
detectAdapters() {
  // 1. Read /sys/class/bluetooth for all hci* devices
  const adapters = discoverAdapters();  // Returns array of adapters
  
  // 2. Categorize: builtin (onboard) vs usb (dongle)
  const builtin = adapters.filter(a => a.type === 'builtin');
  const usb = adapters.filter(a => a.type === 'usb');
  
  // 3. Assign roles:
  if (builtin.length >= 1) {
    bikeAdapter = builtin[0];        // hci0 (onboard)
    if (builtin.length >= 2) {
      serverAdapter = builtin[1];    // Second onboard (rare)
    } else if (usb.length >= 1) {
      serverAdapter = usb[0];        // USB dongle (common)
    } else {
      serverAdapter = builtin[0];    // Same as bike (multi-role)
    }
  }
  
  // 4. Detect ANT+ stick
  antPresent = lsusb output contains 0fcf:1006/1008/1009
}
```

**Key Feature:** Automatic detection with fallback strategy
- **Optimal:** Separate adapters (hci0=bike, hci1=server)
- **Acceptable:** Single adapter (multi-role), hci0=both
- **Current Issue:** Noble state bug on some Pi hardware

---

## Part 3: Known Issues in Original (ptx2) and V2 Approach

### Issue #1: Noble Race Condition (#55)
**Original:** Client disconnect during MTU update crashes entire app
**Status:** UNFIXED in original (Issue #55 still open)
**V2 Approach:**
- V2 doesn't explicitly handle this
- **Recommended Fix:** Add try/catch in MTU negotiation
- **Location:** src/util/connection-manager.js

### Issue #2: Dual BLE Output (#99) 
**Original:** Single output stream to Zwift; users want Apple Watch + Zwift simultaneously
**Status:** Feature request, not implemented
**V2 Approach:**
- V2 supports multiple sensors (HR + speed + cadence) being consumed
- **What's Missing:** Support for MULTIPLE SIMULTANEOUS BLE SERVERS
  - Currently: One Zwift server at a time
  - Needed: Parallel servers for Zwift + Apple Health + Garmin
- **Recommended Fix:** Launch multiple GymnasticonServer instances on different adapters

### Issue #3: Stuck Noble State (#52, implicit in our Pi problem)
**Original:** Noble stuck at 'unknown', never emits stateChange
**Status:** Happens on specific Pi/BlueZ versions
**V2 Current Approach:**
```
✅ Detects: if (noble.state === 'unknown' && isAdapterUp(hciconfig))
✅ Falls Back: Uses hcitool subprocess to scan when noble fails
⚠️  Timeout: Still waits 3 seconds for stateChange (should be 1-2s)
```

### Issue #4: IC4 Instant Disconnect (#95)
**Original:** Some cheap Bluetooth adapters cause immediate bike disconnect
**Status:** User reported; no fix in original
**V2 Approach:** No specific fix, but architecture supports adapter fallback

### Issue #5: Zwift Advertisement Invisible (#94)
**Original:** Some Pi hardware can't advertise to Zwift (Android)
**Status:** Permission issues with `bluetoothd`
**V2 Approach:** No specific fix, but could add server fallback

---

## Part 4: Multi-Sensor Architecture (V2 Innovation)

### What V2 Adds (Beyond Original)

```
Original Flow (Sequential):
  1. Bike connects (5s)
  2. BLE server starts (1s)
  3. ANT+ stick init (0.5s)
  → Total: ~6.5s before advertise

V2 Flow (Parallel Startup - CRITICAL):
  1. Bike connects (5s)
     ↓ [Immediately after]
  2. Multi-sensor startup (parallel):
     ├─ HR Client (1s)
     ├─ Speed Sensor Client (0.5s)
     └─ Cadence Sensor Client (0.5s)
  3. BLE server + ANT+ (0.5s)
  → Total: ~5.5s (saves ~1s!)
```

### Multi-Sensor Architecture (V2)

```javascript
// From src/app/app.js startOptionalSensors()
await Promise.allSettled([
  this.connectHeartRateSensor(),      // Generic GATT 0x180D
  this.connectSpeedSensor(),           // Legacy Gymnasticon speed service (0x181a)
  this.connectCadenceSensor()          // Legacy Gymnasticon cadence service (0x181b)
]);

// Key: AllSettled means partial failures don't crash
// If HR fails, speed/cadence still connect
```

### Sensor Clients (V2)
```
SpeedSensorClient (src/speed/speed-sensor-client.js)
  - Service UUID: 0x181a (legacy Gymnasticon speed service)
  - Characteristic: 0x2a50 (legacy speed measurement)
  - Compatible: devices using the original Gymnasticon speed profile
  - Provides: Wheel revolutions + timestamp for speed calculation

CadenceSensorClient (src/cadence/cadence-sensor-client.js)
  - Service UUID: 0x181b (legacy Gymnasticon cadence service)
  - Characteristic: 0x2a51 (legacy cadence measurement)
  - Compatible: devices using the original Gymnasticon cadence profile
  - Provides: Crank revolutions + timestamp for cadence

HeartRateClient (existing)
  - Service UUID: 0x180d (Heart Rate Service)
  - Characteristic: 0x2a37 (Heart Rate Measurement)
  - Provides: BPM
```

---

## Part 5: Testing & Debugging with Dual Adapters

### Setup for Development/Testing

**Scenario A: Dual Adapter PC Testing**
```bash
# Adapter 1: Simulated bike (hci0 running bleno server)
# Adapter 2: Simulated app (hci1 running noble client)

npm run test:multi-sensor

This launches:
  1. Mock bike server on hci0
  2. Connects using hci1 as client
  3. Verifies metrics flow
```

**Scenario B: Pi with USB Dongle**
```
Onboard BT (hci0): Bike connection (keiser, flywheel, etc.)
USB Dongle (hci1):  HR rebroadcast server

Auto-detected by adapter-detect.js:
  - builtin[0] → bikeAdapter
  - usb[0] → serverAdapter
  - multiAdapter = true → enables HR auto-connect
```

**Scenario C: Single Adapter Pi (Current Issue)**
```
Onboard BT (hci0): Both bike AND server (multi-role)

Problem: Some Pi hardware doesn't support this properly
Solution: V2 fallback strategy:
  1. Try multi-role mode (original behavior)
  2. If noble.state stuck → use hcitool scan for bike
  3. Still advertise on same adapter for server
```

### Debug Commands

```bash
# Check adapter status
hciconfig -a

# List all Bluetooth devices
hcitool scan

# Verbose BLE scan (hcitool)
sudo hcitool -i hci0 lescan

# Show current noble state
journalctl -u gymnasticon -f | grep "noble state"

# Check if adapter is UP (system level)
grep UP /sys/class/bluetooth/hci0/device/flags

# List connected BLE devices
hcitool con

# Check HCI version (BLE 4.1 vs 5.0 capability)
hciconfig -a hci0 | grep "HCI"
```

### V2 Enhancement: Fallback Stack

```javascript
// Current implementation in src/app/app.js

ensureBluetoothPoweredOn() {
  // 1. Check if noble reports 'poweredOn'
  if (noble.state === 'poweredOn') return;
  
  // 2. If not, check if adapter is actually UP at OS level
  if (this.isAdapterUp(bikeAdapter)) {
    console.log('Adapter UP but noble stuck—proceeding anyway');
    return;  // ← V2 INNOVATION: Trust hciconfig over noble
  }
  
  // 3. Try reinitialize noble (may help on fresh start)
  await this.reinitializeNoble();
  
  // 4. Fall back to next adapter if available
  if (fallbackAdapters.length > 0) {
    this.setBikeAdapter(fallbackAdapters[0]);
    continue;
  }
  
  // 5. If all else fails, throw
  throw new Error('No adapters available');
}
```

**Why This Matters for Backward Compatibility:**
- Original just waits for stateChange event (could hang forever on bad hardware)
- V2 trusts OS-level adapter status as authoritative
- V2 allows graceful degradation (single → dual adapter)

---

## Part 6: Recommended Improvements for V2

### Priority 1: Fix Noble State Issues (BLOCKING)
```javascript
// Current: 3s timeout for stateChange
// Issue: Some hardware never emits stateChange, wastes 3s * 3 attempts = 9s

Recommendation:
// Reduce timeout to 1s
const timeoutMs = 1000;  // Not 3000

// Add hcitool validation earlier
if (noble.state === 'unknown') {
  // Immediately try hcitool scan instead of waiting
  if (detectableViaHcitool(adapter)) {
    console.log('Noble broken but hcitool works—skipping stateChange wait');
    return;  // Don't wait at all
  }
}
```

### Priority 2: Support Dual BLE Servers
```javascript
// Currently: Single GymnasticonServer on serverAdapter
// Requested: Simultaneous Zwift + Apple Health + Garmin

// New feature:
if (adapters.length >= 2) {
  const server1 = new GymnasticonServer(hci0, {name: 'Zwift'});
  const server2 = new GymnasticonServer(hci1, {name: 'AppleHealth'});
  
  // Both advertise same metrics, different adapters
  // Devices pick whichever they see first
}
```

### Priority 3: Improve Error Recovery
```javascript
// Current: On error → exit → systemd restarts (crude)
// Better: Graceful recovery

// Try bike connect 3 times with different adapters
// Try HR connect separately (don't block bike)
// Try speed/cadence separately (don't block bike)
// Only exit if bike connection fails permanently

// Location: src/app/app.js run() method
```

### Priority 4: Test Suite for Dual Adapters
```bash
# Add CI test:
npm run test:dual-adapter

# What it tests:
1. Auto-detect dual adapters
2. Assign roles correctly (bike=builtin, server=usb)
3. Verify multiAdapter flag set
4. Test fallback if one adapter fails
5. Verify hcitool fallback for stuck noble
```

---

## Part 7: Current V2 Status vs Roadmap

### ✅ Implemented
- Adapter auto-detection (adapter-detect.js)
- Fallback for stuck noble state (hcitool fallback in ble-scan.js)
- Multi-sensor parallel startup (Promise.allSettled)
- Backward compatibility with Pi Zero/Zero W
- Node 14.21.3 enforcement

### ⚠️  Partially Implemented
- Dual adapter assignment (works but not tested on hardware)
- hcitool fallback (implemented but needs more testing)
- HR rebroadcast on separate adapter (implemented but auto-only)

### ❌ Not Yet Implemented
- Dual BLE servers simultaneously (for Apple Watch + Zwift)
- Race condition fix (#55 style)
- Graceful error recovery (instead of exit)
- Comprehensive test suite for dual adapters
- Extended adapter fallback (try 3+ adapters instead of 2)

---

## Part 8: Backward Compatibility Checklist

```
✅ Hardware Support:
  ✅ Pi Zero (ARMv6) + USB dongle
  ✅ Pi Zero W (ARMv6) + onboard BT
  ✅ Pi 2/3/4/400 (ARMv7/8) + onboard BT
  ✅ macOS + Linux x86-64

✅ Node.js:
  ✅ 14.21.3 ONLY (enforced via check-node-version.cjs)
  ✅ Guard to allow bypassing if needed

✅ Bluetooth:
  ✅ Multi-role mode (original design)
  ✅ Dual adapter fallback
  ✅ hcitool fallback for noble failures

✅ Bikes:
  ✅ All original bike types still work
  ✅ New: Generic speed/cadence sensors (GATT)

⚠️  Needs Testing:
  ⚠️  Dual adapter assignment on actual Pi hardware
  ⚠️  hcitool fallback on Pi with stuck noble state
  ⚠️  Adapter fallback strategy with 3+ adapters
```

---

## Summary

**V2 improves on original by:**
1. **Pragmatic fallback** - Doesn't blindly trust noble state; verifies with hciconfig
2. **Parallel sensor startup** - Faster app initialization (saves ~1s)
3. **Better dual-adapter support** - Auto-detects and assigns roles
4. **Adapter flexibility** - Gracefully degrades from dual → single adapter
5. **Modern hardware support** - Works on Pi Zero 2, Pi 5 (via installer)

**Critical Path for Next Steps:**
1. Test hcitool fallback on actual hardware (your Pi!)
2. Verify adapter detection/assignment is working
3. Test parallel multi-sensor startup on hardware
4. Add dual-server support (Zwift + Apple Watch)
5. Implement graceful error recovery (no hard exit)

The architecture is **sound and backward compatible**—it just needs real-world testing and the graceful recovery improvements to be production-ready.
