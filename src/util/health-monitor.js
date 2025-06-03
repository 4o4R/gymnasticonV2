import { EventEmitter } from 'events';

export class HealthMonitor extends EventEmitter {
  constructor(checkInterval = 5000) {
    super();
    this.metrics = new Map();
    this.checkInterval = checkInterval;
    this.startMonitoring();
  }

  startMonitoring() {
    setInterval(() => {
      this.checkHealth();
    }, this.checkInterval);
  }

  recordMetric(name, value) {
    this.metrics.set(name, {
      value,
      timestamp: Date.now()
    });
  }

  checkHealth() {
    const now = Date.now();
    for (const [name, metric] of this.metrics) {
      if (now - metric.timestamp > this.checkInterval * 2) {
        this.emit('stale', name);
      }
    }
  }
}
