import {EventEmitter} from 'events';
import {createNameFilter} from '../util/ble-scan.js';
import {ScanCoordinator, createScanTag} from '../util/scan-coordinator.js';
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

    // Teaching note: optional sensors share one radio, so discovery goes
    // through the refcounted scan owner instead of stopping the native scan on
    // our own timeout and starving the other clients.
    this.scanCoordinator = options.scanCoordinator || new ScanCoordinator(noble, {logger: options.logger});
    this.scanTag = options.scanTag || createScanTag('heart-rate');

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

    // Intentional-stop latch plus a connection generation counter: every async
    // step re-checks both after an await so a shutdown cannot be undone by an
    // in-flight discovery, and an obsolete connect cannot revive the client.
    this.stopped = false;
    this.generation = 0;
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
    this.stopped = false; // An explicit connect() re-arms a previously stopped client.
    this.attachDiscoverListener();
    await this.startSharedScan();
  }

  async startSharedScan() {
    if (this.isScanning || this.connected || this.stopped) {
      return;
    }
    await this.scanCoordinator.acquire(this.scanTag);
    if (this.stopped) {
      // A disconnect() landed while the shared scan was starting.
      await this.releaseScan();
      return;
    }
    this.isScanning = true;
  }

  async stopSharedScan() {
    this.isScanning = false;
    await this.releaseScan();
  }

  async releaseScan() {
    try {
      await this.scanCoordinator.release(this.scanTag);
    } catch (error) {
      console.warn(`HeartRateClient scan release failed: ${error?.message || error}`);
    }
  }

  async onDiscover(peripheral) {
    if (this.stopped || !this.filter(peripheral) || this.connected || this.connecting) {
      return;
    }
    const generation = this.generation;
    this.connecting = true;
    this.detachDiscoverListener();
    await this.stopSharedScan();
    if (await this.abandonIfObsolete(generation)) {
      return;
    }
    this.peripheral = peripheral;
    try {
      await this.connectionManager.connect(peripheral);
      if (await this.abandonIfObsolete(generation)) {
        return;
      }
      const services = await peripheral.discoverServicesAsync([this.serviceUuid]);
      if (await this.abandonIfObsolete(generation)) {
        return;
      }
      if (!services || !services.length) {
        throw new Error('heart rate service missing');
      }
      const characteristics = await services[0].discoverCharacteristicsAsync([this.characteristicUuid]);
      if (await this.abandonIfObsolete(generation)) {
        return;
      }
      if (!characteristics || !characteristics.length) {
        throw new Error('heart rate characteristic missing');
      }
      this.characteristic = characteristics[0];
      this.characteristic.on('data', this.onCharData);
      await this.characteristic.subscribeAsync();
      if (await this.abandonIfObsolete(generation)) {
        return;
      }
      peripheral.on('disconnect', this.onPeripheralDisconnect);
      this.connected = true;
      this.connecting = false;
      this.emit('connect', {address: peripheral.address});
    } catch (error) {
      // Teaching note: a failed GATT setup must release the physical link.
      // Dropping the reference alone left the peripheral connected with no
      // client listening, which blocks every later connect attempt.
      await this.abandonConnection();
      this.connecting = false;
      if (this.stopped || generation !== this.generation) {
        return;
      }
      this.restartScan().catch((err) => {
        console.warn('HeartRateClient restart failed', err);
      });
    }
  }

  /**
   * Bail out of an in-flight connect when the client was stopped or restarted.
   * @param {number} generation - generation captured when the attempt started.
   * @returns {Promise<boolean>} true when the attempt must be abandoned.
   * @private
   */
  async abandonIfObsolete(generation) {
    if (!this.stopped && generation === this.generation) {
      return false;
    }
    await this.abandonConnection();
    this.connecting = false;
    return true;
  }

  /**
   * Clear local state and disconnect the peripheral we were working with.
   * @private
   */
  async abandonConnection() {
    const peripheral = this.peripheral;
    this.cleanupConnectionState();
    if (!peripheral || typeof peripheral.disconnectAsync !== 'function') {
      return;
    }
    try {
      await peripheral.disconnectAsync();
    } catch (_error) {
      // Already gone, or the link never came up - nothing left to release.
    }
  }

  onCharData(data) {
    if (!data || data.length < 2) {
      return; // Guard against malformed packets.
    }
    const flags = data.readUInt8(0);
    const has16Bit = Boolean(flags & 0x01); // Bit 0 indicates whether HR is 16-bit.
    if (has16Bit && data.length < 3) {
      return; // A 16-bit measurement needs both bytes after the flags field.
    }
    const heartRate = has16Bit
      ? data.readUInt16LE(1) // Little-endian 16-bit heart rate.
      : data.readUInt8(1); // 8-bit heart rate.
    this.emit('heartRate', heartRate);
  }

  onPeripheralDisconnect() {
    if (this.stopped) {
      return; // A deliberate shutdown must not restart discovery.
    }
    const address = this.peripheral?.address;
    this.cleanupConnectionState();
    this.emit('disconnect', {address});
    this.restartScan().catch((err) => {
      console.warn('HeartRateClient reconnect failed', err);
    });
  }

  async restartScan() {
    if (this.stopped || this.connecting || this.connected) {
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
    // Latch the stop first so every in-flight step bails out at its next check.
    this.stopped = true;
    this.generation += 1;
    this.detachDiscoverListener();
    await this.stopSharedScan();

    const characteristic = this.characteristic;
    const peripheral = this.peripheral;
    this.characteristic = null;
    this.peripheral = null;
    this.connected = false;
    this.connecting = false;

    if (characteristic) {
      characteristic.removeAllListeners('data');
      if (typeof characteristic.unsubscribeAsync === 'function') {
        try {
          await characteristic.unsubscribeAsync();
        } catch (_error) {
          // The link may already be down; proceed with the peripheral release.
        }
      }
    }
    if (peripheral) {
      peripheral.removeListener('disconnect', this.onPeripheralDisconnect);
      if (typeof peripheral.disconnectAsync === 'function') {
        try {
          await peripheral.disconnectAsync();
        } catch (_error) {
          // Already disconnected - teardown stays idempotent.
        }
      }
    }
  }
}
