export class MetricsCollector {
  constructor() {
    this.metrics = new Map();
    this.startTime = Date.now();
  }

  recordMetric(name, value) {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, []);
    }
    this.metrics.get(name).push({
      timestamp: Date.now(),
      value
    });
  }

  getMetrics() {
    return Object.fromEntries(this.metrics);
  }
}
