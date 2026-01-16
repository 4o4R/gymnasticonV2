# Metric Blending: What It Means & Why It's Needed

## The Problem

When multiple data sources are available, which one should the app use?

**Example scenario:**
- Bike (mandatory): Reports power = 200W, cadence = 90 RPM
- Speed sensor (optional): Provides wheel data → calculates speed = 35 km/h
- HR device (optional): Provides heart rate = 145 BPM
- Cadence sensor (optional): Reports cadence = 91 RPM

**Question:** If both the bike AND cadence sensor are reporting, should we:
1. Use bike cadence (90 RPM)?
2. Use sensor cadence (91 RPM)?
3. Average them (90.5 RPM)?

**Answer:** It depends on quality and trust. We need a **priority/blending strategy**.

---

## Strategy Types

### 1. **Bike-Primary (Current Default)**
"Trust the bike most, sensors are optional supplements"

```
Cadence source: bike (fallback to sensor if bike silent)
Speed source: bike (fallback to sensor if bike silent)
Power source: bike ONLY (no alternative)
Heart rate source: sensor ONLY (bike doesn't report HR)
```

**When to use:** Most bikes are reliable. Sensors are expensive add-ons.

**Implementation:**
```javascript
selectCadence() {
  // Prefer bike, fall back to sensor
  return this.bikeCadence > 0 ? this.bikeCadence : this.sensorCadence;
}

selectSpeed() {
  // Prefer bike, fall back to sensor estimation
  return this.bikeSpeed > 0 ? this.bikeSpeed : this.estimatedSpeed;
}
```

---

### 2. **Sensor-Primary (For Unreliable Bikes)**
"Prefer sensor data when available, bike is backup"

```
Cadence source: sensor (fallback to bike if sensor silent)
Speed source: sensor (fallback to bike if sensor silent)
```

**When to use:** Old/broken bikes that report unreliably. Fresh sensors are more trustworthy.

**Implementation:**
```javascript
selectCadence() {
  // Prefer sensor, fall back to bike
  return this.sensorCadence > 0 ? this.sensorCadence : this.bikeCadence;
}
```

---

### 3. **Blended/Average (For Redundancy)**
"Combine both sources for best accuracy"

```
Cadence source: (bikeCadence + sensorCadence) / 2
Speed source: (bikeSpeed + sensorSpeed) / 2
```

**When to use:** Both sources are reliable and you want maximum accuracy.

**Implementation:**
```javascript
selectCadence() {
  if (this.sensorCadence > 0 && this.bikeCadence > 0) {
    // Both available: average them
    return (this.sensorCadence + this.bikeCadence) / 2;
  }
  // One or neither available: use whichever exists
  return this.sensorCadence || this.bikeCadence || 0;
}
```

---

### 4. **Quality-Based Switching (Most Sophisticated)**
"Use whichever source is currently reporting cleanly"

```
Cadence source: 
  IF bike connected AND reporting stable → bike
  ELSE IF sensor connected AND reporting stable → sensor
  ELSE → fallback to estimation
```

**When to use:** Production system where sensors may drop out randomly.

**Implementation:**
```javascript
selectCadence() {
  // Check bike health: connected && recent data
  const bikeHealthy = this.bikeConnected && (Date.now() - this.lastBikeUpdate < 5000);
  
  // Check sensor health: connected && recent data
  const sensorHealthy = this.sensorConnected && (Date.now() - this.lastSensorUpdate < 5000);
  
  if (bikeHealthy && sensorHealthy) {
    // Both healthy: average for redundancy
    return (this.bikeCadence + this.sensorCadence) / 2;
  } else if (bikeHealthy) {
    // Only bike healthy
    return this.bikeCadence;
  } else if (sensorHealthy) {
    // Only sensor healthy
    return this.sensorCadence;
  } else {
    // Neither healthy: estimate from wheel revolutions
    return this.estimateCadence();
  }
}
```

---

## For Gymnastic: What We Should Implement

Given the use case (Gymnastics bike → Zwift):

### **Recommended: Strategy #1 (Bike-Primary)**

**Reasoning:**
1. **Bike is mandatory** - Always present and known to work
2. **Sensors are optional add-ons** - User explicitly buys and pairs them
3. **Bike has more data** - Power, cadence, sometimes speed
4. **Keep it simple** - Fewer edge cases = fewer bugs

**Implementation:**
```javascript
selectCadence() {
  // If bike reporting cadence, use it
  if (this.bikeCadence > 0 && this.timeoutActive('bike')) {
    return this.bikeCadence;
  }
  // Fallback to sensor if bike silent
  if (this.sensorCadence > 0) {
    return this.sensorCadence;
  }
  // No data
  return 0;
}

selectSpeed() {
  // If bike reporting speed, use it
  if (this.bikeSpeed > 0 && this.timeoutActive('bike')) {
    return this.bikeSpeed;
  }
  // Fallback to sensor if bike silent
  if (this.sensorSpeed > 0) {
    return this.sensorSpeed;
  }
  // Fallback to estimation from cadence
  return this.estimateSpeed();
}
```

**Configuration (in defaults.js):**
```javascript
metricsProcessor: {
  cadenceStrategy: 'bike-primary',  // 'bike-primary' | 'sensor-primary' | 'blend' | 'quality-based'
  speedStrategy: 'bike-primary',    // same options
}
```

---

## Decision Points in the Code

When implementing multi-sensor startup, we need metric blending logic at:

1. **App.js::onBikeStats()** - When bike reports power/cadence
2. **App.js::onSpeedSensorStats()** - When speed sensor reports wheel data
3. **App.js::onCadenceSensorStats()** - When cadence sensor reports crank data
4. **MetricsProcessor.getMetrics()** - Final decision: which value goes to Zwift?

**Current flow:**
```
Bike → power/cadence → MetricsProcessor → GymnasticonServer → Zwift
                ↓
              Smooth power
```

**Future flow with blending:**
```
Bike → power/cadence ─┐
                       ├→ MetricsProcessor (apply strategy) → GymnasticonServer → Zwift
Speed sensor ────────┤
Cadence sensor ──────┘
HR device ───────────→ broadcast as-is (no blending needed)
```

---

## For Now: Simple Bike-Primary

For the initial implementation, let's keep it simple:
- **Bike cadence/speed:** Use from bike
- **Sensor cadence/speed:** Fallback if bike not reporting
- **HR:** Always from HR device (no alternative)

Then we can add configurable blending later if users want it.
