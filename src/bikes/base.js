import { EventEmitter } from 'events';
import { MetricsCollector } from '../util/metrics.js';

export class BaseBikeClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.metrics = new MetricsCollector();
    this.connected = false;
  }

  async connect() {
    throw new Error('Must implement connect() in derived class');
  }

  async disconnect() {
    this.connected = false;
    this.emit('disconnect');
  }

  validateMetrics(metrics) {
    const { power, cadence } = metrics;
    return {
      power: Number.isFinite(power) ? power : 0,
      cadence: Number.isFinite(cadence) ? cadence : 0
    };
  }
}
