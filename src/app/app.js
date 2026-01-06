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

// Core server components
import {execSync} from 'child_process'; // Spawn lightweight system probes (hciconfig) when noble never reports a state.
import {GymnasticonServer} from '../servers/ble/index.js';
import {AntServer} from '../servers/ant/index.js';

// Bike and sensor integrations
import {createBikeClient, getBikeTypes} from '../bikes/index.js';
import {HeartRateClient} from '../hr/heart-rate-client.js';
import {MetricsProcessor} from '../util/metrics-processor.js';
import {HealthMonitor} from '../util/health-monitor.js';
import {BluetoothConnectionManager} from '../util/connection-manager.js';
import {initializeBluetooth} from '../util/noble-wrapper.js';
import {normalizeAdapterId} from '../util/adapter-id.js';
import {detectAdapters} from '../util/adapter-detect.js';

// Utility modules
import {Simulation} from './simulation.js'; // Simulation helper for bot mode and testing.
import {Timer} from '../util/timer.js'; // Shared timer utility that handles repeating and one-shot events.
import {Logger} from '../util/logger.js'; // Lightweight logger abstraction.
import {createAntStick} from '../util/ant-stick.js'; // Factory for gd-ant-plus sticks.
import {estimateSpeedMps} from '../util/speed-estimator.js'; // Helper that estimates speed when bikes do not report it.
import {nowSeconds} from '../util/time.js'; // Helper to get monotonic-ish timestamps in seconds.
import {loadDependency, toDefaultExport} from '../util/optional-deps.js'; // Optional dependency loader with stub fallback support.
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
    this.heartRateNoble = opts.heartRateNoble || this.noble;
    this.heartRateAdapter = opts.heartRateAdapter;
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

    // Heart-rate capture: enable automatically only when we know two adapters are present.
    // Teaching note: keep a bound handler so we can reuse it when rebuilding the HR client.
    this.onHeartRateBound = this.onHeartRate.bind(this);
    let heartRatePreference = null; // null => auto, true => force, false => disable.
    if (typeof opts.heartRateEnabled === 'boolean') {
      heartRatePreference = opts.heartRateEnabled;
    } else if (opts.heartRateDevice) {
      heartRatePreference = true; // requesting a specific device implies they want HR.
    }
    const autoAllowed = Boolean(opts.multiAdapter); // Only dual-radio setups auto-enable HR by default.
    // Teaching note: if the user *explicitly* asked for HR, honor it even on
    // single-adapter setups (the README calls this out as a supported override).
    this.heartRateAutoPreference = heartRatePreference === null ? autoAllowed : heartRatePreference;
    if (this.heartRateAutoPreference) {
      if (heartRatePreference === true && !autoAllowed) {
        this.logger.log('Heart-rate rebroadcast forced on single adapter; expect BLE contention');
      }
      const hrNoble = this.heartRateNoble;
      if (hrNoble !== this.noble) {
        this.logger.log(`Heart-rate client using dedicated adapter ${this.heartRateAdapter}`);
      }
      this.hrClient = new HeartRateClient(hrNoble, {
        deviceName: opts.heartRateDevice,
        serviceUuid: opts.heartRateServiceUuid,
        connectionManager: this.connectionManager,
      });
      this.hrClient.on('heartRate', this.onHeartRateBound);
    } else {
      this.hrClient = null;
      if (heartRatePreference === false) {
        this.logger.log('Heart-rate rebroadcast disabled per configuration');
      } else {
        this.logger.log('Heart-rate rebroadcast disabled (auto mode requires two adapters or supported hardware)');
      }
    }
    // Teaching note: only include the HR GATT service when we expect to rebroadcast HR.
    this.server = new GymnasticonServer(this.bleno, opts.serverName, {
      includeHeartRate: this.heartRateAutoPreference,
    });

    if (this.healthMonitor) {
      this.healthMonitor.on('stale', this.onHealthMetricStale.bind(this));
    }

    this.onSigInt = this.onSigInt.bind(this);
    this.onExit = this.onExit.bind(this);
    // Teaching note: keep stable references to bike event handlers so we can
    // attach/detach listeners safely across reconnect attempts.
    this.onBikeDisconnectBound = this.onBikeDisconnect.bind(this);
    this.onBikeStatsBound = this.onBikeStats.bind(this);

    // Teaching note: track advertising separately so we can stop broadcasting
    // when the bike disconnects (per user expectation).
    this.serverStarted = false;

    // Teaching note: reconnect flow uses a small "deferred" promise so event
    // handlers can signal the main loop to restart without exiting the process.
    this.restartSignal = null;
    this.restartReason = null;
    this.pendingRestartReason = null;
    
    // Modern Bluetooth configuration
    // Teaching note: noble/bleno want a numeric HCI index in the env vars,
    // so convert "hci0" style names before setting them.
    this.setBikeAdapter(opts.bikeAdapter, 'startup');
    this.setServerAdapter(opts.serverAdapter, 'startup');
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

  async ensureServerStarted(reason = 'unspecified') {
    if (this.serverStarted) {
      return; // Teaching note: skip work when advertising is already live.
    }
    this.logger.log(`[gym-app] starting BLE server (${reason})`);
    // Teaching note: bleno throws if the adapter cannot advertise; we let the
    // caller decide how to retry.
    await this.server.start();
    this.serverStarted = true;
    this.logger.log('[gym-app] BLE server advertising');
  }

  setBikeAdapter(adapter, reason = 'unspecified') {
    // Teaching note: normalize adapter names so "hci0" becomes "0", which
    // noble understands when it parses the environment variable.
    const adapterId = normalizeAdapterId(adapter);
    if (adapterId === undefined) {
      this.logger.log('[gym-app] unable to normalize bike adapter ID:', adapter);
      return false;
    }
    this.opts.bikeAdapter = adapter;
    process.env['NOBLE_HCI_DEVICE_ID'] = adapterId;
    this.logger.log(`[gym-app] bike adapter set to ${adapter} (id=${adapterId}) [${reason}]`);
    return true;
  }

  setServerAdapter(adapter, reason = 'unspecified') {
    // Teaching note: bleno uses a separate env var but the same numeric HCI index.
    const adapterId = normalizeAdapterId(adapter);
    if (adapterId === undefined) {
      this.logger.log('[gym-app] unable to normalize server adapter ID:', adapter);
      return false;
    }
    this.opts.serverAdapter = adapter;
    process.env['BLENO_HCI_DEVICE_ID'] = adapterId;
    this.logger.log(`[gym-app] server adapter set to ${adapter} (id=${adapterId}) [${reason}]`);
    return true;
  }

  attachNobleDiagnostics() {
    // Teaching note: log noble warnings/errors once per instance so we can
    // see why the adapter stays in "unknown" state.
    if (!this.noble || this.noble.__gymnasticonDiagnosticsAttached) {
      return;
    }
    this.noble.__gymnasticonDiagnosticsAttached = true;
    this.noble.on('warning', (message) => {
      this.logger.log('[gym-app] noble warning:', message);
    });
    this.noble.on('error', (error) => {
      this.logger.error('[gym-app] noble error:', error);
    });
    this.noble.on('stateChange', (nextState) => {
      this.logger.log(`[gym-app] noble stateChange event: ${nextState}`);
    });
  }

  getFallbackAdapters() {
    // Teaching note: we only attempt fallback adapters on Linux where the
    // sysfs discovery is available.
    try {
      const detection = detectAdapters();
      const adapters = detection.adapters || [];
      return adapters.filter((name) => name && name !== this.opts.bikeAdapter);
    } catch (_error) {
      return [];
    }
  }

  async stopServerAdvertising(reason = 'unspecified') {
    if (!this.serverStarted) {
      return; // Teaching note: no-op if advertising never started.
    }
    this.logger.log(`[gym-app] stopping BLE server (${reason})`);
    await this.server.stop();
    this.serverStarted = false;
    this.logger.log('[gym-app] BLE server stopped');
  }

  async waitForRestartSignal() {
    // Teaching note: create a one-shot promise that resolves when an event
    // handler requests a reconnect (stats timeout, disconnect, etc).
    this.restartSignal = createDeferred();
    this.restartReason = null;
    if (this.pendingRestartReason) {
      // Teaching note: if a timeout fired before we started waiting, consume it now.
      const reason = this.pendingRestartReason;
      this.pendingRestartReason = null;
      this.restartSignal.resolved = true;
      this.restartSignal.resolve(reason);
    }
    const reason = await this.restartSignal.promise;
    this.logger.log(`[gym-app] reconnect requested (${reason})`);
  }

  requestRestart(reason) {
    if (!this.restartSignal || this.restartSignal.resolved) {
      // Teaching note: if we are not currently waiting, stash the reason so the
      // next wait cycle can pick it up.
      this.pendingRestartReason = reason;
      return;
    }
    this.restartReason = reason;
    this.restartSignal.resolved = true;
    this.restartSignal.resolve(reason);
  }

  async stopBikeConnection({ stopServer = false } = {}) {
    // Teaching note: this cleans up the bike connection and optionally stops
    // advertising when we should not broadcast without a bike.
    this.statsTimeout.cancel();
    this.connectTimeout.cancel();
    if (this.bike) {
      this.bike.off('disconnect', this.onBikeDisconnectBound);
      this.bike.off('stats', this.onBikeStatsBound);
      if (this.bike.disconnect) {
        await this.bike.disconnect().catch(() => {});
      }
      this.bike = null;
    }
    if (stopServer) {
      // Teaching note: stop ANT+ broadcasts when the bike is unavailable so
      // we do not send stale data to head units.
      this.stopAnt();
      // Teaching note: stop the HR bridge so we are not rebroadcasting HR
      // when there is no bike session in progress.
      if (this.hrClient) {
        await this.hrClient.disconnect().catch(() => {});
      }
      await this.stopServerAdvertising('bike-connection-stop');
    }
  }

  async ensureBluetoothPoweredOn() {
    // Teaching note: noble can get stuck in "unknown" state if the adapter id is
    // invalid or the HCI socket did not initialize, so we retry with timeouts.
    const maxAttempts = 3;
    const timeoutMs = 15000;
    const retryDelayMs = 2000;
    const fallbackAdapters = this.getFallbackAdapters();
    let fallbackIndex = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.attachNobleDiagnostics(); // Teaching note: always log noble state changes and warnings.
      const state = this.noble?.state ?? 'unknown';
      if (state === 'poweredOn') {
        return;
      }
      // Teaching note: some BlueZ stacks never emit a noble state change even
      // though the adapter is up. When that happens, trust hciconfig and keep
      // going instead of restarting the whole service forever.
      if (state === 'unknown' && this.isAdapterUp(this.opts.bikeAdapter)) {
        // Teaching note: noble gates startScanningAsync() on its internal state.
        // If BlueZ never emits a stateChange but hciconfig shows the adapter
        // is UP, we force the state to poweredOn so scans can start.
        this.forceNoblePoweredOn('hciconfig');
        return;
      }
      this.logger.log(`[gym-app] waiting for Bluetooth adapter to become poweredOn (attempt ${attempt}/${maxAttempts}, current state: ${state})`);
      try {
        const nextState = await this.waitForNobleStateChange(timeoutMs);
        if (nextState === 'poweredOn') {
          return;
        }
        this.logger.log(`[gym-app] Bluetooth adapter state is ${nextState}; reinitializing noble`);
      } catch (error) {
        this.logger.log(`[gym-app] Bluetooth adapter state timeout after ${timeoutMs}ms; reinitializing noble`);
      }
      const fallback = fallbackAdapters[fallbackIndex];
      if (fallback) {
        fallbackIndex += 1;
        // Teaching note: if the primary adapter does not power on, try another
        // detected adapter before giving up.
        this.logger.log(`[gym-app] adapter ${this.opts.bikeAdapter} failed to power on; trying ${fallback}`);
        this.setBikeAdapter(fallback, 'fallback');
        await this.reinitializeNoble(`fallback-${attempt}`);
      } else {
        await this.reinitializeNoble(`attempt-${attempt}`);
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }

    throw new Error('Bluetooth adapter never reached poweredOn');
  }

  isAdapterUp(adapterName) {
    // Teaching note: noble sometimes never updates state on some kernels, but
    // hciconfig still reports the true adapter status.
    if (!adapterName) {
      return false;
    }
    try {
      const output = execSync(`hciconfig ${adapterName}`, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString();
      return /UP RUNNING/.test(output);
    } catch (_error) {
      return false;
    }
  }

  forceNoblePoweredOn(reason) {
    if (!this.noble) {
      return;
    }
    // Teaching note: noble exposes `state` as a getter-only property, so
    // assigning to it throws. The internal `_state` is what startScanning()
    // actually checks, so we update `_state` directly instead.
    if ('_state' in this.noble) {
      this.noble._state = 'poweredOn';
    }
    // Teaching note: emit the stateChange event so any listeners stay in sync
    // with the forced state (e.g., logs or adapter watchers).
    if (typeof this.noble.emit === 'function') {
      this.noble.emit('stateChange', 'poweredOn');
    }
    this.logger.log(`[gym-app] forcing noble state to poweredOn (${reason})`);
  }

  async waitForNobleStateChange(timeoutMs) {
    // Teaching note: wait specifically for a *usable* adapter state. Some
    // stacks emit transient "poweredOff" before settling into "poweredOn",
    // so we ignore intermediate states until we see a final answer or time out.
    if (!this.noble?.on) {
      throw new Error('noble instance unavailable');
    }
    const terminalStates = new Set(['poweredOn', 'unsupported', 'unauthorized']);
    return new Promise((resolve, reject) => {
      const onChange = (nextState) => {
        if (!terminalStates.has(nextState)) {
          return; // keep waiting; the adapter may still be powering up
        }
        cleanup();
        resolve(nextState);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Bluetooth adapter state timeout'));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.noble.removeListener('stateChange', onChange);
      };
      this.noble.on('stateChange', onChange);
    });
  }

  async reinitializeNoble(reason) {
    // Teaching note: force a fresh noble instance so the HCI socket is reopened.
    this.logger.log(`[gym-app] reinitializing noble (${reason})`);
    const { noble } = await initializeBluetooth(this.opts.bikeAdapter, { forceNewInstance: true });
    this.noble = noble;
    this.opts.noble = noble;
    this.attachNobleDiagnostics(); // Teaching note: reattach diagnostics to the new instance.
    // Teaching note: rebuild the connection manager so heart-rate scans use the new noble.
    this.connectionManager = new BluetoothConnectionManager(this.noble, {
      timeout: this.opts.connectionTimeout,
      maxRetries: this.opts.connectionRetries,
    });
    await this.rebuildHeartRateClient();
  }

  async rebuildHeartRateClient() {
    // Teaching note: only rebuild when HR is enabled and uses the bike adapter.
    if (!this.heartRateAutoPreference) {
      return;
    }
    const wantsDedicatedAdapter = Boolean(this.heartRateAdapter && this.heartRateAdapter !== this.opts.bikeAdapter);
    const nextNoble = wantsDedicatedAdapter ? this.heartRateNoble : this.noble;
    this.heartRateNoble = nextNoble;
    if (this.hrClient) {
      await this.hrClient.disconnect().catch(() => {});
    }
    this.hrClient = new HeartRateClient(nextNoble, {
      deviceName: this.opts.heartRateDevice,
      serviceUuid: this.opts.heartRateServiceUuid,
      connectionManager: this.connectionManager,
    });
    this.hrClient.on('heartRate', this.onHeartRateBound);
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
    // Teaching note: use the helper so the internal flag stays in sync.
    await this.stopServerAdvertising('app-stop');
    this.stopAnt();
    if (this.hrClient) {
      await this.hrClient.disconnect();
    }
    if (this.healthMonitor?.stop) {
      // Shutting down the periodic monitor prevents Node from holding the event
      // loop open and ensures repeated starts (during development or CLI
      // restarts) do not create leaked intervals.
      this.healthMonitor.stop();
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

      const state = this.noble?.state;
      this.logger.log(`[gym-app] checking Bluetooth adapter state: ${state ?? 'unknown'}`);
      this.attachNobleDiagnostics(); // Teaching note: log noble warnings/errors right away.
      await this.ensureBluetoothPoweredOn();
      this.logger.log('[gym-app] Bluetooth adapter ready (poweredOn)');

      const retryDelayMs = Math.max(1000, Number(this.opts.connectionRetryDelay ?? sharedDefaults.connectionRetryDelay ?? 5000)); // Guarantee at least a one-second delay between attempts even if the config requests 0.
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); // Lightweight helper so the retry loop can pause via await without blocking Node's event loop.
      this.logger.log(`[gym-app] startup opts: bike=${this.opts.bike} defaultBike=${this.opts.defaultBike} bikeAdapter=${this.opts.bikeAdapter} serverAdapter=${this.opts.serverAdapter}`);

      while (true) { // Keep looping until we successfully complete the full startup sequence.
        try {
          this.logger.log('connecting to bike...'); // Show progress on the console so headless installs still provide feedback.
          this.bike = await createBikeClient(this.opts, this.noble); // Instantiate the bike client selected via config/CLI (autodetect, keiser, etc.).
          // Teaching note: using bound handlers allows us to remove listeners when we reconnect.
          this.bike.on('disconnect', this.onBikeDisconnectBound); // Restart the app when the bike disconnects unexpectedly.
          this.bike.on('stats', this.onBikeStatsBound); // Stream bike telemetry into the BLE/ANT broadcasters.
          this.connectTimeout.reset(); // Arm the watchdog so wedged BLE connections do not hang forever.
          await this.bike.connect(); // Begin scanning or connecting based on the specific bike implementation.
          this.connectTimeout.cancel(); // Clear the watchdog because the connect phase finished successfully.
          this.logger.log(`bike connected ${this.bike.address}`); // Log the MAC so users can confirm which console paired.
          // Teaching note: only advertise once the bike is connected so we do
          // not broadcast phantom sensors while idle.
          await this.ensureServerStarted('bike-connected');
          if (this.antEnabled) { // Only talk to the ANT+ stick when the user opted in.
            this.startAnt(); // Fire up ANT+ broadcasting (no-op if the stick is missing).
          }
          if (this.hrClient) {
            try {
              await this.hrClient.connect(); // Attempt to bring up the optional heart-rate bridge.
            } catch (err) {
              this.logger.error('Heart-rate setup failed; continuing without HR data', err); // Never abort startup when HR pairing fails.
              await this.hrClient.disconnect().catch(() => {}); // Ensure failed attempts do not leave dangling BLE scans.
              this.hrClient = null; // Disable HR until the service restarts to avoid noisy retries.
            }
          }
          this.pingInterval.reset(); // Kick off the BLE keep-alive timer so Zwift sees data even when you pause pedaling.
          this.statsTimeout.reset(); // Start the "bike telemetry" watchdog so we can log when stats go stale.
          // Teaching note: stay in the loop and wait for a disconnect/timeout so
          // we can reconnect without killing the whole systemd service.
          await this.waitForRestartSignal();
          // Teaching note: once a restart is requested, tear down the bike
          // connection and stop advertising until we reconnect.
          await this.stopBikeConnection({ stopServer: true });
        } catch (e) {
          this.logger.error(e); // Surface the failure reason so users can photograph the console for debugging.
          // Teaching note: stop advertising on errors so we only broadcast when
          // a bike is actually connected.
          await this.stopBikeConnection({ stopServer: true }).catch(() => {}); // Tear down partial bike state before the next attempt.
          this.logger.log(`retrying connection in ${retryDelayMs / 1000}s (adjust with --connection-retry-delay)`); // Give a friendly heads-up that retries are automatic.
          await sleep(retryDelayMs); // Wait before the next attempt to avoid hammering the Bluetooth stack.
        }
      }
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
    // Teaching note: treat missing stats as a disconnect; zero metrics so we
    // do not broadcast stale power/cadence while we reconnect.
    this.power = 0;
    this.currentCadence = 0;
    this.publishTelemetry();
    // Teaching note: stop ANT+ immediately so head units stop seeing stale data.
    this.stopAnt();
    // Teaching note: stop HR scanning during reconnect to reduce BLE contention.
    if (this.hrClient) {
      this.hrClient.disconnect().catch(() => {});
    }
    // Teaching note: stop advertising asynchronously so we only broadcast when
    // a bike is actively connected.
    this.stopServerAdvertising('bike-stats-timeout').catch(() => {});
    this.requestRestart('bike-stats-timeout');
  }

  onBikeDisconnect({ address }) {
    this.logger.log(`bike disconnected ${address}`);
    // Teaching note: disconnects should trigger a clean reconnect cycle rather
    // than killing the whole service.
    // Teaching note: zero out the metrics immediately so apps don't keep
    // showing stale power/cadence while we reconnect.
    this.power = 0;
    this.currentCadence = 0;
    this.publishTelemetry();
    // Teaching note: stop ANT+ immediately so head units stop seeing stale data.
    this.stopAnt();
    // Teaching note: stop HR scanning during reconnect to reduce BLE contention.
    if (this.hrClient) {
      this.hrClient.disconnect().catch(() => {});
    }
    // Teaching note: stop advertising so clients do not see a phantom sensor.
    this.stopServerAdvertising('bike-disconnect').catch(() => {});
    this.requestRestart('bike-disconnect');
  }

  onBikeConnectTimeout() {
    this.logger.log(`bike connection timed out after ${this.connectTimeout.interval}s`);
    // Teaching note: force a reconnect attempt instead of exiting so systemd
    // restarts are no longer required to recover.
    if (this.bike?.disconnect) {
      this.bike.disconnect().catch(() => {});
    }
    // Teaching note: stop ANT+ immediately so we do not broadcast with no bike.
    this.stopAnt();
    // Teaching note: stop HR scanning during reconnect to reduce BLE contention.
    if (this.hrClient) {
      this.hrClient.disconnect().catch(() => {});
    }
    // Teaching note: stop advertising during connection failures so we only
    // broadcast once a bike is actually connected.
    this.stopServerAdvertising('bike-connect-timeout').catch(() => {});
    this.requestRestart('bike-connect-timeout');
  }

  startAnt() {
    if (!this.antEnabled || !this.antStick || !this.antServer) { // Skip when ANT+ broadcasting is disabled or hardware unavailable.
      return;
    }
    try {
      if (!this.antStick.is_present()) { // If the stick is not detected, log and fall back to BLE-only mode.
        this.logger.log('no ANT+ stick found');
        return;
      }
    } catch (err) {
      this.logger.error('failed to probe ANT+ stick; continuing without ANT+', err);
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

}

// Teaching note: a tiny "deferred" promise helper so event handlers can
// trigger a reconnect while the main loop awaits a signal.
function createDeferred() {
  let resolve;
  const promise = new Promise((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve, resolved: false };
}
