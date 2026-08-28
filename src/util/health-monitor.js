import { EventEmitter } from 'events';

export class HealthMonitor extends EventEmitter {
  constructor(checkInterval = 5000) {
    super();
    this.metrics = new Map();
    // Teaching note: clamp the interval to a sane minimum so a 0/negative
    // value can't spin checkHealth() in a tight loop where everything is stale.
    this.checkInterval = Number.isFinite(checkInterval) && checkInterval > 0 ? checkInterval : 5000;
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
      timestamp: Date.now(),
      staleEmitted: false
    });
  }

  checkHealth() {
    const now = Date.now();
    for (const [name, metric] of this.metrics) {
      const stale = now - metric.timestamp > this.checkInterval * 2;
      // Teaching note: emit 'stale' only on the transition into staleness, and
      // clear it when data flows again, so consumers don't get a full teardown
      // request every single interval during a long outage.
      if (stale && !metric.staleEmitted) {
        metric.staleEmitted = true;
        this.emit('stale', name);
      } else if (!stale && metric.staleEmitted) {
        metric.staleEmitted = false;
      }
    }
  }
}
