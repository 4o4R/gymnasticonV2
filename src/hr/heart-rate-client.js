import {EventEmitter} from 'events';
import {createNameFilter} from '../util/ble-scan.js';
import {BluetoothConnectionManager} from '../util/connection-manager.js';

const HEART_RATE_SERVICE = '180d';

export class HeartRateClient extends EventEmitter {
  constructor(noble, options = {}) {
    super();
    this.noble = noble;
    this.deviceName = options.deviceName;
    this.serviceUuid = (options.serviceUuid || HEART_RATE_SERVICE).toLowerCase();
    this.connectionManager = options.connectionManager || new BluetoothConnectionManager(noble, {
      timeout: options.connectionTimeout,
      maxRetries: options.connectionRetries,
    });
    this.filter = this.buildFilter();
    this.onDiscover = this.onDiscover.bind(this);
    this.isScanning = false;
  }

  buildFilter() {
    if (this.deviceName) {
      const nameFilter = createNameFilter(this.deviceName);
      return (peripheral) => nameFilter(peripheral) && this.advertisesHrService(peripheral);
    }
    return (peripheral) => this.advertisesHrService(peripheral);
  }

  advertisesHrService(peripheral) {
    return Boolean(
      peripheral?.advertisement?.serviceUuids?.some(
        (uuid) => uuid?.toLowerCase() === this.serviceUuid
      )
    );
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
      await this.noble.startScanningAsync([this.serviceUuid], true);
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
    await this.connectionManager.connect(peripheral);
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
