import {EventEmitter} from 'events'; // Base class so the client can emit measurement events.
import {scan} from '../util/ble-scan.js'; // Helper that performs BLE scans using noble.
import {loadDependency, toDefaultExport} from '../util/optional-deps.js'; // Optional dependency loader so we can swap in stubs.
import {estimatePower, Ewma} from '../util/power-estimator.js'; // Shared helpers for power estimation and smoothing.

const nobleModule = loadDependency('@abandonware/noble', '../../stubs/noble.cjs', import.meta); // Load noble with stub fallback.
const Noble = toDefaultExport(nobleModule);
const debugModule = loadDependency('debug', '../../stubs/debug.cjs', import.meta); // Debug logging helper.
const debug = toDefaultExport(debugModule)('gym:bikes:ic8');

const FTMS_SERVICE_UUID = '1826'; // Fitness Machine Service UUID.
const CSC_SERVICE_UUID = '1816'; // Cycling Speed and Cadence service for cadence data.
const CSC_MEASUREMENT_UUID = '2a5b'; // CSC Measurement characteristic.

export class Ic8BikeClient extends EventEmitter { // Schwinn IC8 / Bowflex C6 client that estimates power from cadence + resistance.
  constructor({ noble = Noble, log = console, config = {} } = {}) {
    super();
    this.noble = noble; // Noble instance used for BLE operations.
    this.log = log; // Logger interface (console by default).
    this.config = config; // Optional calibration config for power estimation.
    this.device = null; // Active noble peripheral once connected.
    this.state = { rpm: 0, resistance: 0, watts: 0 }; // Track the latest cadence/resistance/power values.
    this.powerFilter = new Ewma(0.25); // Smooth power readings to reduce jitter for downstream apps.
  }

  static get label() { // Friendly identifier shown in logs and UI.
    return 'schwinn-ic8';
  }

  static matchesAdvertisement(peripheral) { // Heuristic used during autodetect to identify IC8/C6 bikes.
    const name = (peripheral?.advertisement?.localName || '').toLowerCase();
    if (!name) return false;
    return name.includes('ic8') || name.includes('c6') || name.includes('schwinn') || name.includes('bowflex');
  }

  async connect() { // Discover and subscribe to the bike's CSC notifications and optional resistance characteristic.
    const scanOptions = { allowDuplicates: false, active: true }; // Active scan improves discovery time for these bikes.
    this.log.info?.('Scanning for Schwinn IC8 / Bowflex C6');
    const peripheral = await scan(this.noble, [CSC_SERVICE_UUID, FTMS_SERVICE_UUID], Ic8BikeClient.matchesAdvertisement, scanOptions);
    if (!peripheral) {
      throw new Error('Unable to find Schwinn IC8 / Bowflex C6 bike');
    }
    this.device = peripheral;
    await peripheral.connectAsync();
    this.log.info?.('Connected to IC8 peripheral', peripheral.address);

    const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [CSC_SERVICE_UUID, FTMS_SERVICE_UUID],
      []
    );

    const cscMeasurement = characteristics.find(ch => ch.uuid === CSC_MEASUREMENT_UUID);
    if (!cscMeasurement) {
      throw new Error('CSC Measurement characteristic not found');
    }
    await cscMeasurement.subscribeAsync();
    cscMeasurement.on('data', data => this.onCscData(data));

    const resistanceChar = characteristics.find(ch => ch.uuid === 'fff2'); // Community-documented custom characteristic for resistance.
    if (resistanceChar) {
      await resistanceChar.subscribeAsync();
      resistanceChar.on('data', buf => this.onResistance(buf));
    }

    this.emit('ready', { bike: Ic8BikeClient.label });
  }

  async disconnect() { // Disconnect cleanly when the app shuts down.
    try {
      if (this.device) {
        await this.device.disconnectAsync();
      }
    } catch (error) {
      debug('error during IC8 disconnect', error);
    } finally {
      this.device = null;
    }
  }

  onResistance(buf) { // Parse vendor resistance payload and update estimated power.
    if (!buf || buf.length === 0) {
      return;
    }
    const level = Math.max(0, Math.min(100, buf.readUInt8(0))); // Normalize the reported resistance level into 0..100 range.
    this.state.resistance = level / 100; // Convert to 0..1 fraction for the estimator.
    this.publish();
  }

  onCscData(buf) { // Parse CSC crank data and update cadence/power estimate.
    if (!buf || buf.length < 5) {
      return;
    }
    const flags = buf.readUInt8(0);
    let offset = 1;
    if (flags & 0x02) { // Crank revolution data present.
      const crankRevolutions = buf.readUInt16LE(offset); offset += 2;
      const crankTimestamp = buf.readUInt16LE(offset); offset += 2;
      this.updateCadence(crankRevolutions, crankTimestamp);
    }
    this.publish();
  }

  updateCadence(crankRevolutions, crankTimestamp) { // Derive RPM from cumulative crank data per CSC specification.
    if (!this.lastCrank) {
      this.lastCrank = { revolutions: crankRevolutions, timestamp: crankTimestamp };
      return;
    }
    let deltaRevs = crankRevolutions - this.lastCrank.revolutions;
    if (deltaRevs < 0) deltaRevs += 0x10000; // Handle 16-bit wrap.
    let deltaTime = crankTimestamp - this.lastCrank.timestamp;
    if (deltaTime < 0) deltaTime += 0x10000; // Handle 16-bit wrap.
    this.lastCrank = { revolutions: crankRevolutions, timestamp: crankTimestamp };
    if (deltaTime === 0) {
      return;
    }
    const seconds = deltaTime / 1024; // CSC timestamps use 1/1024 second resolution.
    const rpm = (deltaRevs / seconds) * 60;
    this.state.rpm = Math.max(0, Math.round(rpm));
  }

  publish() { // Emit smoothed power/cadence whenever either input changes.
    const { rpm, resistance } = this.state;
    const estimated = estimatePower(rpm, resistance, {
      scale: this.config.powerScale ?? 1.0,
      offset: this.config.powerOffset ?? 0,
      minWatts: 0,
      maxWatts: 2000
    });
    this.state.watts = this.powerFilter.push(estimated);
    this.emit('stats', { power: this.state.watts, cadence: rpm });
  }
}
