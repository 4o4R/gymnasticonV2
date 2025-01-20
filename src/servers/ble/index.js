import {CyclingPowerService} from './services/cycling-power'
import {CyclingSpeedAndCadenceService} from './services/cycling-speed-and-cadence'
import {BleServer} from '../../util/ble-server'

export const DEFAULT_NAME = 'Gymnasticon';

/**
 * Handles communication with apps (e.g. Zwift) using the standard Bluetooth
 * LE GATT Cycling Power Service.
 */
export class GymnasticonServer extends BleServer {
  constructor(bleno, name) {
    const services = [
      new CyclingPowerService(),
      new CyclingSpeedAndCadenceService()
    ];
    super(bleno, name, services);
    
    // Add modern BLE advertising options
    this.advertisingOptions = {
      connectable: true,
      scannable: true,
      includeTxPower: true
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
