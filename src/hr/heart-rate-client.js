import {EventEmitter} from 'events';
import {createNameFilter} from '../util/ble-scan.js';
import {BluetoothConnectionManager} from '../util/connection-manager.js';

const HEART_RATE_SERVICE = '180d';
const HEART_RATE_CHARACTERISTIC = '2a37';

export class HeartRateClient extends EventEmitter {
  constructor(noble, options = {}) {
    super();
    // Inputs and configuration.
    this.noble = noble;
    this.deviceName = options.deviceName;
    this.serviceUuid = (options.serviceUuid || HEART_RATE_SERVICE).toLowerCase();
    this.characteristicUuid = (options.characteristicUuid || HEART_RATE_CHARACTERISTIC).toLowerCase();
    this.connectionManager = options.connectionManager || new BluetoothConnectionManager(noble, {
      timeout: options.connectionTimeout,
      maxRetries: options.connectionRetries,
    });

    // Build the discovery filter once so every candidate device can be evaluated quickly.
    this.filter = this.buildFilter();

    // Bind helpers once so they can be added/removed from the noble emitter safely.
    this.onDiscover = this.onDiscover.bind(this);
    this.onPeripheralDisconnect = this.onPeripheralDisconnect.bind(this);
    this.onCharData = this.onCharData.bind(this);

    // Track the scanning/connection state so we rearm gracefully during reconnects.
    this.isScanning = false;
    this.discoverListenerAttached = false;
    this.connected = false;
    this.connecting = false;
    this.peripheral = null;
    this.characteristic = null;
  }

  buildFilter() {
    const nameFilter = this.deviceName ? createNameFilter(this.deviceName) : null;
    return (peripheral) => {
      const nameMatches = nameFilter ? nameFilter(peripheral) : false;
      const advertisesService = this.advertisesHrService(peripheral);
      return nameMatches || advertisesService;
    };
  }

  advertisesHrService(peripheral) {
    return Boolean(
      peripheral?.advertisement?.serviceUuids?.some(
        (uuid) => uuid?.toLowerCase() === this.serviceUuid
      )
    );
  }

  attachDiscoverListener() {
    if (this.discoverListenerAttached) {
      return;
    }
    this.noble.on('discover', this.onDiscover);
    this.discoverListenerAttached = true;
  }

  detachDiscoverListener() {
    if (!this.discoverListenerAttached) {
      return;
    }
    this.noble.removeListener('discover', this.onDiscover);
    this.discoverListenerAttached = false;
  }

  async connect() {
    if (this.connected || this.connecting) {
      return;
    }
    this.attachDiscoverListener();
    await this.startSharedScan();
  }

  async startSharedScan() {
    if (this.isScanning || this.connected) {
      return;
    }
    try {
      await this.noble.startScanningAsync([], true);
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
    if (!this.filter(peripheral) || this.connected || this.connecting) {
      return;
    }
    this.connecting = true;
    this.detachDiscoverListener();
    await this.stopSharedScan();
    this.peripheral = peripheral;
    try {
      await this.connectionManager.connect(peripheral);
      const services = await peripheral.discoverServicesAsync([this.serviceUuid]);
      if (!services.length) {
        throw new Error('heart rate service missing');
      }
      const characteristics = await services[0].discoverCharacteristicsAsync([this.characteristicUuid]);
      if (!characteristics.length) {
        throw new Error('heart rate characteristic missing');
      }
      this.characteristic = characteristics[0];
      this.characteristic.on('data', this.onCharData);
      await this.characteristic.subscribeAsync();
      peripheral.on('disconnect', this.onPeripheralDisconnect);
      this.connected = true;
      this.connecting = false;
      this.emit('connect', {address: peripheral.address});
    } catch (error) {
      this.cleanupConnectionState();
      this.restartScan().catch((err) => {
        console.warn('HeartRateClient restart failed', err);
      });
    }
  }

  onCharData(data) {
    if (!data || data.length < 2) {
      return; // Guard against malformed packets.
    }
    const flags = data.readUInt8(0);
    const has16Bit = Boolean(flags & 0x01); // Bit 0 indicates whether HR is 16-bit.
    const heartRate = has16Bit
      ? data.readUInt16LE(1) // Little-endian 16-bit heart rate.
      : data.readUInt8(1); // 8-bit heart rate.
    this.emit('heartRate', heartRate);
  }

  onPeripheralDisconnect() {
    const address = this.peripheral?.address;
    this.cleanupConnectionState();
    this.emit('disconnect', {address});
    this.restartScan().catch((err) => {
      console.warn('HeartRateClient reconnect failed', err);
    });
  }

  async restartScan() {
    if (this.connecting || this.connected) {
      return;
    }
    this.attachDiscoverListener();
    await this.startSharedScan();
  }

  cleanupConnectionState() {
    this.connected = false;
    this.connecting = false;
    if (this.characteristic) {
      this.characteristic.removeAllListeners('data');
      this.characteristic = null;
    }
    if (this.peripheral) {
      this.peripheral.removeListener('disconnect', this.onPeripheralDisconnect);
      this.peripheral = null;
    }
  }

  async disconnect() {
    this.detachDiscoverListener();
    await this.stopSharedScan().catch(() => {});
    if (this.characteristic) {
      this.characteristic.removeAllListeners('data');
      await this.characteristic.unsubscribeAsync().catch(() => {});
      this.characteristic = null;
    }
    if (this.peripheral) {
      await this.peripheral.disconnectAsync().catch(() => {});
      this.peripheral = null;
    }
    this.cleanupConnectionState();
  }
}
