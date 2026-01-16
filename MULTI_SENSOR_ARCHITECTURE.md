# Multi-Sensor Architecture: Expansion Plan

## Current State (What's Implemented)

The Gymnastic system currently supports concurrent operation of:

1. **Bike Sensor** (mandatory)
   - Keiser M3i, Flywheel, Peloton, IC4, IC5, IC8, etc.
   - Provides: Power + Cadence
   - Auto-detected at startup

2. **Heart Rate Sensor** (optional)
   - Any device advertising HR Service 0x180D
   - Provides: Heart Rate (BPM)
   - Auto-detected at startup if enabled

3. **ANT+ Stick** (optional)
   - Broadcasts power + cadence via ANT+ protocol
   - For: Garmin Fenix, Wahoo Elemnt Bolt, other ANT+-only devices
   - Auto-detected if available and enabled

**Data Flow:**
```
Bike (power, cadence) 
  + HR Device (BPM) 
  + ANT+ Stick 
    → Combined metrics 
    → Broadcast via BLE 
    → Zwift receives all three data streams
```

---

## What Could Be Added (Extension Plan)

### Extension 1: Wahoo Speed Sensor

**Current Gap:** README doesn't mention speed sensors, but adding one would be useful.

**Implementation:** New file `src/speed/wahoo-speed-sensor.js`

```javascript
import {EventEmitter} from 'events';
import {scan} from '../util/ble-scan.js';
import {Timer} from '../util/timer.js';

export class WahooSpeedSensor extends EventEmitter {
  constructor(noble, options = {}) {
    super();
    this.noble = noble;
    this.deviceName = options.deviceName || 'Wahoo Speed';
    
    // Wahoo speed sensors advertise standard Cycling Speed Service
    this.serviceUuid = '181a';
    
    // Timeout configuration
    this.connectTimeout = options.connectTimeout || 30;
    this.statTimeout = options.statTimeout || 5000;
    
    // State tracking
    this.peripheral = null;
    this.characteristic = null;
    this.wheelRevolutions = 0;
    
    this.connectTimer = null;
    this.statTimer = null;
  }
  
  async connect() {
    console.log('[WahooSpeedSensor] Scanning for speed sensors...');
    
    // Use same scan logic as bike/HR
    this.peripheral = await scan(
      this.noble,
      [this.serviceUuid],
      (peripheral) => {
        return peripheral.advertisement.localName === this.deviceName ||
               peripheral.advertisement.serviceUuids?.includes(this.serviceUuid);
      },
      this.connectTimeout
    );
    
    if (!this.peripheral) {
      this.emit('connect-failed', 'Speed sensor not found');
      return;
    }
    
    console.log(`[WahooSpeedSensor] Found ${this.peripheral.advertisement.localName}`);
    
    await this.peripheral.connectAsync();
    
    // Discover and subscribe to speed characteristic
    const {characteristics} = await this.peripheral.discoverServicesAndCharacteristicsAsync();
    this.characteristic = characteristics.find(
      c => c.uuid === '2a48'  // Cycling Speed Measurement characteristic
    );
    
    if (this.characteristic) {
      this.characteristic.on('data', (data) => {
        this.parseWheelRevolutions(data);
      });
      await this.characteristic.subscribeAsync();
      this.emit('connected');
    }
    
    // Watchdog timer for disconnect detection
    this.statTimer = new Timer(
      () => {
        this.emit('disconnect-detected', 'Speed sensor not reporting');
        this.reconnect();
      },
      this.statTimeout,
      true  // repeating
    );
  }
  
  parseWheelRevolutions(data) {
    // Cycling Speed characteristic format:
    // Flags (1 byte) + Wheel Revolutions (4 bytes) + Last Event Time (2 bytes)
    if (data.length >= 7) {
      this.wheelRevolutions = data.readUInt32LE(1);
      
      // Emit speed in m/s
      // Speed = wheelRevolutions * wheelCircumference / time
      this.emit('stats', {
        wheelRevolutions: this.wheelRevolutions,
        // App layer will convert to speed using known wheel circumference
      });
    }
  }
  
  async disconnect() {
    if (this.statTimer) this.statTimer.clear();
    if (this.peripheral) await this.peripheral.disconnectAsync();
  }
  
  async reconnect() {
    await this.disconnect();
    setTimeout(() => this.connect(), 1000);
  }
}
```

**Integration into app.js:**

```javascript
// After heart rate client initialization
if (opts.speedSensorEnabled !== false) {
  this.speedSensor = new WahooSpeedSensor(this.noble, opts.speedSensorOptions);
  
  this.speedSensor.on('stats', (wheelData) => {
    // Override speed estimation with actual wheel data
    this.speed = this.estimateSpeed(wheelData.wheelRevolutions);
    this.server.updateCharacteristic('speed', this.speed);
  });
  
  this.speedSensor.on('connected', () => {
    this.logger.log('Speed sensor connected');
    this.healthMonitor.markConnected('speedSensor');
  });
  
  this.speedSensor.on('disconnect-detected', () => {
    this.speedSensor.reconnect();
  });
  
  this.speedSensor.connect();
}
```

**Testing:**
```bash
# With speed sensor paired:
node src/app/cli.js --bike keiser --speed-sensor-enabled

# Without speed sensor:
node src/app/cli.js --bike keiser
# Falls back to cadence-based estimation
```

---

### Extension 2: Wahoo Cadence Sensor

**Current Gap:** README doesn't mention cadence sensors, but adding one would be useful as backup.

**Implementation:** New file `src/cadence/wahoo-cadence-sensor.js`

```javascript
import {EventEmitter} from 'events';
import {scan} from '../util/ble-scan.js';

export class WahooCadenceSensor extends EventEmitter {
  constructor(noble, options = {}) {
    super();
    this.noble = noble;
    this.deviceName = options.deviceName || 'Wahoo Cadence';
    
    // Wahoo cadence sensors advertise standard Cycling Cadence Service
    this.serviceUuid = '181b';
    
    this.peripheral = null;
    this.characteristic = null;
    this.crankRevolutions = 0;
  }
  
  async connect() {
    console.log('[WahooCadenceSensor] Scanning for cadence sensors...');
    
    this.peripheral = await scan(
      this.noble,
      [this.serviceUuid],
      (peripheral) => {
        return peripheral.advertisement.localName === this.deviceName ||
               peripheral.advertisement.serviceUuids?.includes(this.serviceUuid);
      },
      this.connectTimeout
    );
    
    if (!this.peripheral) {
      this.emit('connect-failed', 'Cadence sensor not found');
      return;
    }
    
    console.log(`[WahooCadenceSensor] Found ${this.peripheral.advertisement.localName}`);
    
    await this.peripheral.connectAsync();
    
    // Discover and subscribe to cadence characteristic
    const {characteristics} = await this.peripheral.discoverServicesAndCharacteristicsAsync();
    this.characteristic = characteristics.find(
      c => c.uuid === '2a63'  // Cycling Cadence Measurement characteristic
    );
    
    if (this.characteristic) {
      this.characteristic.on('data', (data) => {
        this.parseCrankRevolutions(data);
      });
      await this.characteristic.subscribeAsync();
      this.emit('connected');
    }
  }
  
  parseCrankRevolutions(data) {
    // Cycling Cadence characteristic format:
    // Crank Revolutions (2 bytes) + Last Event Time (2 bytes)
    if (data.length >= 4) {
      this.crankRevolutions = data.readUInt16LE(0);
      
      // Calculate cadence from crank revolutions
      // Cadence = (revolutions / time) * 60
      this.emit('stats', {
        cadence: this.calculateCadence(),
        crankRevolutions: this.crankRevolutions,
      });
    }
  }
  
  calculateCadence() {
    // Time-based cadence calculation would go here
    // Simplified for demonstration
    return Math.round(this.crankRevolutions / 2);  // Placeholder
  }
  
  async disconnect() {
    if (this.peripheral) await this.peripheral.disconnectAsync();
  }
}
```

---

### Extension 3: Multi-Sensor Auto-Detection

**Current State:** Bike + HR auto-detect independently at startup.

**Improvement:** Parallel startup of all sensor types.

**File:** `src/app/app.js` (revised startup)

```javascript
async startSensors() {
  console.log('[App] Starting sensor discovery...');
  
  // Launch all sensor discovery in parallel
  const sensorPromises = [];
  
  // Always try bike
  sensorPromises.push(
    this.connectBike()
      .then(() => console.log('[App] Bike connected'))
      .catch((e) => console.warn('[App] Bike not found:', e.message))
  );
  
  // Optional: HR sensor
  if (this.heartRateAutoPreference) {
    sensorPromises.push(
      this.connectHeartRate()
        .then(() => console.log('[App] Heart rate sensor connected'))
        .catch((e) => console.warn('[App] HR sensor not found:', e.message))
    );
  }
  
  // Optional: Speed sensor
  if (this.opts.speedSensorEnabled !== false) {
    sensorPromises.push(
      this.connectSpeedSensor()
        .then(() => console.log('[App] Speed sensor connected'))
        .catch((e) => console.warn('[App] Speed sensor not found:', e.message))
    );
  }
  
  // Optional: Cadence sensor
  if (this.opts.cadenceSensorEnabled !== false) {
    sensorPromises.push(
      this.connectCadenceSensor()
        .then(() => console.log('[App] Cadence sensor connected'))
        .catch((e) => console.warn('[App] Cadence sensor not found:', e.message))
    );
  }
  
  // Wait for at least bike + any optional sensors
  const results = await Promise.allSettled(sensorPromises);
  
  const connected = results.filter(r => r.status === 'fulfilled').length;
  console.log(`[App] Sensor startup complete: ${connected} sensor(s) connected`);
  
  // If bike failed, sensor discovery failed
  if (!this.bikeClient) {
    throw new Error('No bike found - cannot continue');
  }
}
```

---

### Extension 4: Sensor Priority & Blending

**Current State:** Bike is primary, HR is supplementary.

**Improvement:** Configurable priority and blending for speed/cadence.

**File:** `src/util/metrics-processor.js` (revised)

```javascript
export class MetricsProcessor extends EventEmitter {
  constructor(options = {}) {
    this.speedSource = options.speedSource || 'bike';  // 'bike' | 'sensor' | 'blend'
    this.cadenceSource = options.cadenceSource || 'bike';  // 'bike' | 'sensor' | 'blend'
    
    this.bikePower = 0;
    this.bikeSpeed = 0;
    this.bikeCadence = 0;
    
    this.sensorSpeed = 0;
    this.sensorCadence = 0;
  }
  
  updateBikeMetrics(power, speed, cadence) {
    this.bikePower = power;
    this.bikeSpeed = speed;
    this.bikeCadence = cadence;
    this.emit('metrics', this.getMetrics());
  }
  
  updateSpeedSensor(speed) {
    this.sensorSpeed = speed;
    this.emit('metrics', this.getMetrics());
  }
  
  updateCadenceSensor(cadence) {
    this.sensorCadence = cadence;
    this.emit('metrics', this.getMetrics());
  }
  
  getMetrics() {
    return {
      power: this.smoothedPower(this.bikePower),
      speed: this.selectSpeed(),
      cadence: this.selectCadence(),
    };
  }
  
  selectSpeed() {
    switch (this.speedSource) {
      case 'bike':
        return this.bikeSpeed;
      case 'sensor':
        return this.sensorSpeed;
      case 'blend':
        // Average bike estimation and sensor when both available
        return this.sensorSpeed 
          ? (this.bikeSpeed + this.sensorSpeed) / 2 
          : this.bikeSpeed;
      default:
        return this.bikeSpeed;
    }
  }
  
  selectCadence() {
    switch (this.cadenceSource) {
      case 'bike':
        return this.bikeCadence;
      case 'sensor':
        return this.sensorCadence;
      case 'blend':
        // Trust sensor over bike if sensor available
        return this.sensorCadence || this.bikeCadence;
      default:
        return this.bikeCadence;
    }
  }
}
```

---

## Configuration Examples

### Simple Setup (Default - Just Bike + HR)

```json
{
  "bike": "keiser",
  "bikeAdapter": "hci0",
  "serverAdapter": "hci0",
  "heartRateEnabled": true
}
```

**Result:**
- Scans for Keiser bike on hci0
- Scans for HR device on hci0
- Broadcasts power + cadence + HR via hci0
- Falls back to hci0 if hci1 missing

---

### Dual Adapter Setup (Recommended for Pi Zero W)

```json
{
  "bike": "keiser",
  "bikeAdapter": "hci0",
  "serverAdapter": "hci1",
  "heartRateEnabled": true,
  "heartRateAdapter": "hci0"
}
```

**Result:**
- Scans for Keiser bike on hci0 (onboard)
- Scans for HR device on hci0 (onboard)
- Broadcasts power + cadence + HR via hci1 (USB dongle)
- Separate radio channels = no interference

---

### Full Sensor Setup (Future - All Optional Sensors)

```json
{
  "bike": "keiser",
  "bikeAdapter": "hci0",
  "serverAdapter": "hci1",
  
  "heartRateEnabled": true,
  "heartRateAdapter": "hci0",
  
  "speedSensorEnabled": true,
  "speedSensorOptions": {
    "deviceName": "Wahoo Speed"
  },
  
  "cadenceSensorEnabled": true,
  "cadenceSensorOptions": {
    "deviceName": "Wahoo Cadence"
  },
  
  "metricsProcessor": {
    "speedSource": "blend",     // Use both bike estimation + sensor
    "cadenceSource": "sensor"   // Prefer sensor over bike
  }
}
```

**Result:**
- Bike: Power + estimated cadence on hci0
- HR device: Heart rate on hci0
- Speed sensor: Wheel data on hci0
- Cadence sensor: Crank data on hci0
- Broadcasting: Blended metrics via hci1
- Zwift receives: Power + HR + accurate cadence + accurate speed

---

## Effort Estimate

| Feature | Lines | Time | Complexity |
|---------|-------|------|-----------|
| Wahoo Speed Sensor Client | 150 | 1-2 hrs | Low (copy HR pattern) |
| Wahoo Cadence Sensor Client | 150 | 1-2 hrs | Low (copy HR pattern) |
| Multi-Sensor Auto-Detection | 100 | 30 min | Low (parallel promises) |
| Metrics Blending/Priority | 100 | 30 min | Low (switch logic) |
| Configuration Support | 50 | 30 min | Low (defaults + docs) |
| **Total** | **~550** | **4-5 hrs** | **Low** |

---

## Why This Architecture Works

1. **EventEmitter Pattern** ✓
   - Each sensor is independent and emits 'stats' events
   - App.js simply listens and aggregates
   - Easy to add/remove sensors without refactoring

2. **Shared Scanning** ✓
   - All sensors use same `scan()` function from ble-scan.js
   - Consistent timeout/retry logic

3. **Priority & Blending** ✓
   - MetricsProcessor decides which data source wins
   - Configurable per deployment

4. **Graceful Fallback** ✓
   - Bike is mandatory (app won't start without it)
   - All other sensors optional (app works without them)
   - When sensor unavailable, falls back to estimation/bike data

5. **Backward Compatible** ✓
   - Default config matches current behavior (just bike + HR)
   - New sensors don't break existing users

---

## Conclusion

**The architecture is ready for multi-sensor expansion.** The hard part (Bluetooth initialization, dual adapters, auto-detection) is already done. Adding speed/cadence sensors is straightforward extension work using proven patterns.
