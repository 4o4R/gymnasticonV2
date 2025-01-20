import { BluetoothConnectionManager } from '../util/connection-manager.js';
import { PowerSmoother } from '../util/power-smoother.js';
import { HealthMonitor } from '../util/health-monitor.js';
import { ConfigManager } from '../config/index.js';

export class GymnastriconApp {
  constructor(options) {
    this.configManager = new ConfigManager('/opt/gymnasticon/gymnasticon.json');
    this.connectionManager = new BluetoothConnectionManager(options.noble);
    this.powerSmoother = new PowerSmoother(options.powerSmoothing);
    this.healthMonitor = new HealthMonitor();
    
    // Auto-reconnect setup
    this.healthMonitor.on('stale', this.handleStaleMetrics.bind(this));
  }

  async start() {
    const config = await this.configManager.load();
    // Start services in correct order
    await this.startBluetooth();
    await this.startBikeClient(config);
    await this.startBleServer(config);
  }
}
