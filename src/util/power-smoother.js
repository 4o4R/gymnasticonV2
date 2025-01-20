export class PowerSmoother {
  constructor(smoothingFactor = 0.8) {
    this.smoothingFactor = smoothingFactor;
    this.lastPower = 0;
  }

  smooth(power) {
    this.lastPower = (this.smoothingFactor * this.lastPower) + 
                     ((1 - this.smoothingFactor) * power);
    return Math.round(this.lastPower);
  }
}
