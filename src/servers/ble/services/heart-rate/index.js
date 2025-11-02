import {PrimaryService} from '../../bleno-deps.js'; // import the shared bleno PrimaryService so the fallback logic lives in one helper
import {HeartRateMeasurementCharacteristic} from './characteristics/heart-rate-measurement.js';

/**
 * Heart Rate Service to broadcast heart rate data.
 */
export class HeartRateService extends PrimaryService {
  constructor() {
    super({
      uuid: '180d',
      characteristics: [new HeartRateMeasurementCharacteristic()]
    });
  }

  updateHeartRate(hr) {
    this.characteristics[0].updateHeartRate(hr);
  }
}
