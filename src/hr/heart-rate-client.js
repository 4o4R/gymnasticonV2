import {EventEmitter} from 'events';
import {createNameFilter} from '../util/ble-scan.js';
import {ScanCoordinator, createScanTag} from '../util/scan-coordinator.js';
import {BluetoothConnectionManager} from '../util/connection-manager.js';
import {disconnectPeripheral} from '../util/noble-wrapper.js';

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
    this.attempt = null;
    this.setupTimeoutMs = options.setupTimeoutMs || options.connectionTimeout || 10000;
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
    try {
      const scanning = await this.scanCoordinator.acquire(this.scanTag);
      if (this.stopped || this.connecting || this.connected) {
        // Shutdown or a discovered peripheral already ended this scan attempt.
        await this.releaseScan();
        return;
      }
      if (!scanning) {
        const error = new Error('Heart-rate scan was cancelled before discovery started');
        error.code = 'BLE_SCAN_CANCELLED';
        throw error;
      }
      this.isScanning = true;
    } catch (error) {
      this.detachDiscoverListener();
      await this.releaseScan();
      if (this.stopped || this.connecting || this.connected) return;
      throw error;
    }
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
    const attempt = {peripheral, generation: this.generation, characteristic: null};
    this.attempt = attempt;
    this.connecting = true;
    this.detachDiscoverListener();
    await this.stopSharedScan();
    if (this.stopped || attempt.generation !== this.generation) {
      if (this.attempt === attempt) this.attempt = null;
      return;
    }
    this.peripheral = peripheral;
    // Listen before the first GATT request. Noble leaves discovery promises
    // pending when a console disconnects midway through setup.
    attempt.onDisconnect = () => {
      if (this.attempt === attempt) this.onPeripheralDisconnect();
    };
    peripheral.on('disconnect', attempt.onDisconnect);
    const interrupted = new Promise((_resolve, reject) => {
      attempt.cancel = reject;
    });
    const timer = setTimeout(() => attempt.cancel(new Error('Heart-rate setup timed out')), this.setupTimeoutMs);
    const step = async work => {
      const result = await Promise.race([work, interrupted]);
      if (this.stopped || this.attempt !== attempt || attempt.generation !== this.generation) {
        throw new Error('Heart-rate setup superseded');
      }
      return result;
    };
    try {
      const connection = this.connectionManager.connect(peripheral, {
        isCancelled: () => this.stopped || this.attempt !== attempt,
      });
      Promise.resolve(connection).then(() => {
        if (this.stopped || this.attempt !== attempt) void disconnectPeripheral(peripheral);
      }, () => {});
      await step(connection);
      const services = await step(peripheral.discoverServicesAsync([this.serviceUuid]));
      if (!services || !services.length) {
        throw new Error('heart rate service missing');
      }
      const characteristics = await step(services[0].discoverCharacteristicsAsync([this.characteristicUuid]));
      if (!characteristics || !characteristics.length) {
        throw new Error('heart rate characteristic missing');
      }
      this.characteristic = characteristics[0];
      attempt.characteristic = this.characteristic;
      this.characteristic.on('data', this.onCharData);
      await step(this.characteristic.subscribeAsync());
      this.connected = true;
      this.connecting = false;
      this.emit('connect', {address: peripheral.address});
    } catch (error) {
      // Teaching note: a failed GATT setup must release the physical link.
      // Dropping the reference alone left the peripheral connected with no
      // client listening, which blocks every later connect attempt.
      await this.abandonConnection(attempt);
      if (this.stopped || attempt.generation !== this.generation) {
        return;
      }
      this.restartScan().catch((err) => {
        console.warn('HeartRateClient restart failed', err);
      });
    } finally {
      clearTimeout(timer);
      attempt.cancel = null;
    }
  }

  /**
   * Clear local state and disconnect the peripheral we were working with.
   * @private
   */
  async abandonConnection(attempt = this.attempt) {
    const peripheral = attempt?.peripheral || this.peripheral;
    attempt?.characteristic?.removeListener('data', this.onCharData);
    if (attempt?.onDisconnect) peripheral?.removeListener('disconnect', attempt.onDisconnect);
    if (!attempt || this.attempt === attempt) this.cleanupConnectionState();
    if (attempt) {
      attempt.releasePromise = attempt.releasePromise || disconnectPeripheral(peripheral);
      await attempt.releasePromise;
    } else {
      await disconnectPeripheral(peripheral);
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
    if (this.connecting && this.attempt?.cancel) {
      this.attempt.cancel(new Error('Heart-rate peripheral disconnected during setup'));
      return;
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
      this.characteristic.removeListener('data', this.onCharData);
      this.characteristic = null;
    }
    if (this.peripheral) {
      this.peripheral.removeListener('disconnect', this.attempt?.onDisconnect || this.onPeripheralDisconnect);
      this.peripheral = null;
    }
    this.attempt = null;
  }

  async disconnect() {
    // Latch the stop first so every in-flight step bails out at its next check.
    this.stopped = true;
    this.generation += 1;
    this.detachDiscoverListener();
    const attempt = this.attempt;
    attempt?.cancel?.(new Error('Heart-rate connection stopped'));
    await this.stopSharedScan();
    // Releasing the link also ends notifications; an unsubscribe request on a
    // dead radio can itself wait forever and must not block service shutdown.
    await this.abandonConnection(attempt);
  }
}
