import { PowerSmoother } from './power-smoother.js';

export class MetricsProcessor {
  constructor(options = {}) {
    this.powerSmoother = new PowerSmoother(options.smoothingFactor);
  }

  process(metrics = {}) {
    const power = Number.isFinite(metrics.power) ? metrics.power : 0;
    const cadence = Number.isFinite(metrics.cadence) ? metrics.cadence : 0;
    const speed = Number.isFinite(metrics.speed) ? metrics.speed : undefined;
    const smoothedPower = this.powerSmoother.smooth(power);
    return {
      power: smoothedPower,
      cadence,
      speed,
      timestamp: Date.now()
    };
  }
}
