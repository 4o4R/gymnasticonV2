# Dual Adapter Testing & Debugging Guide

## Quick Reference: Your Pi Hardware Setup

```
Raspberry Pi Zero 2 W:
  ├─ hci0: Broadcom onboard BT (builtin, ARM UART)
  └─ hci1: [USB dongle if you add one - optional]

With USB BLE Dongle:
  ├─ hci0: Onboard BT (builtin) - RECOMMENDED: Use for bike
  └─ hci1: USB Dongle - RECOMMENDED: Use for server/HR
```

---

## Testing Scenarios

### Scenario 1: Verify Adapter Auto-Detection

**Goal:** Confirm V2 correctly identifies your adapters

```bash
# SSH into Pi
ssh pi@raspberrypi

# Run adapter detection
cd /opt/gymnasticon
node -e "
  import('./src/util/adapter-detect.js').then(m => {
    const result = m.detectAdapters();
    console.log(JSON.stringify(result, null, 2));
  });
"

# Expected Output:
{
  "bikeAdapter": "hci0",
  "serverAdapter": "hci0",        // Single adapter: same as bike
  "antPresent": false,
  "multiAdapter": false,
  "adapters": ["hci0"]
}

# OR if USB dongle:
{
  "bikeAdapter": "hci0",
  "serverAdapter": "hci1",        // Dual adapter: separate
  "antPresent": false,
  "multiAdapter": true,
  "adapters": ["hci0", "hci1"]
}
```

### Scenario 2: Debug Noble State vs hciconfig

**Goal:** See if noble state is stuck vs adapter actually being up

```bash
# Terminal 1: Monitor noble state
cd /opt/gymnasticon
journalctl -u gymnasticon -f | grep -E "(noble state|adapter.*UP|Falling back)"

# Terminal 2: Start gymnasticonV2
timeout 30 node src/app/cli.js --bike=keiser 2>&1

# Pedal the bike

# Expected (GOOD - noble working):
# [gym-cli] Bluetooth initialized; noble state: unknown
# [gym-app] waiting for Bluetooth adapter to become poweredOn...
# [gym-app] adapter hci0 UP (verified via hciconfig); proceeding...
# [ble-scan] ✓ Noble scan started successfully
# [keiser] Found Keiser bike! address=EF:D7:CB:6C:69:18

# Expected (FALLBACK - noble broken, hcitool saves us):
# [gym-cli] Bluetooth initialized; noble state: unknown
# [gym-app] waiting for Bluetooth adapter to become poweredOn...
# [gym-app] adapter hci0 UP (verified via hciconfig); proceeding...
# [ble-scan] ⚠ Noble scan failed: Could not start scanning, state is unknown
# [ble-scan] ⚠ Falling back to hcitool lescan...
# [ble-scan] hcitool found: M3i#000 [EF:D7:CB:6C:69:18]
# [ble-scan] ✓ MATCH via hcitool: M3i#000 [EF:D7:CB:6C:69:18]
# [keiser] Found Keiser bike! address=EF:D7:CB:6C:69:18
```

### Scenario 3: Verify Adapter State via hciconfig

**Goal:** Confirm physical adapter is UP even if noble thinks it's unknown

```bash
# Check all adapters
hciconfig -a

# Expected output:
hci0:   Type: Primary  Bus: UART
        BD Address: B8:27:EB:XX:XX:XX  ACL MTU: 310:10  SCO MTU: 64:8
        UP RUNNING PSCAN ISCAN ← THIS IS WHAT MATTERS
        RX bytes:5829 acl:0 sco:0 evt:5829 err:0 rx_ack:0
        TX bytes:1438 acl:0 sco:0 cmd:1438 err:0
        
# If you see "DOWN" or "UNKNOWN":
#   ├─ Adapter needs power on
#   └─ Run: sudo hciconfig hci0 up
```

### Scenario 4: Manual hcitool Scan (for debugging fallback)

**Goal:** Verify hcitool can find your bike when noble can't

```bash
# Direct hcitool scan
sudo timeout 10 hcitool -i hci0 lescan

# Expected output:
LE Scan ...
EF:D7:CB:6C:69:18 M3i#000
EF:D7:CB:6C:69:18 M3i#000
EF:D7:CB:6C:69:18 M3i#000
^C

# If you see your bike MAC/name → hcitool fallback WILL work
# Pedal bike during scan to trigger advertisements
```

### Scenario 5: Test Adapter Fallback Strategy

**Goal:** Verify V2 gracefully falls back to second adapter if primary fails

```bash
# Disable primary adapter (simulate failure)
sudo hciconfig hci0 down

# Start app
cd /opt/gymnasticon
timeout 30 node src/app/cli.js --bike=keiser 2>&1

# If USB dongle (hci1) available:
# Expected: Auto-switches to hci1, continues normally
# [gym-app] adapter hci0 failed; trying hci1
# [gym-app] bike adapter set to hci1 [fallback]
# [keiser] Starting Keiser bike scan...

# Restore adapter
sudo hciconfig hci0 up
```

### Scenario 6: Multi-Sensor Parallel Startup (Optional)

**Goal:** Verify all sensors connect in parallel, not sequentially

```bash
# Requires: HR device + optional speed/cadence sensors

# Clear logs
journalctl -u gymnasticon --vacuum-time=1h

# Start app
systemctl restart gymnasticon

# Watch logs with timestamps
journalctl -u gymnasticon -f --output=short-iso | grep -E "(HR|speed|cadence|optional|Connected)"

# Expected timing:
# 05:05:00 [keiser] Starting Keiser bike scan
# 05:05:00 [speed-sensor] Starting speed sensor scan    ← Parallel!
# 05:05:00 [cadence-sensor] Starting cadence sensor scan ← Parallel!
# 05:05:00 [hr-client] Starting HR scan                 ← Parallel!
#
# 05:05:02 [keiser] Found Keiser bike
# 05:05:02 [speed-sensor] Found speed sensor
# 05:05:02 [hr-client] Found HR device
# 05:05:02 [cadence-sensor] Found cadence sensor

# Sequential would take 8s; parallel takes ~2s total ✓
```

### Scenario 7: Verify BLE Multi-Output (Two Advertisements)

**Goal:** Confirm Gymnasticon advertises on more than one adapter when available

```bash
# Start Gymnasticon with auto multi-output (default)
systemctl restart gymnasticon

# Check logs for the adapter list
journalctl -u gymnasticon -n 50 | grep -E "BLE server adapters|BLE mirror enabled"

# Expected:
# [gym-app] BLE server adapters: hci1, hci0
# [gym-app] BLE mirror enabled on bike adapter [whitelist] (Raspberry Pi 4 ...)

# From a phone or another computer, scan for BLE devices:
# - You should see two "GymnasticonV2" entries (different MACs).
# - Connect the watch to one entry and Zwift to the other.
```

---

## Troubleshooting Checklist

### "Noble state is unknown" (Stuck at startup)

**Symptom:**
```
[gym-app] waiting for Bluetooth adapter to become poweredOn
[gym-app] Bluetooth adapter state timeout after 3000ms; reinitializing noble
[gym-app] adapter hci0 failed; trying hci1
(error after 3 attempts)
```

**Root Cause:** Noble not detecting state changes (hardware/BlueZ issue)

**Fixes to Try (in order):**
1. ✅ **V2 will use hcitool fallback** - Just let it run, should recover
2. 🔧 **Restart Bluetooth service:**
   ```bash
   sudo systemctl restart bluetooth
   sleep 2
   systemctl restart gymnasticon
   ```
3. 🔧 **Bring adapter up explicitly:**
   ```bash
   sudo hciconfig hci0 up
   systemctl restart gymnasticon
   ```
4. 🔧 **Reload noble library:**
   ```bash
   cd /opt/gymnasticon
   npm rebuild @abandonware/noble
   systemctl restart gymnasticon
   ```

### "Bike not found" (Scan completes but no match)

**Symptom:**
```
[ble-scan] ✓ Noble scan started successfully
[ble-scan] Waiting for discover events...
(30s timeout, no bike found)
```

**Root Cause:** Bike not advertising, wrong filter, or range issue

**Fixes:**
1. ✅ **Verify bike is on:** Check LED, try pedaling hard (forces advertisement)
2. 🔧 **Check bike name filter:** See [keiser] bike module for exact name
   ```bash
   # Manual scan to see bike name
   sudo hcitool -i hci0 lescan | head -20
   ```
3. 🔧 **Check BLE range:** Move Pi closer to bike
4. 🔧 **Check other BLE interference:** Are there other nearby BLE devices?
   ```bash
   sudo timeout 5 hcitool -i hci0 lescan | wc -l
   # If >50 devices, interference likely
   ```

### "hcitool: not found" (Fallback missing)

**Symptom:**
```
[ble-scan] Failed to start hcitool: spawn sudo ENOENT
```

**Fix:**
```bash
# Install bluetooth tools
sudo apt-get update
sudo apt-get install -y bluez
# Which includes hcitool

# Verify
which hcitool
```

### "sudo: not authorized" (hcitool permission)

**Symptom:**
```
[ble-scan] hcitool process error: sudo: no password entry
```

**Fix:** Add passwordless sudo for hcitool
```bash
# On Pi:
echo "pi ALL=(ALL) NOPASSWD: /usr/bin/hcitool" | sudo tee -a /etc/sudoers
echo "pi ALL=(ALL) NOPASSWD: /usr/bin/hciconfig" | sudo tee -a /etc/sudoers

# Verify
sudo -n hcitool scan
# Should work without password prompt
```

### "Permission denied: hciconfig"

**Symptom:**
```
[gym-app] Error checking adapter status: EACCES: permission denied, open '/sys/class/bluetooth/hci0/device/flags'
```

**Fix:**
```bash
# V2 already uses hciconfig as fallback, but ensure bluetooth group membership
groups pi
# Should show: pi adm dialout cdrom sudo audio video plugdev i2c bluetooth

# Add to bluetooth group if missing:
sudo usermod -a -G bluetooth pi

# Then re-login:
exit
ssh pi@raspberrypi  # Re-login
```

---

## Development & Testing Commands

### Run V2 with Verbose Logging

```bash
# Set debug flags
export DEBUG=gym:*

# Run app
cd /opt/gymnasticon
timeout 30 node src/app/cli.js --bike=keiser --debug 2>&1 | head -100

# Or with filtering:
timeout 30 node src/app/cli.js --bike=keiser 2>&1 | grep -E "ERROR|FAIL|adapter|noble|ble-scan"
```

### Simulate Multi-Sensor Test (PC/Mac)

```bash
# In V2 directory on dev machine:
npm run test:multi-sensor

# This runs src/test/multi-sensor-integration.mjs
# which tests parallel startup without hardware
```

### Compare V2 Logs vs Original

```bash
# V2 startup (new approach):
# [gym-app] adapter hci0 is UP (verified via hciconfig); proceeding despite noble state being unknown
# [ble-scan] ⚠ Noble scan failed: Could not start scanning, state is unknown
# [ble-scan] ⚠ Falling back to hcitool lescan...
# [ble-scan] ✓ MATCH via hcitool: M3i#000

# Original startup (old approach):
# [Would hang waiting for stateChange event]
```

---

## Performance Metrics

### Target Startup Times (V2)

```
Goal: App running, metrics flowing to Zwift in <10s

Timeline:
  0s:   App start
  0.5s: Adapters detected
  0.5s: Bike scan begins
  1s:   Multi-sensors start (parallel)
  5s:   Bike found & connected
  5.5s: Speed/HR sensors found
  6s:   BLE server starts advertising
  6.5s: Zwift connects to power sensor
  7s:   Metrics flowing
  
  Total: ~7 seconds to first power reading ✓
```

### Memory/CPU Usage

```
Base app (no bike):
  Memory: ~20-30 MB (RSS)
  CPU: <1%

With bike + 1 sensor:
  Memory: ~40-50 MB
  CPU: 1-2% (scanning)

With bike + 3 sensors + ANT:
  Memory: ~60-80 MB
  CPU: 2-5%

These should stay constant even on Pi Zero
```

---

## Advanced Debugging

### Sniff BLE Packets (if Bluetooth adapter supports it)

```bash
# Install packet sniffer
sudo apt-get install -y bluez-tools

# Start sniffer on hci0
sudo hcidump -i hci0 -a -X | grep -E "M3i|KEISER"

# You'll see raw HCI packets - useful for understanding what noble vs hcitool see
```

### Check HCI Version/Capabilities

```bash
# Get full adapter info
hciconfig -a hci0

# Look for:
# HCI Version: 5.0    ← Better (extended scan support)
# HCI Version: 4.2    ← OK (basic scan only)
# HCI Version: 4.0    ← Minimal

# Check MTU
hciconfig hci0 | grep MTU
# MTU: 310:10  ← ACL:SCO buffer sizes
```

### Force Adapter Reinitialize (Nuclear Option)

```bash
# Reset adapter at HCI level
sudo hciconfig hci0 down
sudo hciconfig hci0 reset
sleep 1
sudo hciconfig hci0 up

# Then restart app
systemctl restart gymnasticon
```

---

## Success Criteria

**For your Pi to work with V2:**

✅ hciconfig shows adapter UP RUNNING  
✅ hcitool scan finds your bike  
✅ V2 detects adapter correctly  
✅ Either noble OR hcitool fallback finds bike  
✅ Bike connects within 30 seconds  
✅ Zwift receives power metric  
✅ Multi-sensor (if available) connects in parallel  

**If all above pass → V2 is working correctly!**
