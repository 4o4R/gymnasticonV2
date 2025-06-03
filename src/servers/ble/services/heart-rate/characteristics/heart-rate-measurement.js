import {Characteristic, Descriptor} from '#bleno';

/**
 * Bluetooth LE Heart Rate Measurement characteristic.
 */
export class HeartRateMeasurementCharacteristic extends Characteristic {
  constructor() {
    super({
      uuid: '2a37',
      properties: ['notify'],
      descriptors: [
        new Descriptor({ uuid: '2903', value: Buffer.alloc(2) })
      ]
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
