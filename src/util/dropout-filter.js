/**
 * Workaround for an issue in the bikes that occasionally
 * incorrectly report zero cadence (rpm) or zero power (watts)
 *
 * Power dropouts have been observed on the Flywheel bike
 * Power and cadence dropouts have been observed on the Keiser bike
 *
 * This filter can be used for both bikes.
 */
export function createDropoutFilter(options = {}) {
  const opts = {
    threshold: 5,
    timeout: 2000,
    ...options
  };
  
  return function filter(value) {
    // Enhanced dropout detection logic
    const now = Date.now();
    const isValid = value > 0 && value < 2000;
    return isValid ? value : null;
  };
}
