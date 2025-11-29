// GymnasticonApp is a thin wrapper around the core App class. It glues in the
// optional subsystems (configuration persistence, connection retries, metrics
// smoothing, and health monitoring) so the higher-level abstractions described
// in the docs become part of the actual runtime.

import {App, defaults as appDefaults} from './app.js';
import {ConfigManager} from '../config/index.js';
import {MetricsProcessor} from '../util/metrics-processor.js';
import {HealthMonitor} from '../util/health-monitor.js';
import {BluetoothConnectionManager} from '../util/connection-manager.js';

const DEFAULT_CONFIG_PATH = '/etc/gymnasticon.json'; // Matches deploy/gymnasticon.service expectations.

/**
 * There are a few option keys that are injected by the CLI/runtime and should
 * always override whatever is in the config file (for example, the BLE noble
 * instance or the helper singletons we construct below). Keeping those keys in
 * a set makes the precedence logic easier to read.
 */
const RUNTIME_ONLY_KEYS = new Set([
  'noble',
  'configManager',
  'metricsProcessor',
  'healthMonitor',
  'connectionManager',
  'configPath',
]);

export class GymnasticonApp {
  constructor(options = {}) {
    this.options = {...options}; // Keep a local copy so we can add helper instances without mutating caller state.

    // Resolve the config path. Support both the legacy --config flag and the new --config-path option.
    const configPath = this.options.configPath || this.options.config || DEFAULT_CONFIG_PATH;
    console.log('[gym-cli] Resolved config path:', configPath);

    // Instantiate helpers, but allow callers (tests) to inject their own instances when needed.
    this.configManager = this.options.configManager || new ConfigManager(configPath, {
      bike: appDefaults.bike,
      serverName: appDefaults.serverName,
      powerScale: appDefaults.powerScale,
    });
    this.metricsProcessor = this.options.metricsProcessor || new MetricsProcessor({
      smoothingFactor: this.options.powerSmoothing,
    });
    this.healthMonitor = this.options.healthMonitor || new HealthMonitor(this.options.healthCheckInterval);
    this.connectionManager = this.options.connectionManager || new BluetoothConnectionManager(this.options.noble, {
      timeout: this.options.connectionTimeout,
      maxRetries: this.options.connectionRetries,
    });

    this.app = null; // Will hold the underlying App once start() runs.
  }

  async start() {
    let fileConfig = {};
    const configPath = this.configManager?.configPath || DEFAULT_CONFIG_PATH;
    console.log('[gym-cli] Loading config from', configPath);
    try {
      fileConfig = await this.configManager.load(); // Load persisted settings (bike type, server name, etc.).
      console.log('[gym-cli] Loaded config:', JSON.stringify(fileConfig));
    } catch (error) {
      console.warn(`[GymnasticonApp] ${error.message}; continuing with CLI arguments only.`);
    }

    // CLI options should override file values, so spread fileConfig first.
    const providedOptionKeys = new Set(this.options.providedOptions || []); // CLI passes camelCase keys it explicitly received.

    // Build the final option bag in three passes:
    //   1. Start from the persisted config so user's saved preferences win by default.
    //   2. Overlay CLI/runtime values *only* when the user explicitly passed the flag
    //      or when the config file did not specify a value.
    //   3. Force-inject the helper singletons so downstream code always shares them.
    const mergedOptions = {...fileConfig};
    for (const [key, value] of Object.entries(this.options)) {
      if (key === 'providedOptions') {
        continue; // This metadata is only used for precedence calculations.
      }
      if (value === undefined) {
        continue; // Ignore undefined CLI values so config-backed data sticks around.
      }
      const wasExplicitlyPassed = providedOptionKeys.has(key);
      const missingFromConfig = !(key in mergedOptions);
      if (RUNTIME_ONLY_KEYS.has(key) || wasExplicitlyPassed || missingFromConfig) {
        mergedOptions[key] = value;
      }
    }

    mergedOptions.configManager = this.configManager;
    mergedOptions.metricsProcessor = this.metricsProcessor;
    mergedOptions.healthMonitor = this.healthMonitor;
    mergedOptions.connectionManager = this.connectionManager;
    console.log('[gym-cli] Effective bike options:', JSON.stringify({
      bike: mergedOptions.bike,
      defaultBike: mergedOptions.defaultBike,
      bikeAdapter: mergedOptions.bikeAdapter,
      serverAdapter: mergedOptions.serverAdapter,
    }));

    this.app = new App(mergedOptions);
    await this.app.start();
  }

  async stop() {
    if (this.app) {
      await this.app.stop();
    }
  }
}
