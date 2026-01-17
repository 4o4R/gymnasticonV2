# Original Gymnasticon (ptx2) Research & Architecture Analysis

## 1. Hardware & OS Support

### Tested Platforms
**Recommended:**
- **Raspberry Pi Zero W** - PRIMARY RECOMMENDATION (best user experience)

**Also Tested:**
- Raspberry Pi 3B+
- Raspberry Pi 4
- macOS 10.14+
- Debian Buster on x86-64
- Ubuntu 18.04+ on x86 hardware (with external BLE adapters)

### OS Versions
- Raspbian Buster (primary)
- Raspbian Bookworm (newer versions)
- Stock Pi OS images (with modifications for read-only overlay filesystem)

### Key Hardware Requirements

**Bluetooth Adapter Requirements:**
1. **Single Adapter Mode (Multi-role capable):**
   - BLE 4.1+ adapter with **multi-role capability** required
   - All Raspberry Pi devices have multi-role capability built-in
   - Allows same adapter to: connect to bike + advertise to apps simultaneously

2. **Dual Adapter Mode (For BLE 4.0 devices):**
   - Two BLE 4.0+ adapters can work together
   - One adapter (hci0): connects to bike (client role)
   - Second adapter (hci1): receives app connections (server role)
   - Cheaper option but requires additional USB adapter

**Critical Note from README:**
> "If using a Bluetooth LE bike (e.g. Flywheel) a Bluetooth LE 4.1+ adapter with multi-role capability is required... Alternatively, two BT 4.0+ adapters can also work: one for the client (to connect to the bike) and one for the server (to receive connections from Zwift or another app)."

### Bikes Tested
- Flywheel Home Bike
- Peloton Bike (with passive wiring)
- Schwinn IC4 / IC8 (Bowflex C6)
- Keiser M Series (M3i, M3i-TBT, M3iX)
- LifeFitness IC5

---

## 2. Bluetooth Architecture

### Original Single-Adapter Architecture (Preferred)
```
Bike Device (BLE Client)
        ↓
[Yoga Adapter (hci0) - Multi-role]
        ↑
App Device (BLE Server)
```

**Design Strategy:**
- Uses **bleno** library for BLE server (advertising to apps)
- Uses **noble** library for BLE client (connecting to bike)
- BOTH libraries operate on the SAME adapter (`hci0` default)
- Adapter switches between roles as needed (multi-role capability)

### Dual-Adapter Architecture (Fallback)
```
Bike Device      App Device
     ↓                ↓
[Client Adapter] [Server Adapter]
(hci0)           (hci1)
```

**Command-line Configuration:**
```bash
--bike-adapter hci0      # Connect to bike via hci0
--server-adapter hci1    # Advertise to apps via hci1
```

### Connection Flow (app.js)
1. **Initialization:**
   - Create BikeClient (noble) → connects to bike
   - Create GymnasticonServer (bleno) → advertises to apps
   - Create AntServer → optional ANT+ stick support

2. **Data Flow:**
   ```
   Bike Stats (power, cadence)
        ↓
   BikeClient.onBikeStats()
        ↓
   GymnasticonServer.updateMeasurement()
        ↓
   CyclingPowerService + CyclingSpeedAndCadenceService
        ↓
   Notify all connected apps
   ```

3. **Parallel Servers:**
   - BLE Server (Bleno) - GATT services for apps
   - ANT+ Server (optional) - Separate protocol for Garmin devices

### Supported BLE Services (Server-side)
1. **CyclingPowerService** - Power (watts) measurements
2. **CyclingSpeedAndCadenceService** - RPM + wheel speed data

---

## 3. Key Issues & Patterns from GitHub

### Issue #55: Noble Interface Race Condition 🔴 CRITICAL
**Type:** Bluetooth State Management Bug  
**Severity:** High - crashes application  
**Description:** Race condition when client disconnects while server sends data
```
noble warning: unknown handle 64 disconnected!
noble: unknown peripheral 742558933534 connected!
TypeError: Cannot set property 'mtu' of undefined
  at Noble.onMtu (/noble/lib/noble.js:564:18)
```

**Root Cause:** Noble tries to operate on a peripheral not in its internal list when:
- Client device connects while updating MTU
- Client disconnects and immediately reconnects
- Server attempts to handle MTU event on disconnected peripheral

**Original Mitigation:** Relied on systemd restart (not ideal)  
**Noble PR:** abandonware/noble#165 addresses this  
**V2 Design Impact:** Need robust error handling around noble events

### Issue #99: Multiple BLE Output (Dual Adapter Request) 🔶 FEATURE REQUEST
**Type:** Multi-device support  
**Status:** Open, unresolved in original  
**Description:** Users want to connect to Apple Watch + Zwift simultaneously
```
Need: Two independent BLE outputs at same time
Solution: Use two adapters (one for each connection)
```

**Original Limitation:** Not implemented in original codebase  
**4o4R (V2 Author) Note:** "I think I have addressed this issue" (Nov 2025)

### Issue #95: IC4 Disconnects Immediately After Connecting 🔴 CRITICAL
**Type:** Connection Stability  
**Hardware Factor:** Realtek BLE adapters (not all multi-role compatible)
**Symptoms:**
- Connection succeeds once, then drops
- Only affects some Bluetooth adapters
- Rebooting helps temporarily

**Resolution:** Use compatible BLE 4.1+ adapter with true multi-role support  
**Problematic Adapters:**
- Realtek (generic) - inconsistent multi-role support
- Some cheap USB dongles - missing multi-role capability

**Recommended Adapters:**
- Raspberry Pi onboard BT (guaranteed multi-role)
- Broadcom BCM20702A1 (verified working)

### Issue #94: Can't Connect Zwift to Gymnasticon 🔶 MODERATE
**Type:** Server Advertisement Issue  
**Symptoms:**
- Bike connects fine to Gymnasticon
- Zwift sees "Flywheel 1" (bike) but NOT "Gymnasticon" (server)
- Calibration app works fine

**Root Causes Identified:**
1. **Android Permissions:** Zwift requires LOCATION permission (not just NEARBY_DEVICES)
2. **Bluetooth Pairing:** User paired Gymnasticon in system settings instead of within app (wrong approach)
3. **Hardware Failure:** Some Pi 4s had failing Bluetooth hardware

**Key Learning:** Advertisement isn't a network broadcast—it only appears to devices actively scanning, and some apps have strict permission requirements.

### Issue #87: No Power Metrics, Only Cadence 🔶 MODERATE
**Type:** Incomplete Sensor Data  
**Symptoms:** Zwift shows cadence but no power
**Common Causes:**
1. **Low Bike Batteries** - Flywheel needs fresh D batteries
2. **Missing Calibration** - Bike must be calibrated before measuring power
3. **Garmin BLE Limitation** - Forerunner only supports cadence via BLE (power requires ANT+)
4. **BLE CSC Profile Bug** - Garmin support for CPS (Cycling Power Services) is buggy per issue comments

**Key Learning:** Different apps/devices have different profile support. Garmin watches prefer ANT+ for power.

### Summary of 5 Key Issues
1. ✅ **#55 - Noble Race Condition** → BLE state management fragility
2. ✅ **#99 - Dual BLE Output** → Need multi-adapter support architecture
3. ✅ **#95 - IC4 Instant Disconnect** → Adapter quality matters significantly
4. ✅ **#94 - Zwift Advertisement Invisible** → Permission/scanning issues
5. ✅ **#87 - Power Missing** → Battery/calibration/protocol incompatibilities

---

## 4. Multi-Sensor Support

### Original Architecture
**Single Primary Bike Connection:**
```javascript
// From app.js initialization
createBikeClient(options)  // ONE bike client via noble
createAntStick()           // OPTIONAL ANT+ for Garmin
```

**BLE Services Advertised (bleno server):**
```javascript
[
  new CyclingPowerService(),           // Power (watts)
  new CyclingSpeedAndCadenceService()  // Cadence (RPM) + Speed
]
```

### Multi-Sensor Implementation
The original supports:
1. **Power Sensor** - From bike (Flywheel, IC4, Keiser, etc.)
2. **Cadence Sensor** - From bike (all bikes provide)
3. **Heart Rate** - NOT implemented in original (feature request #67 still open)
4. **Speed Sensor** - Simulated from cadence + wheel circumference

### Data Flow for Multiple Metrics
```
BikeClient.onBikeStats()
  ↓
  power = extracted from bike protocol
  cadence = extracted from bike protocol
  ↓
GymnasticonServer.updateMeasurement({ power, crank })
  ↓
forEach(service):
    service.updateMeasurement(measurement)
  ↓
CyclingPowerService.notify()
CyclingSpeedAndCadenceService.notify()
```

### Parallel Startup Strategy in Original
**Sequential initialization (NOT parallel):**
1. Initialize BLE client (noble)
2. Initialize BLE server (bleno) 
3. Initialize ANT+ stick (optional)
4. Wait for bike connection before processing
5. Wait for stats before operating

**Timeouts configured:**
- `bikeConnectTimeout`: 0 (no timeout, wait indefinitely)
- `bikeReceiveTimeout`: 4 seconds
- `serverPingInterval`: 1 second (keep-alive to app)

---

## 5. State Initialization & Lifecycle

### Original State Management Pattern (app.js)
```javascript
class Gymnasticon {
  constructor(options) {
    // Create clients/servers
    this.bikeClient = createBikeClient(options)
    this.server = new GymnasticonServer(...)
    this.antServer = new AntServer(...)
    
    // Attach event handlers
    this.bikeClient.on('stats', this.onBikeStats.bind(this))
    this.bikeClient.on('disconnect', this.onBikeDisconnect.bind(this))
    this.server.on('error', this.onServerError.bind(this))
  }
  
  async start() {
    // Sequential startup
    this.bikeClient.start()
    this.server.start()
    this.startAnt()
    // Wait for bike connection before considering "ready"
  }
}
```

### Event-Driven Architecture
**Bike Connection Flow:**
```
bikeClient.start()
    ↓
bikeClient.onStateChange('powered')  // Noble initialization
    ↓
bikeClient.onDiscover(peripheral)    // Scanning...
    ↓
bikeClient.onConnect()               // Connection established
    ↓
bikeClient.onStats(power, cadence)   // Data flowing
```

### Critical State Transitions
1. **INIT** → Start noble, bleno, optional ANT
2. **SCANNING** → Noble scans for bike (auto-detect or target MAC)
3. **CONNECTING** → Noble initiates connection to bike
4. **CONNECTED** → Bike connected, waiting for stats
5. **STREAMING** → Receiving stats from bike, forwarding to apps
6. **ERROR** → Graceful degradation (systemd restart)

### Timeout Behavior
- **Bike Connection Timeout:** Configurable; default 0 (forever)
- **Bike Stats Timeout:** 4 seconds (if no stats → exit process)
- **Server Ping Interval:** 1 second (keep advertising to apps)

### Graceful Shutdown Handlers
```javascript
process.on('SIGINT', () => { /* cleanup */ })
bikeClient.on('disconnect', () => process.exit(0))
bikeClient.on('statsTimeout', () => process.exit(0))
```

---

## 6. Design Decisions & Patterns

### Why Original Design Made These Choices

| Design Element | Original | Reasoning |
|---|---|---|
| Single primary bike | ✅ Only one | Most users have one bike, simplifies architecture |
| Event-driven (node EventEmitter) | ✅ | Async BLE operations require event-based flow |
| Sequential startup | ✅ | Ensures dependencies ready before accepting connections |
| Process exit on bike disconnect | ✅ | Simpler than complex recovery; systemd restarts |
| Multi-role single adapter (preferred) | ✅ | Fewer USB devices needed; simpler deployment |
| Dual adapter fallback | ✅ Documented | For BLE 4.0-only hardware |
| ANT+ optional | ✅ | Garmin users benefit; others don't need it |
| Bike client = noble (upstream) | ✅ | abandonware/noble most stable BLE client lib |
| Server = bleno (upstream) | ✅ | abandonware/bleno for GATT server |

### Known Architectural Limitations

1. **Noble Race Conditions** (#55)
   - Race between client disconnect and server MTU update
   - No built-in recovery—process crash required

2. **Single Bike Only**
   - Can't aggregate multiple bike sensors
   - Feature request for gym multi-bike scenarios

3. **No Heart Rate Support**
   - Original doesn't expose HR sensor (feature request #67)
   - Potential for external HR sensors via new bike client

4. **Limited Error Recovery**
   - Prefers "fail fast" (exit process)
   - Systemd dependency for reliability

5. **Adapter Quality Critical**
   - BLE 4.0-only adapters problematic
   - Some Realtek adapters have buggy multi-role
   - No runtime detection of adapter capability

---

## V2 Design Recommendations Based on Research

### High Priority Fixes (V2 Should Address)

1. **Robust BLE State Management**
   - Validate adapter multi-role capability at startup
   - Implement peripheral tracking to prevent #55 race condition
   - Add error recovery instead of process exit

2. **Multi-Adapter Support** (addresses #99)
   - Formalize adapter selection in code
   - Support truly parallel BLE client + server on different adapters
   - Auto-detect available adapters and verify capabilities

3. **Connection Resilience** (addresses #95)
   - Implement retry logic for bike connection
   - Detect and warn about incompatible adapters
   - Don't exit on client disconnect—auto-reconnect

4. **Multi-Sensor Architecture**
   - Support multiple bike clients (future)
   - Framework for heart rate, speed sensors as separate inputs
   - Parallel initialization with dependency tracking

5. **Hardware Detection**
   - Detect BLE adapter version/capabilities at startup
   - Warn if using known-problematic hardware
   - Provide user-friendly error messages

### Code Quality Improvements

1. **Error Handling**
   - Catch noble errors gracefully (don't crash on MTU race)
   - Validate events before processing
   - Add try-catch around async BLE operations

2. **Logging**
   - Current uses `debug` module (good)
   - Add health-check logging for troubleshooting
   - Track state transitions explicitly

3. **Testing**
   - Original has no multi-sensor integration tests
   - V2 multi-sensor-integration.mjs exists (good!)
   - Should test adapter detection and fallback

---

## Summary: Critical Design Insights

### The Original Architecture is:
- ✅ **Elegant:** Single-adapter multi-role is cleaner than dual-adapter
- ⚠️ **Fragile:** Noble race conditions can crash entire app
- ⚠️ **Simple:** Lacks recovery logic, multi-sensor coordination
- ✅ **Proven:** Works well for single-bike + single-app use case
- ❌ **Limited:** No built-in multi-bike or advanced sensor support

### V2 Should Achieve:
1. **Same elegance** with better error handling
2. **Dual-adapter support** as first-class feature (not fallback)
3. **Parallel startup** with dependency injection pattern
4. **Health monitoring** and auto-recovery
5. **Multi-sensor framework** for future expansion
6. **Hardware detection** to fail gracefully early

### Key Technical Debt in Original:
1. **Noble fragility** → needs wrapping/validation
2. **No middle layer** between bike+server logic
3. **Event handler chaos** → scattered across app.js
4. **No adapter detection** → user must specify manually
5. **Process-exit-on-error** pattern → poor reliability

---

## Useful File References

| File | Purpose |
|---|---|
| `src/app/app.js` | Main orchestration (198 lines) |
| `src/bikes/base.js` | BikeClient base class |
| `src/servers/ble/index.js` | GymnasticonServer (BLE GATT) |
| `src/servers/ant/index.js` | ANT+ server |
| `src/util/ble-server.js` | Bleno wrapper |
| `src/util/noble-wrapper.js` | Noble wrapper (partial) |
| `src/util/metrics-processor.js` | Power/cadence processing |
| `deploy/gymnasticon.service` | Systemd unit file |

---

**Research Date:** January 17, 2026  
**Original Repository:** https://github.com/ptx2/gymnasticon  
**V2 Repository:** https://github.com/4o4R/gymnasticonV2
