import { EventEmitter } from 'events';

export class HealthMonitor extends EventEmitter {
  constructor(checkInterval = 5000) {
    super();
    this.metrics = new Map();
    this.checkInterval = checkInterval;
    this._intervalHandle = null; // Track the Node timer so we can cleanly tear it down when the app stops.
    this.startMonitoring();
  }

  startMonitoring() {
    if (this._intervalHandle) {
      return; // Guard against double starts (useful in tests that manually toggle monitoring).
    }
    this._intervalHandle = setInterval(() => {
      this.checkHealth();
    }, this.checkInterval);
  }

  stopMonitoring() {
    if (!this._intervalHandle) {
      return;
    }
    clearInterval(this._intervalHandle);
    this._intervalHandle = null;
  }

  stop() {
    // Provide a friendlier API alias; App.cleanup() calls stop() directly so
    // callers do not have to remember the exact method name.
    this.stopMonitoring();
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
