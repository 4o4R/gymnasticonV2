// Estimate cycling power from cadence and resistance and provide basic smoothing utilities.
// Each line includes a brief comment so you can follow along while reading the code.

export function estimatePower(rpm, resistance, opts = {}) { // Exported function that returns an estimated wattage based on cadence and resistance.
  const { // Pull tuning parameters out of the opts object, falling back to safe defaults when not supplied.
    scale = 1.0, // Multiplier applied to the raw estimate so calibration can stretch the curve.
    offset = 0.0, // Additive offset applied after scaling to bias the curve up or down.
    minWatts = 0, // Lower clamp that prevents negative wattage from ever being returned.
    maxWatts = 2000 // Upper clamp so the estimate never exceeds a realistic bike trainer range.
  } = opts;

  const k = 0.35; // Empirical constant picked so the polynomial produces reasonable wattage for common RPMs.
  const safeResistance = clamp(resistance, 0, 1); // Limit resistance to the expected 0..1 range even if caller sends noisy data.
  const resFactor = 0.4 + 0.6 * safeResistance; // Blend between two constants so resistance influences the power curve smoothly.
  const safeRpm = Math.max(0, rpm); // Guard against negative cadences that can leak in from sensors as bikes spin down.
  const cadenceTerm = Math.pow(safeRpm, 1.75); // Non-linear cadence term that grows slightly faster than a square relationship.
  const baseWatts = k * cadenceTerm * resFactor; // Combine cadence curve, resistance factor, and constant multiplier to get the base estimate.
  const adjusted = baseWatts * scale + offset; // Apply user-provided calibration so different bikes can be tuned without code changes.
  const clamped = clamp(adjusted, minWatts, maxWatts); // Prevent out-of-range values from propagating through the rest of the app.
  return Math.round(clamped); // Round to the nearest whole watt since all downstream protocols expect integer wattage.
}

export class Ewma { // Lightweight exponential weighted moving average used to smooth power noise.
  constructor(alpha = 0.3) { // alpha determines how quickly the smoother reacts; higher is more responsive.
    this.alpha = alpha; // Store the smoothing factor so push() can apply it later.
    this.initialized = false; // Track whether we've seen the first data point yet.
    this.value = 0; // Hold the running smoothed value.
  }

  push(sample) { // Feed a new sample into the smoother and return the updated value.
    if (!this.initialized) { // First sample simply seeds the accumulator.
      this.value = sample; // Set the running value to the first measurement directly.
      this.initialized = true; // Flip the flag so future samples follow the EWMA formula.
    } else { // Subsequent samples blend old and new values.
      this.value = this.alpha * sample + (1 - this.alpha) * this.value; // Standard EWMA update step.
    }
    return Math.round(this.value); // Return the smoothed value rounded to an integer for downstream consumers.
  }
}

function clamp(value, lo, hi) { // Helper that keeps a number between a lower and upper bound.
  return Math.min(hi, Math.max(lo, value)); // Use Math helpers to perform the clamp in a single expression.
}
