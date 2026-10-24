import {EventEmitter} from 'events';
import {scan} from '../util/ble-scan.js';
import {macAddress} from '../util/mac-address.js';
import {connectWithTimeout} from '../util/noble-wrapper.js';

export const IC4_LOCALNAME = 'IC Bike';

export function matchesIc4OrSchwinn290(peripheral) {
  const name = (peripheral?.advertisement?.localName || '').toLowerCase();
  if (!name) {
    return false;
  }
  if (name === IC4_LOCALNAME.toLowerCase()) {
    return true;
  }
  return name === 'ftms-bike' || (name.includes('schwinn') && name.includes('290'));
}

// GATT service/characteristic UUIDs
const FTMS_SERVICE_UUID = '1826';
const INDOOR_BIKE_DATA_UUID = '2ad2';

// Indoor Bike Data field flags (FTMS 4.9.1). Fields appear in bit order after
// the 16-bit flag word; bit 0 ("more data") set means instantaneous speed is
// ABSENT, which is why the flags are inverted compared to the other fields.
const IBD_FLAG_MORE_DATA = 0x0001;
const IBD_FLAG_AVERAGE_SPEED = 0x0002;
const IBD_FLAG_INSTANTANEOUS_CADENCE = 0x0004;
const IBD_FLAG_AVERAGE_CADENCE = 0x0008;
const IBD_FLAG_TOTAL_DISTANCE = 0x0010;
const IBD_FLAG_RESISTANCE_LEVEL = 0x0020;
const IBD_FLAG_INSTANTANEOUS_POWER = 0x0040;

import {loadDependency, toDefaultExport} from '../util/optional-deps.js';

const debugModule = loadDependency('debug', '../../stubs/debug.cjs', import.meta);
const debuglog = toDefaultExport(debugModule)('gym:bikes:ic4');

/**
 * Handles communication with Schwinn IC4 indoor training bike using the standard
 * Bluetooth LE GATT Fitness Machine Service. Zwift already supports this service
 * but you may still want to run it through Gymnasticon to adjust the bike's
 * inaccurate power values.
 */
export class Ic4BikeClient extends EventEmitter {
  /**
   * Create a Ic4BikeClient instance.
   * @param {Noble} noble - a Noble instance.
   * @param {function} filter - filter to specify bike when more than one is present
   */
  constructor(noble, filter) {
    super();
    this.noble = noble;
    this.filter = filter;
    this.state = 'disconnected';
    this.onReceive = this.onReceive.bind(this);
    this.onDisconnect = this.onDisconnect.bind(this);
  }

  /**
   * Establish a connection to the bike's Bluetooth LE GATT Fitness Machine Service.
   */
  async connect() {
    if (this.state === 'connected') {
      throw new Error('Already connected');
    }

    const scanOptions = {
      allowDuplicates: false,
      active: true
    };

    this.state = 'connecting';
    this.peripheral = await scan(this.noble, [FTMS_SERVICE_UUID], this.filter, scanOptions);
    if (!this.peripheral) {
      this.state = 'disconnected';
      throw new Error('Unable to find IC4 bike');
    }
    // Teaching note: noble's connectAsync is util.promisify(connect) and
    // connect() only accepts a callback, so no options object may be passed.
    // The 10s connect budget is enforced by connectWithTimeout() instead.
    await connectWithTimeout(this.peripheral);
    this.peripheral.on('disconnect', this.onDisconnect);

    // discover services/characteristics
    const {characteristics} = await this.peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [FTMS_SERVICE_UUID], [INDOOR_BIKE_DATA_UUID]);
    const [indoorBikeData] = characteristics;
    this.indoorBikeData = indoorBikeData;

    // subscribe to receive data
    this.indoorBikeData.on('read', this.onReceive);

    // Workaround for enabling notifications on the IC4 bike.
    //
    // Characteristic notifications are enabled by setting bit 0 of the Client
    // Characteristic Configuration Descriptor (CCCD) to 1.
    //
    // Using the hci-socket bindings, noble's subscribeAsync() translates to:
    //
    // => ATT Read By Type Request    # get cccd handle and value
    // <= ATT Read By Type Response
    // => ATT Write Request           # set new value with bit 0 set to 1
    //
    // However the IC4 bike never sends the Read By Type Response.
    //
    // So the workaround below does this instead:
    //
    // => ATT Find Info Request       # get all descriptor handles
    // <= ATT Find Info Response
    // => ATT Write Request           # set value to 1 (0100 uint16le)
    //
    //await this.indoorBikeData.subscribeAsync(); // doesn't work
    await this.indoorBikeData.discoverDescriptorsAsync();
    const cccd = this.indoorBikeData.descriptors.find(d => d.uuid == '2902');
    await cccd.writeValueAsync(Buffer.from([1,0])); // 0100 <- enable notifications

    this.state = 'connected';
  }

  /**
   * Get the bike's MAC address.
   * @returns {string} mac address
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
  onReceive(data) {
    /**
     * Data event.
     *
     * @event BikeClient#data
     * @type {buffer}
     */
    this.emit('data', data);

    try {
      const payload = parse(data); // Decode power/cadence and optional speed from the FTMS payload.
      this.emit('stats', payload); // Forward the parsed stats so downstream services can consume speed when present.
    } catch (e) {
      if (!/unable to parse message/.test(e)) {
        throw e;
      }
    }
  }

  /**
   * Disconnect from the bike.
   */
  async disconnect() {
    if (this.state === 'disconnected' || !this.peripheral) {
      return;
    }
    this.state = 'disconnecting';
    try {
      await this.peripheral.disconnectAsync();
    } catch (err) {
      debuglog('error disconnecting from IC4 bike', err);
    } finally {
      if (this.state !== 'disconnected') {
        this.onDisconnect();
      }
    }
  }

  /**
   * Handle bike disconnection.
   * @emits BikeClient#disconnect
   * @private
   */
  onDisconnect() {
    if (this.state === 'disconnected') {
      return;
    }
    this.state = 'disconnected';
    let address;
    if (this.peripheral) {
      this.peripheral.off('disconnect', this.onDisconnect);
      address = this.peripheral.address;
      this.peripheral = null;
    }

    /**
     * Disconnect event.
     * @event BikeClient#disconnect
     * @type {object}
     * @property {string} address - mac address
     */
    this.emit('disconnect', {address});
  }
}


/**
 * Parse Indoor Bike Data characteristic value.
 * @param {buffer} data - raw characteristic value.
 * @returns {object} message - parsed message
 * @returns {number} [message.power] - instantaneous power (watts), absent when the bike omits it
 * @returns {number} [message.cadence] - instantaneous cadence (rpm), absent when the bike omits it
 * @returns {number} [message.speed] - instantaneous speed (m/s), absent when the bike omits it
 */
export function parse(data) {
  // Teaching note: this characteristic is variable-length. The 16-bit flag word
  // lists which fields follow, and they are laid out in bit order, so every
  // offset depends on the flags. Reading fixed offsets (the previous approach)
  // turned a cadence-only frame into garbage power/cadence values.
  //
  // We only walk as far as the last field we report (instantaneous power, bit
  // 6). Fields after it (energy, heart rate, elapsed time, ...) never shift the
  // offsets above, so a frame that stops early there is still usable.
  if (!Buffer.isBuffer(data) || data.length < 2) {
    throw new Error('unable to parse message');
  }

  const flags = data.readUInt16LE(0);
  let offset = 2;
  let speed;

  if (!(flags & IBD_FLAG_MORE_DATA)) {
    const rawSpeed = readField(data, offset, 2);
    offset += 2;
    // 0.01 km/h units; 0 means "not reported right now".
    if (rawSpeed > 0) {
      speed = (rawSpeed / 100) * (1000 / 3600);
    }
  }
  if (flags & IBD_FLAG_AVERAGE_SPEED) {
    readField(data, offset, 2);
    offset += 2;
  }

  let cadence;
  if (flags & IBD_FLAG_INSTANTANEOUS_CADENCE) {
    // Cadence is expressed in half RPM increments.
    cadence = Math.round(readField(data, offset, 2) / 2);
    offset += 2;
  }
  if (flags & IBD_FLAG_AVERAGE_CADENCE) {
    readField(data, offset, 2);
    offset += 2;
  }
  if (flags & IBD_FLAG_TOTAL_DISTANCE) {
    readField(data, offset, 3);
    offset += 3;
  }
  if (flags & IBD_FLAG_RESISTANCE_LEVEL) {
    readField(data, offset, 2);
    offset += 2;
  }

  let power;
  if (flags & IBD_FLAG_INSTANTANEOUS_POWER) {
    power = readField(data, offset, 2, true); // Power is a signed 16-bit integer (watts).
  }

  const parsed = {power, cadence};
  if (speed !== undefined) {
    parsed.speed = speed;
  }
  return parsed;
}

/**
 * Read a numeric field, failing gracefully when the frame is truncated.
 * @private
 */
function readField(data, offset, size, signed = false) {
  // Teaching note: a short/fragmented frame must be rejected gracefully.
  // Reading past the end would throw RangeError, which onReceive does not
  // swallow (it only filters "unable to parse message"), crashing the app.
  if (offset + size > data.length) {
    throw new Error('unable to parse message');
  }
  if (size === 3) {
    return data.readUIntLE(offset, 3);
  }
  return signed ? data.readInt16LE(offset) : data.readUInt16LE(offset);
}
