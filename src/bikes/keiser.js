import {EventEmitter} from 'events';
import {Timer} from '../util/timer.js';
import {scan, createNameFilter} from '../util/ble-scan.js';
import {macAddress} from '../util/mac-address.js';
import {createDropoutFilter} from '../util/dropout-filter.js';

export const KEISER_LOCALNAME = "M3";
const KEISER_VALUE_MAGIC = Buffer.from([0x02, 0x01]); // identifies Keiser data message
const KEISER_VALUE_IDX_POWER = 10; // 16-bit power (watts) data offset within packet
const KEISER_VALUE_IDX_CADENCE = 6; // 16-bit cadence (1/10 rpm) data offset within packet
const KEISER_VALUE_IDX_REALTIME = 4; // Indicates whether the data present is realtime (0, or 128 to 227)
const KEISER_VALUE_IDX_VER_MAJOR = 2; // 8-bit Version Major data offset within packet
const KEISER_VALUE_IDX_VER_MINOR = 3; // 8-bit Version Major data offset within packet
const KEISER_STATS_NEWVER_MINOR = 30; // Version Minor when broadcast interval was changed from ~ 2 sec to ~ 0.3 sec
const KEISER_STATS_TIMEOUT_OLD = 30.0; // Old Bike: If no stats received within 30 sec, reset power and cadence to 0
const KEISER_STATS_TIMEOUT_NEW = 20.0; // New Bike: If no stats received within 20 sec, reset power and cadence to 0
const KEISER_BIKE_TIMEOUT = 60.0; // Consider bike disconnected if no stats have been received for 60 sec / 1 minutes
import {loadDependency, toDefaultExport} from '../util/optional-deps.js';

const debugModule = loadDependency('debug', '../../stubs/debug.cjs', import.meta);
const debuglog = toDefaultExport(debugModule)('gym:bikes:keiser');

const KEISER_NAME_PATTERN = /^m3/i; // Many M-Series bikes append letters/numbers, so match on the prefix.

export function matchesKeiserName(peripheral) {
  const advertisement = peripheral?.advertisement ?? {}; // Stash a local ref so the code below stays readable for new contributors.
  const name = advertisement.localName ?? ''; // Local names only appear occasionally; treat missing names as blank strings.

  if (KEISER_NAME_PATTERN.test(name)) { // Classic path: the Keiser console advertises as "M3i#123" (or similar). Quick bail-out keeps happy-path fast.
    return true;
  }

  // Some Keiser consoles stop sending the local name after the very first advertisement (especially once another central has cached it).
  // When that happens our old matcher never fired, so autodetect would fall back to the default bike and the service kept looping.
  // Keiser's manufacturer data always begins with the magic 0x02 0x01 header that `parse()` and `bikeVersion()` already rely on,
  // so we can treat that signature as a secondary detection path.
  const manufacturer = advertisement.manufacturerData;
  if (Buffer.isBuffer(manufacturer) && manufacturer.length >= KEISER_VALUE_MAGIC.length) {
    const prefix = manufacturer.slice(0, KEISER_VALUE_MAGIC.length); // Only compare the header bytes so the rest of the payload can change freely.
    if (prefix.equals(KEISER_VALUE_MAGIC)) {
      return true; // The manufacturer payload looks like a Keiser beacon even though the local name is missing.
    }
  }

  return false; // Nothing matched; let autodetect keep scanning.
}


/**
 * Handles communication with Keiser bikes
 * Developer documentation can be found at https://dev.keiser.com/mseries/direct/
 */

export class KeiserBikeClient extends EventEmitter {
  constructor(noble) {
    super();
    this.noble = noble;
    this.state = 'disconnected';
    this.onReceive = this.onReceive.bind(this);
    this.restartScan = this.restartScan.bind(this);
    this.onStatsTimeout = this.onStatsTimeout.bind(this);
    this.onBikeTimeout = this.onBikeTimeout.bind(this);

    this.statsTimeout = null;
    this.bikeTimeout = null;
    this.peripheral = null;
    this.fixDropout = null;
  }
  /**
   * Bike behaves like a BLE beacon. Simulate connect by looking up MAC address
   * scanning and filtering subsequent announcements from this address.
   */
  async connect() {
    if (this.state === 'connected' || this.state === 'connecting') {
      throw new Error('Already connected');
    }

    this.state = 'connecting';

    const filter = matchesKeiserName;
    const peripheral = await scan(this.noble, null, filter, {
      allowDuplicates: true,
      active: true
    });

    if (!peripheral) {
      this.state = 'disconnected';
      throw new Error('Unable to find Keiser bike');
    }

    this.peripheral = peripheral;

    let statsTimeoutSeconds = KEISER_STATS_TIMEOUT_OLD;
    try {
      const manufacturerData = peripheral.advertisement?.manufacturerData;
      if (manufacturerData) {
        const {timeout} = bikeVersion(manufacturerData);
        statsTimeoutSeconds = timeout;
      } else {
        debuglog('Keiser bike manufacturer data unavailable; using default stats timeout');
      }
    } catch (error) {
      debuglog('Unable to determine Keiser bike firmware version', error);
    }

    this.statsTimeout = new Timer(statsTimeoutSeconds, {repeats: false});
    this.statsTimeout.on('timeout', this.onStatsTimeout);

    this.bikeTimeout = new Timer(KEISER_BIKE_TIMEOUT, {repeats: false});
    this.bikeTimeout.on('timeout', this.onBikeTimeout);

    this.fixDropout = createDropoutFilter();

    try {
      await this.noble.startScanningAsync(null, true);
    } catch (err) {
      this.state = 'disconnected';
      if (this.statsTimeout) {
        this.statsTimeout.cancel();
        this.statsTimeout = null;
      }
      if (this.bikeTimeout) {
        this.bikeTimeout.cancel();
        this.bikeTimeout = null;
      }
      this.fixDropout = null;
      throw err;
    }
    this.noble.on('discover', this.onReceive);
    this.noble.on('scanStop', this.restartScan);

    this.statsTimeout.reset();
    this.bikeTimeout.reset();
    this.state = 'connected';
  }
  /**
   * Get the bike's MAC address.
   * @returns {string|undefined} mac address
   */
  get address() {
    return this.peripheral ? macAddress(this.peripheral.address) : undefined;
  }

  /**
   * Handle data received from the bike.
   * @param {buffer} data - raw data encoded in proprietary format.
   * @emits BikeClient#data
   * @emits BikeClient#stats
   * @private
   */
  onReceive(peripheral) {
    if (!this.peripheral || peripheral.address !== this.peripheral.address) {
      return;
    }

    if (!this.fixDropout) {
      return;
    }

    try {
      const manufacturerData = peripheral.advertisement?.manufacturerData;
      if (!manufacturerData) {
        return;
      }

      const {type, payload} = parse(manufacturerData);
      if (type !== 'stats') {
        return;
      }

      const fixed = this.fixDropout(payload);
      this.emit(type, fixed);
      if (this.statsTimeout) this.statsTimeout.reset();
      if (this.bikeTimeout) this.bikeTimeout.reset();
    } catch (e) {
      if (!/unable to parse message/.test(String(e))) {
        throw e;
      }
    }
  }
  /**
   * Set power & cadence to 0 when the bike dissapears
   */
  async onStatsTimeout() {
    const reset = {power: 0, cadence: 0};
    debuglog('Stats timeout exceeded');
    this.emit('stats', reset);

    if (this.state !== 'connected') {
      return;
    }

    if (this.noble.state !== 'poweredOn') {
      debuglog('Stats timeout: Bluetooth adapter no longer powered on');
      this.onBikeTimeout();
      return;
    }

    try {
      await this.noble.startScanningAsync(null, true);
    } catch (err) {
      debuglog('Stats timeout: Unable to restart BLE scan', err);
    } finally {
      if (this.statsTimeout) {
        this.statsTimeout.reset();
      }
    }
  }

  async disconnect() {
    if (this.state === 'disconnected' || this.state === 'disconnecting') {
      return;
    }

    this.state = 'disconnecting';

    if (this.statsTimeout) {
      this.statsTimeout.cancel();
      this.statsTimeout = null;
    }
    if (this.bikeTimeout) {
      this.bikeTimeout.cancel();
      this.bikeTimeout = null;
    }

    this.noble.off('discover', this.onReceive);
    this.noble.off('scanStop', this.restartScan);

    try {
      await this.noble.stopScanningAsync();
    } catch (err) {
      debuglog('Unable to stop BLE scan', err);
    }

    const address = this.address;
    this.peripheral = null;
    this.fixDropout = null;

    this.state = 'disconnected';
    this.emit('disconnect', {address});
  }

  /**
   * Consider Bike disconnected after certain time
   */
  onBikeTimeout() {
    debuglog('M3 Bike disconnected');
    this.disconnect().catch((err) => debuglog('error disconnecting after timeout', err));
  }

  /**
   * Restart BLE scanning while in connected state
   * Workaround for noble stopping to scan after connect to bleno
   * See https://github.com/noble/noble/issues/223
   */
  async restartScan() {
    if (this.state !== 'connected') {
      return;
    }
    try {
      await this.noble.startScanningAsync(null, true);
    } catch (err) {
      debuglog('Unable to restart BLE scan', err);
    }
  }
}

/**
 * Determine Keiser Bike Firmware version.
 * This helps determine the correct value for the Stats
 * timeout. Older versions of the bike send data only every
 * 2 seconds, while newer bikes send data every 300 ms.
 * @param {buffer} data - raw characteristic value.
 * @returns {string} version - bike version number as string
 * @returns {object} timeout - stats timeout for this bike version
 */
export function bikeVersion(data) {
  let version = "Unknown";
  let timeout = KEISER_STATS_TIMEOUT_OLD;
  if (data.indexOf(KEISER_VALUE_MAGIC) === 0) {
    const major = data.readUInt8(KEISER_VALUE_IDX_VER_MAJOR);
    const minor = data.readUInt8(KEISER_VALUE_IDX_VER_MINOR);
    version = major.toString(16) + "." + minor.toString(16);
    if ((major === 6) && (minor >= parseInt(KEISER_STATS_NEWVER_MINOR, 16))) {
      timeout = KEISER_STATS_TIMEOUT_NEW;
    }
    debuglog(`Keiser M3 bike version: ${version} (Stats timeout: ${timeout} sec.)`);
    return { version, timeout };
  }
  throw new Error('unable to parse bike version data');
}

/**
 * Parse Keiser Bike Data characteristic value.
 * Consider if provided value are realtime or review mode
 * See https://dev.keiser.com/mseries/direct/#data-type
 * @param {buffer} data - raw characteristic value.
 * @returns {object} message - parsed message
 * @returns {string} message.type - message type
 * @returns {object} message.payload - message payload
 */
export function parse(data) {
  if (data.indexOf(KEISER_VALUE_MAGIC) === 0) {
    const realtime = data.readUInt8(KEISER_VALUE_IDX_REALTIME);
    if (realtime === 0 || (realtime > 128 && realtime < 255)) {
      // Realtime data received
      const power = data.readUInt16LE(KEISER_VALUE_IDX_POWER);
      const cadence = Math.round(data.readUInt16LE(KEISER_VALUE_IDX_CADENCE) / 10);
      return {type: 'stats', payload: {power, cadence}};
    }
  }
  throw new Error('unable to parse message');
}
