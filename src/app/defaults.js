// ─────────────────────────────────────────────────────────────────────────────
// File: src/app/defaults.js
// Teaching note:
//   Keeping configuration defaults in a lightweight module lets the CLI and the
//   main app share values *without* pulling in heavy Bluetooth dependencies
//   before we have configured adapter environment variables.
// ─────────────────────────────────────────────────────────────────────────────

export const defaults = {
  // bike options
  bike: 'autodetect',            // allow Gymnasticon to pick a bike profile at runtime
  defaultBike: 'keiser',         // fallback profile when autodetect sees nothing
  bikeReceiveTimeout: 10,         // seconds before we consider bike telemetry stale
  bikeConnectTimeout: 30,        // seconds to wait while establishing a connection (was 0, caused infinite hangs)
  bikeAdapter: 'hci0',           // BLE adapter used to connect to the bike (BlueZ index)

  // flywheel bike options
  flywheelAddress: undefined,    // optional MAC filter for Flywheel discovery
  flywheelName: 'Flywheel 1',    // default BLE name when no MAC filter is provided
  

  // peloton bike options
  pelotonPath: '/dev/ttyUSB0',   // serial device path for Peloton consoles

  // test bike options
  botPower: 0,                   // watts emitted by the bot simulator
  botCadence: 0,                 // RPM emitted by the bot simulator
  botHost: '0.0.0.0',            // UDP host for bot control
  botPort: 3000,                 // UDP port for bot control

  // server options
  serverAdapter: 'hci0',         // BLE adapter used to advertise Gymnasticon
  serverName: 'GymnasticonV2',     // BLE name seen by Zwift/TrainerRoad/etc.
  serverPingInterval: 1,         // seconds between keep-alive power frames
  bleMultiOutput: undefined,     // auto-enable multi-adapter BLE mirroring when possible

  // ANT+ server options
  antDeviceId: 21234,            // deterministic default for ANT+ device ID
  antAuto: true,                 // auto-enable ANT+ when a stick is detected
  antEnabled: false,             // explicit override for ANT+ broadcasting

  // power adjustment (tune mis-calibrated bikes)
  powerScale: 1.0,               // multiplicative watt adjustment
  powerOffset: 0.0,              // additive watt adjustment

  // speed estimation fallback parameters
  speedFallback: {
    circumferenceM: 2.1,         // meters per wheel revolution (virtual tire)
    gearFactor: 3.0,             // crank-to-wheel ratio used for estimates
    min: 0,                      // clamp minimum estimated speed
    max: 25                      // clamp maximum estimated speed (~90 km/h)
  },

  // heart-rate options (auto = let runtime decide based on hardware)
  heartRateEnabled: undefined,
  heartRateAdapter: undefined,

  // connection retry behavior
  connectionRetryDelay: 5000,   // milliseconds to wait before retrying a failed startup attempt
};
