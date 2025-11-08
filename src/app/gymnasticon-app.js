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

export class GymnasticonApp {
  constructor(options = {}) {
    this.options = {...options}; // Keep a local copy so we can add helper instances without mutating caller state.

    // Resolve the config path. Support both the legacy --config flag and the new --config-path option.
    const configPath = this.options.configPath || this.options.config || DEFAULT_CONFIG_PATH;

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
    try {
      fileConfig = await this.configManager.load(); // Load persisted settings (bike type, server name, etc.).
    } catch (error) {
      console.warn(`[GymnasticonApp] ${error.message}; continuing with CLI arguments only.`);
    }

    // CLI options should override file values, so spread fileConfig first.
    const mergedOptions = {
      ...fileConfig,
      ...this.options,
      configManager: this.configManager,
      metricsProcessor: this.metricsProcessor,
      healthMonitor: this.healthMonitor,
      connectionManager: this.connectionManager,
    };
    this.app = new App(mergedOptions);
    await this.app.start();
  }

  async stop() {
    if (this.app) {
      await this.app.stop();
    }
  }
}
