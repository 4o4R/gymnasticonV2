import {EventEmitter} from 'events';
import {Timer} from '../util/timer.js';
import {scan} from '../util/ble-scan.js';
import {macAddress} from '../util/mac-address.js';
import {createDropoutFilter} from '../util/dropout-filter.js';

export const KEISER_LOCALNAME = "M3";
// Teaching note: Keiser has shipped two different "magic" prefixes over time.
// Old firmware uses 0x02 0x01, newer firmware has been seen with 0x03.
const KEISER_VALUE_MAGIC_OLD = Buffer.from([0x02, 0x01]); // legacy Keiser data message header
const KEISER_VALUE_MAGIC_NEW = Buffer.from([0x03]); // newer Keiser data message header
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

function isValidKeiserData(data) {
  // Teaching note: we accept both known magic prefixes because Keiser has
  // shipped at least two wire formats in the wild.
  if (!Buffer.isBuffer(data)) {
    return false;
  }
  // Teaching note: we need at least 4 bytes to read version bytes safely.
  if (data.length < 4) {
    return false;
  }
  return (
    data.indexOf(KEISER_VALUE_MAGIC_OLD) === 0 ||
    data.indexOf(KEISER_VALUE_MAGIC_NEW) === 0
  );
}

function extractKeiserPayloadFromData(data) {
  if (!Buffer.isBuffer(data)) {
    return null;
  }
  if (isValidKeiserData(data)) {
    return data;
  }
  // Some firmwares prepend a 2-byte company id before the Keiser payload.
  if (data.length >= 6 && isValidKeiserData(data.slice(2))) {
    return data.slice(2);
  }
  return null;
}

function extractKeiserPayload(advertisement) {
  if (!advertisement) {
    return null;
  }
  const manufacturer = extractKeiserPayloadFromData(advertisement.manufacturerData);
  if (manufacturer) {
    return manufacturer;
  }
  const serviceData = advertisement.serviceData || [];
  for (const entry of serviceData) {
    const candidate = extractKeiserPayloadFromData(entry?.data);
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

const debugModule = loadDependency('debug', '../../stubs/debug.cjs', import.meta);
const debuglog = toDefaultExport(debugModule)('gym:bikes:keiser');

const KEISER_NAME_PATTERN = /m3/i; // Match M-Series names even when a prefix (e.g., "Keiser ") is present.

export function matchesKeiserName(peripheral) {
  const advertisement = peripheral?.advertisement ?? {}; // Stash a local ref so the code below stays readable for new contributors.
  const name = advertisement.localName ?? ''; // Local names only appear occasionally; treat missing names as blank strings.

  if (KEISER_NAME_PATTERN.test(name)) { // Classic path: the Keiser console advertises as "M3i#123" (or similar). Quick bail-out keeps happy-path fast.
    console.log(`[keiser-match] ✓ Matched by name: "${name}"`);
    return true;
  }

  // Some Keiser consoles stop sending the local name after the very first advertisement (especially once another central has cached it).
  // When that happens our old matcher never fired, so autodetect would fall back to the default bike and the service kept looping.
  // Keiser's manufacturer data always begins with a known magic header, so we
  // can treat that signature as a secondary detection path.
  const payload = extractKeiserPayload(advertisement);
  if (payload) {
    console.log(`[keiser-match] ✓ Matched by Keiser payload magic: "${name || '(no name)'}"`);
    return true; // The manufacturer payload looks like a Keiser beacon even though the local name is missing.
  }

  // Log first few rejections to help debug missing bikes
  if (Math.random() < 0.05) { // Log ~5% of devices to avoid spam
    console.log(`[keiser-match] ✗ Device rejected: name="${name}", hasPayload=${!!payload}, addr=${peripheral?.address || 'unknown'}`);
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
    // Teaching note: cache stable identifiers so we can keep matching even if
    // the adapter reports an "unknown" address in later advertisements.
    this.peripheralId = null;
    this.peripheralAddress = null;
    this.peripheralName = null;
    this.peripheralSignature = null; // Teaching note: capture a small signature from the payload to match rotating addresses.
    this.fixDropout = null;
    this.ignoredPackets = 0; // Teaching note: small counter to avoid log spam when we ignore packets.
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
    
    console.log('[keiser] Starting Keiser bike scan (timeout: disabled)...');
    debuglog('Starting Keiser bike scan with no timeout');
    const peripheral = await scan(this.noble, null, filter, {
      allowDuplicates: true,
      active: true,
      timeoutMs: 0  // wait indefinitely until the bike advertises
    });

    if (!peripheral) {
      this.state = 'disconnected';
    console.log('[keiser] ERROR: Bike not found (scan failed or interrupted)');
      console.log('[keiser] Check: Is M3i powered on? Is it in BLE range? Does console show "M3i" or "M3"?');
      debuglog('Keiser bike not found after scan timeout - bike may not be powered on or in range');
      throw new Error('Unable to find Keiser bike - check bike power and BLE signal');
    }

    console.log(`[keiser] Found Keiser bike! address=${peripheral.address}`);
    debuglog(`Found Keiser bike: address=${peripheral.address} name=${peripheral?.advertisement?.localName}`);
    this.peripheral = peripheral;
    // Teaching note: save identifiers we will use to match future discover events.
    this.peripheralId = peripheral?.id || null;
    this.peripheralAddress = normalizeAddress(peripheral?.address);
    this.peripheralName = peripheral?.advertisement?.localName || null;
    // Teaching note: store the first 4 bytes (magic + version) so we can match
    // later packets even if the address rotates or the name disappears.
    const initialPayload = extractKeiserPayload(peripheral?.advertisement);
    if (Buffer.isBuffer(initialPayload) && initialPayload.length >= 4) {
      // Teaching note: include the magic + version bytes so we can match
      // rotating addresses without relying on the local name.
      this.peripheralSignature = initialPayload.slice(0, 4).toString('hex');
    } else {
      this.peripheralSignature = null;
    }

    let statsTimeoutSeconds = KEISER_STATS_TIMEOUT_OLD;
    try {
      const payload = extractKeiserPayload(peripheral.advertisement);
      if (payload) {
        const {timeout} = bikeVersion(payload);
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
    if (!this.peripheral || !this.isMatchingPeripheral(peripheral)) {
      // Teaching note: only log a few ignored packets so we can debug address
      // changes without flooding the journal.
      this.ignoredPackets += 1;
      if (this.ignoredPackets <= 3) {
        debuglog(`ignored keiser packet (id=${peripheral?.id} address=${peripheral?.address} name=${peripheral?.advertisement?.localName})`);
      }
      return;
    }

    if (!this.fixDropout) {
      return;
    }

    try {
      const payload = extractKeiserPayload(peripheral.advertisement);
      if (!payload) {
        return;
      }

      const {type, payload: statsPayload} = parse(payload);
      if (type !== 'stats') {
        return;
      }

      const fixed = this.fixDropout(statsPayload);
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
    this.peripheralId = null;
    this.peripheralAddress = null;
    this.peripheralName = null;
    this.peripheralSignature = null;
    this.fixDropout = null;
    this.ignoredPackets = 0;

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

  isMatchingPeripheral(peripheral) {
    if (!peripheral) {
      return false;
    }
    // Teaching note: prefer the stable noble id when available.
    if (this.peripheralId && peripheral.id === this.peripheralId) {
      return true;
    }
    // Teaching note: fall back to normalized MAC address comparison.
    const address = normalizeAddress(peripheral.address);
    if (this.peripheralAddress && address && address === this.peripheralAddress) {
      return true;
    }
    // Teaching note: some adapters report "unknown" addresses; if the local name
    // still matches and the payload looks like Keiser data, accept it.
    const payload = extractKeiserPayload(peripheral?.advertisement);
    const hasKeiserMagic = Boolean(payload);
    if (!hasKeiserMagic) {
      return false;
    }
    const nameMatches = this.peripheralName && peripheral?.advertisement?.localName === this.peripheralName;
    if (nameMatches) {
      return true;
    }
    // Teaching note: if the address rotates or the name disappears, fall back
    // to the signature match (magic + version bytes).
    if (this.peripheralSignature && Buffer.isBuffer(payload) && payload.length >= 4) {
      const signature = payload.slice(0, 4).toString('hex');
      if (signature === this.peripheralSignature) {
        return true;
      }
    }
    // Teaching note: last-resort acceptance when name is missing but payload
    // matches Keiser format; this avoids dropping stats entirely.
    return !peripheral?.advertisement?.localName;
  }
}

function normalizeAddress(address) {
  if (!address) {
    return null;
  }
  try {
    return macAddress(address).toLowerCase();
  } catch (_error) {
    return String(address).toLowerCase();
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
  // Teaching note: validate the magic header before reading version bytes.
  if (!isValidKeiserData(data)) {
    throw new Error('unable to parse bike version data');
  }
  const major = data.readUInt8(KEISER_VALUE_IDX_VER_MAJOR);
  const minor = data.readUInt8(KEISER_VALUE_IDX_VER_MINOR);
  version = major.toString(16) + "." + minor.toString(16);
  if ((major === 6) && (minor >= parseInt(KEISER_STATS_NEWVER_MINOR, 16))) {
    timeout = KEISER_STATS_TIMEOUT_NEW;
  }
  debuglog(`Keiser M3 bike version: ${version} (Stats timeout: ${timeout} sec.)`);
  return { version, timeout };
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
  // Teaching note: validate the header and ensure we have enough bytes to read
  // power + cadence values without throwing.
  if (!isValidKeiserData(data)) {
    throw new Error('unable to parse message');
  }
  if (data.length < KEISER_VALUE_IDX_POWER + 2) {
    throw new Error('unable to parse message');
  }
  const realtime = data.readUInt8(KEISER_VALUE_IDX_REALTIME);
  if (realtime === 0 || (realtime > 128 && realtime < 255)) {
    // Realtime data received
    const power = data.readUInt16LE(KEISER_VALUE_IDX_POWER);
    const cadence = Math.round(data.readUInt16LE(KEISER_VALUE_IDX_CADENCE) / 10);
    return {type: 'stats', payload: {power, cadence}};
  }
  throw new Error('unable to parse message');
}
