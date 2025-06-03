import {EventEmitter} from 'events';
import {createNameFilter, scan} from '../util/ble-scan.js';

export class HeartRateClient extends EventEmitter {
  constructor(noble, deviceName = 'GARMIN') {
    super();
    this.noble = noble;
    this.filter = createNameFilter(deviceName);
    this.onDiscover = this.onDiscover.bind(this);
  }

  async connect() {
    this.noble.on('discover', this.onDiscover);
    await this.noble.startScanningAsync(['180d'], true);
  }

  async onDiscover(peripheral) {
    if (!this.filter(peripheral)) return;
    this.noble.removeListener('discover', this.onDiscover);
    await this.noble.stopScanningAsync();
    this.peripheral = peripheral;
    await peripheral.connectAsync();
    const services = await peripheral.discoverServicesAsync(['180d']);
    const chars = await services[0].discoverCharacteristicsAsync(['2a37']);
    this.characteristic = chars[0];
    await this.characteristic.subscribeAsync();
    this.characteristic.on('data', this.handleData.bind(this));
    this.emit('connect', {address: peripheral.address});
  }

  handleData(data) {
    const hr = data.readUInt8(1); // ignore flags
    this.emit('heartRate', hr);
  }

  async disconnect() {
    if (this.characteristic) {
      this.characteristic.removeAllListeners('data');
      await this.characteristic.unsubscribeAsync();
    }
    if (this.peripheral) {
      await this.peripheral.disconnectAsync();
    }
  }
}
