import {EventEmitter} from 'events';
import {createNameFilter} from '../util/ble-scan.js';

export class HeartRateClient extends EventEmitter {
  constructor(noble, deviceName = 'GARMIN') {
    super();
    this.noble = noble;
    this.filter = createNameFilter(deviceName);
    this.onDiscover = this.onDiscover.bind(this);
    this.isScanning = false;
  }

  async connect() {
    this.noble.on('discover', this.onDiscover);
    await this.startSharedScan();
  }

  async startSharedScan() {
    if (this.isScanning) {
      return;
    }
    try {
      await this.noble.startScanningAsync(null, true);
      this.isScanning = true;
    } catch (error) {
      if (!/already (?:start(ed)? )?scanning/i.test(String(error))) {
        throw error;
      }
    }
  }

  async stopSharedScan() {
    if (!this.isScanning) {
      return;
    }
    try {
      await this.noble.stopScanningAsync();
    } catch (error) {
      if (!/not scanning/i.test(String(error))) {
        throw error;
      }
    } finally {
      this.isScanning = false;
    }
  }

  async onDiscover(peripheral) {
    if (!this.filter(peripheral)) return;
    this.noble.removeListener('discover', this.onDiscover);
    await this.stopSharedScan();
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
    this.noble.removeListener('discover', this.onDiscover);
    if (this.characteristic) {
      this.characteristic.removeAllListeners('data');
      await this.characteristic.unsubscribeAsync();
    }
    if (this.peripheral) {
      await this.peripheral.disconnectAsync();
    }
    await this.stopSharedScan().catch(() => {});
  }
}
