import {loadDependency} from '../../../../util/optional-deps.js';

const blenoModule = loadDependency('@abandonware/bleno', '../../../../../stubs/bleno.cjs', import.meta);
const {PrimaryService} = blenoModule;
import {CyclingPowerMeasurementCharacteristic} from './characteristics/cycling-power-measurement.js';
import {CyclingPowerFeatureCharacteristic} from './characteristics/cycling-power-feature.js';
import {SensorLocationCharacteristic} from './characteristics/sensor-location.js';

/**
 * Bluetooth LE GATT Cycling Power Service implementation.
 */
export class CyclingPowerService extends PrimaryService {
  /**
   * Create a CyclingPowerService instance.
   */
  constructor() {
    super({
      uuid: '1818',
      characteristics: [
        new CyclingPowerMeasurementCharacteristic(),
        new CyclingPowerFeatureCharacteristic(),
        new SensorLocationCharacteristic(),
      ]
    })
  }

  /**
   * Notify subscriber (e.g. Zwift) of new Cycling Power Measurement.
   * @param {object} measurement - new cycling power measurement.
   * @param {number} measurement.power - current power (watts)
	 * @param {object} [measurement.crank] - last crank event.
   * @param {number} measurement.crank.revolutions - revolution count at last crank event.
   * @param {number} measurement.crank.timestamp - timestamp at last crank event.
   */
  updateMeasurement(measurement) {
    this.characteristics[0].updateMeasurement(measurement)
  }
}
