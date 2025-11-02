import {Characteristic, Descriptor} from '../../../bleno-deps.js'; // reuse the shared bleno exports so the stub resolution logic stays in one place

/**
 * Bluetooth LE GATT Cycling Power Feature Characteristic implementation.
 */
export class CyclingPowerFeatureCharacteristic extends Characteristic {
  constructor() {
    super({
      uuid: '2a65',
      properties: ['read'],
      descriptors: [
        new Descriptor({
          uuid: '2901',
          value: 'Cycling Power Feature'
        })
      ],
      value: Buffer.from([8,0,0,0]) // crank revolution data
    })
  }
}
