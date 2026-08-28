import {Characteristic} from '../../../bleno-deps.js'; // reuse the centralized bleno exports so stub resolution stays consistent

/**
 * Bluetooth LE Heart Rate Measurement characteristic.
 */
export class HeartRateMeasurementCharacteristic extends Characteristic {
  constructor() {
    super({
      uuid: '2a37',
      properties: ['notify'] // bleno auto-adds the 0x2902 CCCD for notify characteristics.
    });
  }

  updateHeartRate(heartRate) {
    const flags = 0; // 8-bit HR
    const value = Buffer.alloc(2);
    value.writeUInt8(flags, 0);
    value.writeUInt8(heartRate & 0xff, 1);
    if (this.updateValueCallback) {
      this.updateValueCallback(value);
    }
  }
}
