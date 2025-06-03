import {CyclingPowerService} from './services/cycling-power/index.js';
import {CyclingSpeedAndCadenceService} from './services/cycling-speed-and-cadence/index.js';
import {HeartRateService} from './services/heart-rate/index.js';
import {BleServer} from '../../util/ble-server.js';
import { once } from 'events';

export const DEFAULT_NAME = 'Gymnasticon';

export function createServices(options) {
  return [
    new CyclingPowerService(options),
    new CyclingSpeedAndCadenceService(options),
    new HeartRateService(options)
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
      serviceUuids: ['1818', '1816', '180d'] // Power, CSC and Heart Rate UUIDs
    };
  }

  updateHeartRate(hr) {
    const hrService = this.services.find(s => s.uuid === '180d');
    if (hrService) {
      hrService.updateHeartRate(hr);
    }
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
