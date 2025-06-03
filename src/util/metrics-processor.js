import { PowerSmoother } from './power-smoother.js';

export class MetricsProcessor {
  constructor() {
    this.powerSmoother = new PowerSmoother();
    this.lastMetrics = { power: 0, cadence: 0 };
  }

  process(metrics) {
    const smoothedPower = this.powerSmoother.smooth(metrics.power);
    return {
      power: smoothedPower,
      cadence: metrics.cadence,
      timestamp: Date.now()
    };
  }
}
