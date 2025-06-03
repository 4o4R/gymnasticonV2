import {PrimaryService} from '#bleno';
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
