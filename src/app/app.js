/**
 * Main Application Entry Point
 * 
 * This file coordinates all the major components of the Gymnasticon system:
 * - Bluetooth (BLE) server for connecting to fitness apps
 * - ANT+ server for older fitness devices
 * - Bike connections (Flywheel, Peloton, etc)
 * - Heart rate monitoring
 * - Simulation capabilities for testing
 */

import {once} from 'events';

// Core server components
import {GymnasticonServer} from '../servers/ble/index.js';
import {AntServer} from '../servers/ant/index.js';

// Bike and sensor integrations
import {createBikeClient, getBikeTypes} from '../bikes/index.js';
import {HeartRateClient} from '../hr/heart-rate-client.js';
import {MetricsProcessor} from '../util/metrics-processor.js';
import {HealthMonitor} from '../util/health-monitor.js';
import {BluetoothConnectionManager} from '../util/connection-manager.js';

// Utility modules
import {Simulation} from './simulation.js'; // Simulation helper for bot mode and testing.
import {Timer} from '../util/timer.js'; // Shared timer utility that handles repeating and one-shot events.
import {Logger} from '../util/logger.js'; // Lightweight logger abstraction.
import {createAntStick} from '../util/ant-stick.js'; // Factory for gd-ant-plus sticks.
import {estimateSpeedMps} from '../util/speed-estimator.js'; // Helper that estimates speed when bikes do not report it.
import {nowSeconds} from '../util/time.js'; // Helper to get monotonic-ish timestamps in seconds.
import {loadDependency, toDefaultExport} from '../util/optional-deps.js'; // Optional dependency loader with stub fallback support.
import {detectBoardModel, isLikelyPiZero} from '../util/platform.js'; // Board detection helpers so we can gate multi-role features automatically.
import {defaults as sharedDefaults} from './defaults.js'; // Lightweight defaults kept separate so CLI can set env vars before loading Bluetooth deps.

const nobleModule = loadDependency('@abandonware/noble', '../../stubs/noble.cjs', import.meta);
const nobleDefault = toDefaultExport(nobleModule);
const blenoModule = loadDependency('@abandonware/bleno', '../../stubs/bleno.cjs', import.meta);
const bleno = toDefaultExport(blenoModule);
const debugModule = loadDependency('debug', '../../stubs/debug.cjs', import.meta);
const debug = toDefaultExport(debugModule);

const debuglog = debug('gym:app:app');

export {getBikeTypes};
export const defaults = sharedDefaults;

/**
 * Gymnasticon App.
 *
 * Converts the Flywheel indoor bike's non-standard data protocol into the
 * standard Bluetooth Cycling Power Service so the bike can be used with
 * apps like Zwift.
 */
export class App {
  constructor(options = {}) {
    const opts = { ...defaults, ...options };
    this.opts = opts;

    this.logger = new Logger();
    this.noble = opts.noble || nobleDefault;
    this.bleno = bleno;
    this.metricsProcessor = opts.metricsProcessor || new MetricsProcessor({ smoothingFactor: opts.powerSmoothing });
    this.healthMonitor = opts.healthMonitor || new HealthMonitor(opts.healthCheckInterval);
    this.connectionManager =
      opts.connectionManager ||
      new BluetoothConnectionManager(this.noble, {
        timeout: opts.connectionTimeout,
        maxRetries: opts.connectionRetries,
      });

    this.powerScale = opts.powerScale;
    this.powerOffset = opts.powerOffset;
    this.power = 0; // Track the latest scaled power value in watts.
    this.currentCadence = 0; // Track the most recent cadence in RPM for ping updates and ANT+.
    this.speedOptions = { ...defaults.speedFallback, ...(opts.speedFallback || {}) }; // Merge caller overrides with sensible defaults for speed estimation.
    this.kinematics = { // Maintain cumulative wheel/crank state for CSC notifications.
      lastTimestamp: null, // Last time we integrated cadence/speed samples.
      crankRevolutions: 0, // Floating-point accumulator for crank revolutions so we can wrap at 16 bits cleanly.
      wheelRevolutions: 0 // Floating-point accumulator for wheel revolutions (32-bit field in BLE spec).
    };
    this.crank = { timestamp: 0, revolutions: 0 }; // BLE-friendly crank snapshot (16-bit revolutions + seconds timestamp).
    this.wheel = { timestamp: 0, revolutions: 0 }; // BLE-friendly wheel snapshot (32-bit revolutions + seconds timestamp).

    this.server = new GymnasticonServer(this.bleno, opts.serverName);
    const antRequested = typeof opts.antEnabled === 'boolean' ? opts.antEnabled : Boolean(opts.antAuto ?? defaults.antAuto); // Respect explicit antEnabled, otherwise fall back to auto preference.
    this.antEnabled = antRequested; // Store the resolved ANT+ enable switch for later checks.
    if (this.antEnabled) { // Only create ANT+ resources when needed to avoid probing hardware unnecessarily.
      this.antStick = createAntStick(); // Create the ANT+ stick interface (falls back to stubs during development).
      this.antStickClosed = false; // Track whether we have manually closed the stick to avoid double-close errors.
      this.antServer = new AntServer(this.antStick, { deviceId: opts.antDeviceId }); // ANT+ Bicycle Power broadcaster using gd-ant-plus APIs.
    } else {
      this.antStick = null; // Mark hardware resources as absent when ANT+ broadcasting is disabled.
      this.antStickClosed = true; // Treat the stick as already closed so stopAnt does nothing.
      this.antServer = null; // No ANT+ broadcaster is created in this mode.
    }

    this.onAntStickStartup = this.onAntStickStartup.bind(this); // Bind ANT+ event handlers once so we can add/remove listeners cleanly.
    this.stopAnt = this.stopAnt.bind(this); // Bind stop helper for reuse across shutdown paths.

    if (this.antStick && typeof this.antStick.on === 'function') { // Register stick lifecycle hooks when running against real hardware.
      this.antStick.on('startup', this.onAntStickStartup);
      this.antStick.on('shutdown', this.stopAnt);
    }

    this.statsTimeout = new Timer(opts.bikeReceiveTimeout, { repeats: false });
    this.statsTimeout.on('timeout', this.onBikeStatsTimeout.bind(this));
    this.connectTimeout = new Timer(opts.bikeConnectTimeout, { repeats: false });
    this.connectTimeout.on('timeout', this.onBikeConnectTimeout.bind(this));
    this.pingInterval = new Timer(opts.serverPingInterval);
    this.pingInterval.on('timeout', this.onPingInterval.bind(this));

    this.simulation = new Simulation();
    this.simulation.on('pedal', this.onPedalStroke.bind(this));

    // Heart-rate capture is opt-in because many Pi Zero radios cannot scan and
    // advertise simultaneously.  We only build the client when the caller
    // explicitly asks for it to avoid blocking power/cadence broadcasts.
    // Decide whether heart-rate rebroadcasting should run automatically.  We
    // consider three tiers:
    //   1. Explicit user override (config/CLI) wins.
    //   2. When two different adapters are configured (bike+server), we assume
    //      it is safe to dedicate one radio to scanning HRM peripherals.
    //   3. On single-adapter Pi Zero units we disable HR by default because the
    //      onboard radio struggles with simultaneous scan+advertise.  Every
    //      other platform is treated as multi-role capable.
    this.heartRateAutoPreference = this.shouldEnableHeartRate(opts);
    if (this.heartRateAutoPreference) {
      this.hrClient = new HeartRateClient(this.noble, {
        deviceName: opts.heartRateDevice,
        serviceUuid: opts.heartRateServiceUuid,
        connectionManager: this.connectionManager,
      });
      this.hrClient.on('heartRate', this.onHeartRate.bind(this));
    } else {
      this.hrClient = null;
      this.logger.log('Heart-rate rebroadcast disabled (hardware limitations detected)');
    }
    if (this.healthMonitor) {
      this.healthMonitor.on('stale', this.onHealthMetricStale.bind(this));
    }

    this.onSigInt = this.onSigInt.bind(this);
    this.onExit = this.onExit.bind(this);
    
    // Modern Bluetooth configuration
    process.env['NOBLE_HCI_DEVICE_ID'] = opts.bikeAdapter;
    process.env['BLENO_HCI_DEVICE_ID'] = opts.serverAdapter;
    process.env['BLENO_MAX_CONNECTIONS'] = '3';
    process.env['NOBLE_EXTENDED_SCAN'] = '1';
    process.env['NOBLE_MULTI_ROLE'] = '1';
    
    if (opts.bikeAdapter === opts.serverAdapter) {
      process.env['NOBLE_MULTI_ROLE'] = '1';
    }

    // Enhanced error handling
    this.errorHandler = this.handleError.bind(this);
    process.on('unhandledRejection', this.errorHandler);
    process.on('uncaughtException', this.errorHandler);
  }

  handleError(error) {
    this.logger.error('Fatal error:', error);
    this.cleanup();
    process.exit(1);
  }

  async start() {
    await this.run();
  }

  async stop() {
    this.pingInterval.cancel();
    this.statsTimeout.cancel();
    this.connectTimeout.cancel();
    if (this.bike && this.bike.disconnect) {
      await this.bike.disconnect();
    }
    await this.server.stop();
    this.stopAnt();
    if (this.hrClient) {
      await this.hrClient.disconnect();
    }
  }

  async cleanup() {
    try {
      await this.stop();
    } catch (e) {
      this.logger.error(e);
    }
    if (typeof this.antStick?.removeListener === 'function') {
      this.antStick.removeListener('startup', this.onAntStickStartup);
      this.antStick.removeListener('shutdown', this.stopAnt);
    }
    if (typeof this.antStick?.close === 'function' && !this.antStickClosed) {
      try {
        this.antStick.close();
        this.antStickClosed = true;
      } catch (e) {
        this.logger.error('Error closing ANT+ stick', e);
      }
    }
  }

  async run() {
    try {
      process.on('SIGINT', this.onSigInt);
      process.on('exit', this.onExit);

      let state = this.noble?.state;
      if (state !== 'poweredOn') {
        [state] = await once(this.noble, 'stateChange');
      }
      if (state !== 'poweredOn') {
        throw new Error(`Bluetooth adapter state: ${state}`);
      }

      this.logger.log('connecting to bike...');
      this.bike = await createBikeClient(this.opts, this.noble);
      this.bike.on('disconnect', this.onBikeDisconnect.bind(this));
      this.bike.on('stats', this.onBikeStats.bind(this));
      this.connectTimeout.reset();
      await this.bike.connect();
      this.connectTimeout.cancel();
      this.logger.log(`bike connected ${this.bike.address}`);
      await this.server.start();
      if (this.antEnabled) { // Only attempt ANT+ start when broadcasting is enabled.
        this.startAnt(); // Kick off ANT+ broadcasting (no-op if the stick is missing).
      }
      if (this.hrClient) {
        try {
          await this.hrClient.connect();
        } catch (err) {
          this.logger.error('Heart-rate setup failed; continuing without HR data', err);
          await this.hrClient.disconnect().catch(() => {});
          this.hrClient = null;
        }
      }
      this.pingInterval.reset();
      this.statsTimeout.reset();
    } catch (e) {
      this.logger.error(e);
      process.exit(1);
    }
  }

  integrateKinematics(cadence, speed, timestamp) { // Update cumulative crank and wheel state for BLE notifications.
    const now = timestamp ?? nowSeconds(); // Use provided timestamp or fall back to current wall-clock time.
    const last = this.kinematics.lastTimestamp ?? now; // When this is the first sample treat dt as zero.
    const dt = Math.max(0, now - last); // Ensure we never integrate backwards when timestamps jitter.
    this.kinematics.lastTimestamp = now; // Persist the sample time for the next update.

    const safeCadence = Number.isFinite(cadence) ? Math.max(0, cadence) : 0; // Drop NaN/negative cadences before integrating.
    const crankIncrement = (safeCadence / 60) * dt; // Convert RPM to revolutions per second and multiply by elapsed time.
    this.kinematics.crankRevolutions += crankIncrement; // Accumulate crank revolutions in floating-point space for precision.
    this.kinematics.crankRevolutions %= 0x10000; // Keep the accumulator within the 16-bit wrap window to avoid floating-point blow up.

    const circumference = this.speedOptions.circumferenceM || defaults.speedFallback.circumferenceM; // Pull the wheel circumference to map speed to revolutions.
    const safeSpeed = Number.isFinite(speed) ? Math.max(0, speed) : 0; // Guard against bogus speed readings.
    const wheelIncrement = circumference > 0 ? (safeSpeed / circumference) * dt : 0; // Convert linear speed back to wheel revolutions.
    this.kinematics.wheelRevolutions += wheelIncrement; // Accumulate wheel revolutions for the CSC service.
    this.kinematics.wheelRevolutions %= 0x100000000; // Apply 32-bit wrap so the counter mirrors BLE behavior.

    this.crank = { // Build the BLE-friendly crank snapshot (16-bit revolutions + timestamp in seconds).
      timestamp: now,
      revolutions: Math.floor(this.kinematics.crankRevolutions) & 0xffff,
    };

    this.wheel = { // Build the BLE-friendly wheel snapshot (32-bit revolutions + timestamp in seconds).
      timestamp: now,
      revolutions: Math.floor(this.kinematics.wheelRevolutions) >>> 0,
    };
  }

  publishTelemetry() { // Push the latest power/cadence/speed state to BLE and ANT+ consumers.
    this.server.ensureCscCapabilities({ supportWheel: true, supportCrank: true }); // Always advertise both wheel and crank data so speed shows up in apps.
    this.server.updatePower({ power: this.power, cadence: this.currentCadence, crank: this.crank }); // Send Cycling Power measurements including crank events.
    this.server.updateCsc({ wheel: this.wheel, crank: this.crank }); // Send CSC measurements with cumulative wheel/crank counters.
    if (this.antServer?.isRunning) { // Forward to ANT+ bicycle power profile when broadcasting is active.
      this.antServer.updateMeasurement({ power: this.power, cadence: this.currentCadence });
    }
  }

  onPedalStroke(timestamp) {
    this.pingInterval.reset();
    const cadence = this.simulation.cadence ?? this.currentCadence; // Use simulated cadence when bot mode drives the app.
    const speed = estimateSpeedMps(cadence, this.speedOptions); // Estimate speed for simulation strokes so CSC stays alive.
    this.currentCadence = cadence; // Track cadence for ANT+/BLE ping intervals.
    this.integrateKinematics(cadence, speed, timestamp); // Update cumulative crank/wheel counters based on the simulated stroke.
    this.logger.log(`pedal stroke [timestamp=${timestamp} revolutions=${this.crank.revolutions} power=${this.power}W]`);
    this.publishTelemetry(); // Push the updated measurement to BLE/ANT clients.
  }

  onPingInterval() {
    debuglog(`pinging app since no stats or pedal strokes for ${this.pingInterval.interval}s`);
    this.publishTelemetry(); // Re-send the last known measurement so connected apps stay alive.
  }

  onHeartRate(hr) {
    this.server.updateHeartRate(hr);
  }

  onHealthMetricStale(metricName) {
    if (metricName === 'bikeStats') {
      this.logger.log('health monitor detected stale bike telemetry');
      this.onBikeStatsTimeout();
    }
  }

  onBikeStats({ power, cadence, speed }) {
    const scaledPower = power > 0 ? Math.max(0, Math.round(power * this.powerScale + this.powerOffset)) : 0; // Apply calibration and clamp to non-negative watts.
    const safeCadence = Number.isFinite(cadence) ? Math.max(0, cadence) : 0; // Guard against undefined or negative cadence readings.
    const nativeSpeed = Number.isFinite(speed) ? Math.max(0, speed) : null; // Use bike-provided speed when available.
    const inferredSpeed = nativeSpeed ?? estimateSpeedMps(safeCadence, this.speedOptions); // Fall back to our cadence-based estimator when speed is absent.

    const processed = this.metricsProcessor.process({
      power: scaledPower,
      cadence: safeCadence,
      speed: inferredSpeed,
    });

    this.logger.log(`received stats from bike [power=${processed.power}W cadence=${processed.cadence}rpm speed=${(processed.speed ?? inferredSpeed).toFixed(2)}m/s]`); // Log the normalized metrics for debugging.
    this.statsTimeout.reset(); // Clear the bike stats timeout since we just received fresh data.
    this.power = processed.power; // Store the smoothed power for ping intervals and ANT+ updates.
    this.currentCadence = processed.cadence; // Track cadence for ANT+ and BLE keep-alives.
    this.simulation.cadence = processed.cadence; // Keep the simulation helper in sync for manual pedal triggers.
    if (this.healthMonitor) {
      this.healthMonitor.recordMetric('bikeStats', processed);
    }

    const speedForKinematics = Number.isFinite(processed.speed) ? processed.speed : inferredSpeed;
    this.integrateKinematics(processed.cadence, speedForKinematics, nowSeconds()); // Update cumulative wheel/crank counters for CSC.
    this.publishTelemetry(); // Broadcast the updated metrics to BLE and ANT+ clients.
  }

  onBikeStatsTimeout() {
    this.logger.log(`timed out waiting for bike stats after ${this.statsTimeout.interval}s`);
    process.exit(0);
  }

  onBikeDisconnect({ address }) {
    this.logger.log(`bike disconnected ${address}`);
    process.exit(0);
  }

  onBikeConnectTimeout() {
    this.logger.log(`bike connection timed out after ${this.connectTimeout.interval}s`);
    process.exit(1);
  }

  startAnt() {
    if (!this.antEnabled || !this.antStick || !this.antServer) { // Skip when ANT+ broadcasting is disabled or hardware unavailable.
      return;
    }
    if (!this.antStick.is_present()) { // If the stick is not detected, log and fall back to BLE-only mode.
      this.logger.log('no ANT+ stick found');
      return;
    }
    try {
      const opened = this.antStick.open();
      if (opened === false) {
        this.logger.error('failed to open ANT+ stick');
        return;
      }
      this.antStickClosed = false;
      const hasEventEmitter = typeof this.antStick.on === 'function';
      if (!hasEventEmitter || opened === true) {
        this.onAntStickStartup();
      }
    } catch (err) {
      this.logger.error('failed to open ANT+ stick', err);
    }
  }

  onAntStickStartup() {
    if (!this.antServer || this.antServer.isRunning) { // Ignore duplicate startup events or when ANT+ is disabled.
      return;
    }
    this.logger.log('ANT+ stick opened');
    this.antStickClosed = false;
    this.antServer.start();
  }

  stopAnt() {
    if (!this.antServer || !this.antServer.isRunning) { // Nothing to do when we never started broadcasting.
      return;
    }
    this.logger.log('stopping ANT+ server');
    this.antServer.stop();
    if (typeof this.antStick?.close === 'function' && !this.antStickClosed) {
      try {
        this.antStick.close();
        this.antStickClosed = true;
      } catch (err) {
        this.logger.error('failed to close ANT+ stick', err);
      }
    }
  }

  onSigInt() {
    const listeners = process.listeners('SIGINT');
    if (listeners[listeners.length-1] === this.onSigInt) {
      process.exit(0);
    }
  }

  onExit() {
    if (this.antServer?.isRunning) { // Ensure ANT+ broadcasting stops cleanly on process exit.
      this.stopAnt();
    }
  }

  /**
   * Decide whether the heart-rate rebroadcast subsystem should spin up
   * automatically.  The logic purposely favors safety-first defaults:
   *  - Respect explicit overrides (`true` or `false`) from config.
   *  - Enable HR when two different adapters are configured (bike/server),
   *    because those setups have isolated scan/advertise radios.
   *  - On single-adapter Pi Zero boards we disable HR by default since the
   *    onboard radio frequently fails multi-role scenarios.
   *  - Unknown platforms or higher-powered Pis default to enabling HR.
   */
  shouldEnableHeartRate(options) {
    if (typeof options.heartRateEnabled === 'boolean') {
      return options.heartRateEnabled;
    }
    const hasDedicatedAdapters =
      options.bikeAdapter &&
      options.serverAdapter &&
      options.bikeAdapter !== options.serverAdapter;
    if (hasDedicatedAdapters) {
      return true;
    }
    const model = detectBoardModel();
    const runningOnPiZero = model ? isLikelyPiZero(model) : false;
    return !runningOnPiZero;
  }
}
