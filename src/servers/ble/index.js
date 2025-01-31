import {CyclingPowerService} from './services/cycling-power';
import {CyclingSpeedAndCadenceService} from './services/cycling-speed-and-cadence';
import {BleServer} from '../../util/ble-server';

export const DEFAULT_NAME = 'Gymnasticon';

export function createServices(options) {
  return [
    new CyclingPowerService(options),
    new CyclingSpeedAndCadenceService(options)
  ];
}

export class GymnasticonServer extends BleServer {
  constructor(bleno, name = DEFAULT_NAME) {
    const services = createServices();
    super(bleno, name, services);
    
    this.advertisingOptions = {
      connectable: true,
      scannable: true,
      includeTxPower: true,
      manufacturerData: Buffer.from([0x01]), // Custom manufacturer data
      serviceUuids: ['1818', '1816'] // Both Power and CSC UUIDs
    };
  }

  async start() {
    if (this.state !== 'stopped') {
      throw new Error('already started');
    }

    this.state = 'starting';
    await once(this.bleno, 'stateChange');
    await this.bleno.startAdvertisingAsync(
      this.name, 
      this.uuids,
      this.advertisingOptions
    );
    await this.bleno.setServicesAsync(this.services);
    this.state = 'started';
  }
}