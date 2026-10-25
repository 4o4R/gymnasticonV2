export class PowerSmoother {
  constructor(smoothingFactor = 0.8) {
    this.smoothingFactor = smoothingFactor;
    this.reset();
  }

  reset() {
    this.lastPower = 0;
    this.initialized = false;
  }

  smooth(power) {
    const safePower = Number.isFinite(power) ? power : 0; // Defensive: keep NaN/undefined from poisoning the filter.

    // A real zero is a stop, not a sample to fade toward over the next ride.
    if (safePower <= 0) {
      this.reset();
      return 0;
    }

    if (!this.initialized) {
      // Seed the EWMA with the very first measurement so we broadcast the bike's
      // real watts immediately instead of fading in from zero.
      this.lastPower = safePower;
      this.initialized = true;
      return Math.round(this.lastPower);
    }

    this.lastPower = (this.smoothingFactor * this.lastPower) +
                     ((1 - this.smoothingFactor) * safePower);
    return Math.round(this.lastPower);
  }
}
