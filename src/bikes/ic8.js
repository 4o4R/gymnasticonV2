import {EventEmitter} from 'events'; // Base class so the client can emit measurement events.
import {scan} from '../util/ble-scan.js'; // Helper that performs BLE scans using noble.
import {loadDependency, toDefaultExport} from '../util/optional-deps.js'; // Optional dependency loader so we can swap in stubs.
import {estimatePower, Ewma} from '../util/power-estimator.js'; // Shared helpers for power estimation and smoothing.
import {FTMS_SERVICE_UUID, INDOOR_BIKE_DATA_UUID, parseIndoorBikeData} from './ftms-indoor-bike.js'; // Shared FTMS Indoor Bike Data decoder.

const debugModule = loadDependency('debug', '../../stubs/debug.cjs', import.meta); // Debug logging helper.
const debug = toDefaultExport(debugModule)('gym:bikes:ic8');

let NobleSingleton;
/**
 * Lazily resolve the noble dependency so CLI options (which import this file
 * early just to enumerate bike types) do not accidentally initialize the BLE
 * stack before we have pointed it at the correct adapter.  Waiting until
 * someone actually instantiates Ic8BikeClient keeps adapter override logic
 * working on Pi Zero dual-dongle setups.
 */
function resolveNoble() {
  if (!NobleSingleton) {
    const nobleModule = loadDependency('@abandonware/noble', '../../stubs/noble.cjs', import.meta);
    NobleSingleton = toDefaultExport(nobleModule);
  }
  return NobleSingleton;
}

const CSC_SERVICE_UUID = '1816'; // Cycling Speed and Cadence service for cadence data.
const CSC_MEASUREMENT_UUID = '2a5b'; // CSC Measurement characteristic.

export class Ic8BikeClient extends EventEmitter { // Schwinn IC8 / Bowflex C6 client that estimates power from cadence + resistance.
  constructor({ noble, log = console, config = {} } = {}) {
    super();
    this.noble = noble || resolveNoble(); // Accept the shared noble instance from the App when provided; otherwise fall back to the lazy loader above.
    this.log = log; // Logger interface (console by default).
    this.config = config; // Optional calibration config for power estimation.
    this.device = null; // Active noble peripheral once connected.
    this.characteristics = []; // Track subscribed characteristics so disconnect() can detach listeners.
    this.state = { rpm: 0, resistance: 0, watts: 0, speed: undefined }; // Track the latest cadence/resistance/power/speed values.
    this.nativePower = undefined; // Latest instantaneous power reported natively over FTMS (undefined when the console omits it).
    this.nativeCadence = undefined; // Latest instantaneous cadence reported natively over FTMS.
    this.powerFilter = new Ewma(0.25); // Smooth power readings to reduce jitter for downstream apps.
    this.onPeripheralDisconnectBound = this.onPeripheralDisconnect.bind(this); // Keep a stable ref so we can remove the listener cleanly.
  }

  static get label() { // Friendly identifier shown in logs and UI.
    return 'schwinn-ic8';
  }

  static matchesAdvertisement(peripheral) { // Heuristic used during autodetect to identify IC8/C6 bikes.
    const name = (peripheral?.advertisement?.localName || '').toLowerCase();
    if (name && (name.includes('ic8') || name.includes('c6') || name.includes('schwinn') || name.includes('bowflex'))) {
      return true;
    }
    // Some C6/IC8 consoles omit the local name from the advertisement; the
    // CSC/FTMS service UUIDs are a reliable signature for these bikes.
    const uuids = peripheral?.advertisement?.serviceUuids || [];
    return uuids.some((uuid) => {
      const normalized = String(uuid).toLowerCase();
      return normalized === CSC_SERVICE_UUID || normalized === FTMS_SERVICE_UUID;
    });
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
    // Teaching note: without a peripheral disconnect listener the app would
    // keep broadcasting the last power/cadence after the bike drops.
    peripheral.on('disconnect', this.onPeripheralDisconnectBound);

    const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [CSC_SERVICE_UUID, FTMS_SERVICE_UUID],
      []
    );
    this.characteristics = characteristics;

    const cscMeasurement = characteristics.find(ch => ch.uuid === CSC_MEASUREMENT_UUID);
    const indoorBikeData = characteristics.find(ch => ch.uuid === INDOOR_BIKE_DATA_UUID);
    // Teaching note: a console that publishes power over FTMS must not depend on
    // CSC, and a console that only publishes CSC must keep working. So CSC is
    // now a fallback and we only fail when neither source exists.
    if (!cscMeasurement && !indoorBikeData) {
      throw new Error('CSC Measurement characteristic not found');
    }

    if (cscMeasurement) {
      await cscMeasurement.subscribeAsync();
      cscMeasurement.on('data', data => this.onCscData(data));
    }

    if (indoorBikeData) {
      try {
        await indoorBikeData.subscribeAsync();
        indoorBikeData.on('data', buf => this.onIndoorBikeData(buf));
      } catch (error) {
        // A console can expose 0x2AD2 but refuse notifications; that is only
        // fatal when CSC is not available as a fallback.
        if (!cscMeasurement) {
          throw error;
        }
        debug('FTMS Indoor Bike Data subscribe failed, falling back to CSC', error);
      }
    }

    const resistanceChar = characteristics.find(ch => ch.uuid === 'fff2'); // Community-documented custom characteristic for resistance.
    if (resistanceChar) {
      await resistanceChar.subscribeAsync();
      resistanceChar.on('data', buf => this.onResistance(buf));
    }

    this.emit('ready', { bike: Ic8BikeClient.label });
  }

  async disconnect() { // Disconnect cleanly when the app shuts down.
    try {
      if (this.characteristics.length) {
        for (const ch of this.characteristics) {
          ch.removeAllListeners('data');
        }
        this.characteristics = [];
      }
      if (this.device) {
        this.device.removeListener('disconnect', this.onPeripheralDisconnectBound);
        await this.device.disconnectAsync();
      }
    } catch (error) {
      debug('error during IC8 disconnect', error);
    } finally {
      this.device = null;
      this.lastCrank = undefined; // Reset stale crank state so a same-instance reconnect starts clean.
      this.nativePower = undefined; // Drop native FTMS values so a reconnect cannot replay the last ride.
      this.nativeCadence = undefined;
      this.state = { rpm: 0, resistance: 0, watts: 0, speed: undefined };
      this.powerFilter.reset();
    }
  }

  onPeripheralDisconnect() { // Emit a disconnect event so the app stops advertising stale data.
    this.log.warn?.('IC8 peripheral disconnected');
    const address = this.device?.address;
    this.device = null;
    this.emit('disconnect', { address });
  }

  onResistance(buf) { // Parse vendor resistance payload and update estimated power.
    if (!buf || buf.length === 0) {
      return;
    }
    const level = Math.max(0, Math.min(100, buf.readUInt8(0))); // Normalize the reported resistance level into 0..100 range.
    this.state.resistance = level / 100; // Convert to 0..1 fraction for the estimator.
    this.publish();
  }

  onIndoorBikeData(buf) { // Decode FTMS Indoor Bike Data and prefer its native power/cadence over the estimator.
    let parsed;
    try {
      parsed = parseIndoorBikeData(buf);
    } catch (error) {
      // A truncated/fragmented frame must never escape into the notification handler.
      debug('ignoring malformed FTMS Indoor Bike Data frame', error);
      return;
    }
    // Each frame is self-describing, so assign unconditionally: a field the
    // flags omit clears the native value and the CSC/estimator fallbacks resume.
    this.nativeCadence = Number.isFinite(parsed.cadence) ? parsed.cadence : undefined;
    this.nativePower = Number.isFinite(parsed.power) ? parsed.power : undefined;
    // Keep speed in step with the frames too: a frame without speed clears it so
    // the app falls back to its cadence-based estimate instead of broadcasting
    // the last speed forever.
    this.state.speed = Number.isFinite(parsed.speed) ? parsed.speed : undefined;
    this.publish();
  }

  onCscData(buf) { // Parse CSC measurement data and update cadence/power estimate.
    if (!buf || buf.length < 1) {
      return;
    }
    const flags = buf.readUInt8(0);
    let offset = 1;
    // Teaching note: CSC field order is fixed by the flags. Wheel revolution
    // data (uint32 revolutions + uint16 timestamp) sits *before* the crank
    // data, so a combined wheel+crank packet needs its six bytes skipped;
    // decoding crank data from offset 1 turned a valid 60 rpm frame into 0.
    if (flags & 0x01) { // Wheel revolution data present.
      offset += 6;
    }
    if (flags & 0x02) { // Crank revolution data present.
      if (buf.length < offset + 4) {
        // Malformed/truncated frame: ignore it rather than reading past the end
        // (RangeError here would escape into the notification handler).
        debug('ignoring malformed CSC measurement frame', buf.length);
        return;
      }
      const crankRevolutions = buf.readUInt16LE(offset);
      const crankTimestamp = buf.readUInt16LE(offset + 2);
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
    if (deltaTime === 0 || deltaRevs === 0) {
      // Teaching note: a repeated packet means the cranks are not turning, so
      // cadence drops to 0. Keeping the previous value made a stopped rider look
      // like they were still pedalling.
      this.state.rpm = 0;
      return;
    }
    const seconds = deltaTime / 1024; // CSC timestamps use 1/1024 second resolution.
    const rpm = (deltaRevs / seconds) * 60;
    this.state.rpm = Math.max(0, Math.round(rpm));
  }

  publish() { // Emit smoothed power/cadence whenever either input changes.
    const { rpm, resistance } = this.state;
    // Native FTMS cadence wins; CSC-derived rpm is the fallback for consoles
    // that only publish the CSC service.
    const cadence = Number.isFinite(this.nativeCadence) ? this.nativeCadence : rpm;
    const hasNativePower = Number.isFinite(this.nativePower);
    // Teaching note: with native power available, trust it even when no cadence
    // source is present. Without it, "no cadence" is the only stationary signal.
    const pedalling = cadence > 0 || (hasNativePower && this.nativePower > 0);
    if (!pedalling) {
      // Teaching note: the EWMA would otherwise keep emitting the last smoothed
      // wattage for many frames after the cranks stopped. Reset the smoother
      // so a stationary bike reports 0 W immediately.
      this.powerFilter.reset();
      this.state.watts = 0;
      this.emitStats(0, 0);
      return;
    }
    let watts;
    if (hasNativePower) {
      // Power reported by the console itself; still smoothed for downstream apps.
      watts = this.powerFilter.push(this.nativePower);
    } else {
      // No native FTMS power: keep estimating from cadence + resistance.
      const estimated = estimatePower(cadence, resistance, {
        scale: this.config.powerScale ?? 1.0,
        offset: this.config.powerOffset ?? 0,
        minWatts: 0,
        maxWatts: 2000
      });
      watts = this.powerFilter.push(estimated);
    }
    this.state.watts = watts;
    this.emitStats(watts, cadence);
  }

  emitStats(power, cadence) { // Emit stats, attaching FTMS speed only when the console reports it.
    const payload = { power, cadence };
    if (Number.isFinite(this.state.speed)) {
      payload.speed = this.state.speed;
    }
    this.emit('stats', payload);
  }
}
