import {EventEmitter} from 'events';
import {scan} from '../util/ble-scan.js';
import {macAddress} from '../util/mac-address.js';
import {connectWithTimeout, disconnectPeripheral} from '../util/noble-wrapper.js';

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

import {loadDependency, toDefaultExport} from '../util/optional-deps.js';
import {FTMS_SERVICE_UUID, INDOOR_BIKE_DATA_UUID, IndoorBikeDataAssembler, parseIndoorBikeData} from './ftms-indoor-bike.js';

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
    this.indoorBikeDataAssembler = new IndoorBikeDataAssembler();
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
      const record = this.indoorBikeDataAssembler.push(data);
      if (!record) return; // More Data means the console has not finished this measurement.
      const payload = formatStats(record);
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
      await disconnectPeripheral(this.peripheral);
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
    this.indoorBikeDataAssembler.reset();
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
  // Teaching note: the flag-driven Indoor Bike Data walk is shared with the
  // IC8/C6 clients (src/bikes/ftms-indoor-bike.js). This wrapper keeps the
  // long-standing IC4 contract of always returning power/cadence keys, with
  // undefined meaning "the flag said the field is absent".
  return formatStats(parseIndoorBikeData(data));
}

function formatStats(parsed) {
  const message = {power: parsed.power, cadence: parsed.cadence};
  if (parsed.speed !== undefined) {
    message.speed = parsed.speed;
  }
  return message;
}
