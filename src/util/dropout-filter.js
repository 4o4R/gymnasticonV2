/**
 * Workaround for an issue in the bikes that occasionally
 * incorrectly report zero cadence (rpm) or zero power (watts)
 *
 * Power dropouts have been observed on the Flywheel bike
 * Power and cadence dropouts have been observed on the Keiser bike
 *
 * This filter can be used for both bikes.
 */
export function createDropoutFilter() {
  const last = { power: 0, cadence: 0 };
  const dropped = { power: false, cadence: false };

  return function filter({ power, cadence }) {
    const result = { power, cadence };

    if (power === 0) {
      if (!dropped.power) {
        result.power = last.power;
        dropped.power = true;
      }
    } else {
      last.power = power;
      dropped.power = false;
    }

    if (cadence === 0) {
      if (!dropped.cadence) {
        result.cadence = last.cadence;
        dropped.cadence = true;
      }
    } else {
      last.cadence = cadence;
      dropped.cadence = false;
    }

    return result;
  };
}
