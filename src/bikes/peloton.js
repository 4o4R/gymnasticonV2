import {once, EventEmitter} from 'events';
import {Timer} from '../util/timer.js';
import util from 'util';
import SerialPort from '#serialport';
import Delimiter from '#parser-delimiter';

/**
 * Cadence and Power are both direct values returned by the bike.
 * Resistance, on the otherhand, is a raw value returned from the bike to the
 * Tablet, and doesn't necessarily add value for our use case. However, we are
 * choosing to poll for it to allow for a usecase where Gymnasticon provides
 * the polling, with the bike Tx split to the Tablet as well.
 */
const MEASUREMENTS_HEX_ENUM = {
  CADENCE: Buffer.from("f6f54136", 'hex'),
  POWER: Buffer.from("f6f54439", 'hex'),
  RESISTANCE: Buffer.from("f6f54a3f", 'hex')
}
const PACKET_DELIMITER = Buffer.from('f6', 'hex');
const POLL_RATE = 100;
const STATS_TIMEOUT = 1.0;

import debug from '#debug';

const debuglog = debug('gym:bikes:peloton');
const tracelog = debug('gym:bikes:peloton:trace');

export class PelotonBikeClient extends EventEmitter {
  /**
   * Create a PelotonBikeClient instance.
   * @param {string} path - device path to usb serial device
   */
  constructor(path) {
    super();
    this.path = path;

    this.onStatsUpdate = this.onStatsUpdate.bind(this);
    this.onSerialMessage = this.onSerialMessage.bind(this);
    this.onSerialClose = this.onSerialClose.bind(this);
    this.pollMetric = this.pollMetric.bind(this);

    // initial stats
    this.power = 0;
    this.cadence = 0;

    // reset stats to 0 when the user leaves the ride screen or turns the bike off
    this.statsTimeout = new Timer(STATS_TIMEOUT, {repeats: false});
    this.statsTimeout.on('timeout', this.onStatsTimeout.bind(this));

    // Let's collect interval handles for cancellation
    this.intervalHandles = new Map();
    this.nextMetric = 0;
  }

  async connect() {
    if (this.state === 'connected') {
      throw new Error('Already connected');
    }

    this._port = new SerialPort(this.path, {baudRate: 19200, autoOpen: false});
    const open = util.promisify(this._port.open.bind(this._port));
    await open();
    tracelog("Serial Opened");
    this._port.on('close', this.onSerialClose);
    this._parser = this._port.pipe(new Delimiter({ delimiter: PACKET_DELIMITER }));
    this._parser.on('data', this.onSerialMessage);

    this.state = 'connected';

    // Begin sending polling requests to the Peloton bike
    this.intervalHandles['poll'] = setInterval(this.pollMetric, POLL_RATE, this._port);
    tracelog("Serial Connected");
  }

  /**
   * Get the bike's MAC address.
   * @returns {string} mac address
   */
  get address() {
    return this._port.path;
  }

  /**
   * @private
   */
  onStatsUpdate() {
    const {power, cadence} = this;
    
    // Emit both power and CSC data
    this.emit('stats', {
        power, 
        cadence,
        cscMeasurement: this.formatCSCMeasurement(cadence)
    });
  }

  formatCSCMeasurement(cadence) {
    // CSC measurement flags: 
    // Bit 0 = wheel rev present (0 = no)
    // Bit 1 = crank rev present (1 = yes)
    const flags = 0x02;
    
    // Get cumulative crank revolutions
    this.crankRevs = (this.crankRevs || 0) + (cadence > 0 ? 1 : 0);
    
    // Get current time in 1/1024th of a second
    const timestamp = Math.floor((Date.now() % 64000) * 1.024);
    
    // Create Buffer for CSC measurement
    const cscData = Buffer.alloc(7);
    cscData.writeUInt8(flags, 0);
    cscData.writeUInt16LE(this.crankRevs, 3);
    cscData.writeUInt16LE(timestamp, 5);
    
    return cscData;
  }
  onSerialMessage(data) {
    tracelog("RECV: ", data);
    switch(data[1]) {
      case 65: // Cadence
        this.cadence = decodePeloton(data, data[2], false);
        this.onStatsUpdate();
        this.statsTimeout.reset();
        return;
      case 68: // Power
        this.power = decodePeloton(data, data[2], true);
        this.onStatsUpdate();
        this.statsTimeout.reset();
        return;
      case 74: // Resistance
        return; // While we can parse this, we don't do anything with it.
      default:
        debuglog("Unrecognized Message Type: ", data[1]);
        return;
      }
  }

  onSerialClose() {
    this.emit('disconnect', {address: this.address});
    clearInterval(this.intervalHandles['poll']);
    tracelog("Serial Closed");
  }

  onStatsTimeout() {
    this.power = 0;
    this.cadence = 0;
    tracelog("StatsTimeout exceeded");
    this.onStatsUpdate();
  }

  pollMetric(port) {
    let metric = Object.keys(MEASUREMENTS_HEX_ENUM)[this.nextMetric];

    port.write(MEASUREMENTS_HEX_ENUM[metric], function(err) {
      if (err) { throw new Error(`Error requesting ${metric}: ${err.message}`); }
    })
    port.drain();

    if (this.nextMetric === Object.keys(MEASUREMENTS_HEX_ENUM).length -1) {
      this.nextMetric = 0;
    } else {
      this.nextMetric++;
    }
  }

}

export function decodePeloton(bufferArray, byteLength, isPower) {
  let decimalPlace = 1;
  let precision = 0.0;
  let accumulator = 0;
  let iteratorOffset = 3;

  for (let iteratorTemp = iteratorOffset; iteratorTemp < iteratorOffset + byteLength; iteratorTemp++) {
    let offsetVal = bufferArray[iteratorTemp] - 48;
    if (offsetVal < 0 || offsetVal > 9) {
      debuglog("invalid value detected: ", offsetVal);
      return;
    }

    if (!isPower || iteratorTemp != iteratorOffset) {
      accumulator += (offsetVal * decimalPlace);
      decimalPlace *= 10;
    } else {
      precision = decimalPlace * offsetVal / 10.0;
    }
  }

  return accumulator + precision;
}
