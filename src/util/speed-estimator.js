// Provide a simple helper for estimating linear wheel speed when a bike lacks native speed telemetry.

export function estimateSpeedMps(cadenceRpm, options = {}) { // Main export that returns speed in meters per second.
  const { // Pull optional tuning parameters with descriptive defaults.
    circumferenceM = 2.1, // Virtual wheel circumference in meters (roughly a 700x25c road tire).
    gearFactor = 3.0, // Effective drivetrain ratio translating crank revolutions to wheel revolutions.
    min = 0, // Lower clamp so negative cadence never turns into backwards speed.
    max = 25 // Upper clamp around 90 km/h which covers aggressive sprinting.
  } = options;

  const safeCadence = Math.max(0, cadenceRpm); // Ensure we ignore bogus negative cadence readings.
  const revPerSecond = safeCadence / 60; // Convert cadence to crank revolutions per second.
  const wheelRevsPerSecond = revPerSecond * gearFactor; // Scale by the virtual gear ratio to emulate wheel spin.
  const speed = wheelRevsPerSecond * circumferenceM; // Convert wheel revolutions to meters per second using circumference.
  return Math.min(max, Math.max(min, speed)); // Clamp the estimate so we stay within the configured bounds.
}
