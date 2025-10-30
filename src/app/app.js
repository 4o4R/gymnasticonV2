import {once} from 'events';

import {GymnasticonServer} from '../servers/ble/index.js';
import {AntServer} from '../servers/ant/index.js';
import {createBikeClient, getBikeTypes} from '../bikes/index.js';
import {HeartRateClient} from '../hr/heart-rate-client.js';
import {Simulation} from './simulation.js';
import {Timer} from '../util/timer.js';
import {Logger} from '../util/logger.js';
import {createAntStick} from '../util/ant-stick.js';
import {loadDependency, toDefaultExport} from '../util/optional-deps.js';

const nobleModule = loadDependency('@abandonware/noble', '../../stubs/noble.cjs', import.meta);
const nobleDefault = toDefaultExport(nobleModule);
const blenoModule = loadDependency('@abandonware/bleno', '../../stubs/bleno.cjs', import.meta);
const bleno = toDefaultExport(blenoModule);
const debugModule = loadDependency('debug', '../../stubs/debug.cjs', import.meta);
const debug = toDefaultExport(debugModule);

const debuglog = debug('gym:app:app');

export {getBikeTypes};

export const defaults = {
  // bike options
  bike: 'autodetect', // bike type
  bikeReceiveTimeout: 4, // timeout for receiving stats from bike
  bikeConnectTimeout: 0, // timeout for establishing bike connection
  bikeAdapter: 'hci0', // bluetooth adapter to use for bike connection (BlueZ only)

  // flywheel bike options
  flywheelAddress: undefined, // mac address of bike
  flywheelName: 'Flywheel 1', // name of bike

  // peloton bike options
  pelotonPath: '/dev/ttyUSB0', // default path for usb to serial device

  // test bike options
  botPower: 0, // power
  botCadence: 0, // cadence
  botHost: '0.0.0.0', // listen for udp message to update cadence/power
  botPort: 3000,

  // server options
  serverAdapter: 'hci0', // adapter for receiving connections from apps
  serverName: 'Gymnasticon', // how the Gymnasticon will appear to apps
  serverPingInterval: 1, // send a power measurement update at least this often

  // ANT+ server options
  antDeviceId: 11234, // random default ANT+ device id

  // power adjustment (to compensate for inaccurate power measurements on bike)
  powerScale: 1.0, // multiply power by this
  powerOffset: 0.0, // add this to power
};

/**
 * Gymnasticon App.
 *
 * Converts the Flywheel indoor bike's non-standard data protocol into the
 * standard Bluetooth Cycling Power Service so the bike can be used with
 * apps like Zwift.
 */
export class App {
  constructor(options = {}) {
    const opts = { ...defaults, ...options };
    this.opts = opts;

    this.logger = new Logger();
    this.noble = opts.noble || nobleDefault;
    this.bleno = bleno;

    this.powerScale = opts.powerScale;
    this.powerOffset = opts.powerOffset;
    this.power = 0;
    this.crank = { timestamp: 0, revolutions: 0 };

    this.server = new GymnasticonServer(this.bleno, opts.serverName);
    this.antStick = createAntStick();
    this.antStickClosed = false;
    this.antServer = new AntServer(this.antStick, { deviceId: opts.antDeviceId });

    this.onAntStickStartup = this.onAntStickStartup.bind(this);
    this.stopAnt = this.stopAnt.bind(this);

    if (typeof this.antStick.on === 'function') {
      this.antStick.on('startup', this.onAntStickStartup);
      this.antStick.on('shutdown', this.stopAnt);
    }

    this.statsTimeout = new Timer(opts.bikeReceiveTimeout, { repeats: false });
    this.statsTimeout.on('timeout', this.onBikeStatsTimeout.bind(this));
    this.connectTimeout = new Timer(opts.bikeConnectTimeout, { repeats: false });
    this.connectTimeout.on('timeout', this.onBikeConnectTimeout.bind(this));
    this.pingInterval = new Timer(opts.serverPingInterval);
    this.pingInterval.on('timeout', this.onPingInterval.bind(this));

    this.simulation = new Simulation();
    this.simulation.on('pedal', this.onPedalStroke.bind(this));

    this.hrClient = new HeartRateClient(this.noble);
    this.hrClient.on('heartRate', this.onHeartRate.bind(this));

    this.onSigInt = this.onSigInt.bind(this);
    this.onExit = this.onExit.bind(this);
    
    // Modern Bluetooth configuration
    process.env['NOBLE_HCI_DEVICE_ID'] = opts.bikeAdapter;
    process.env['BLENO_HCI_DEVICE_ID'] = opts.serverAdapter;
    process.env['BLENO_MAX_CONNECTIONS'] = '3';
    process.env['NOBLE_EXTENDED_SCAN'] = '1';
    process.env['NOBLE_MULTI_ROLE'] = '1';
    
    if (opts.bikeAdapter === opts.serverAdapter) {
      process.env['NOBLE_MULTI_ROLE'] = '1';
    }

    // Enhanced error handling
    this.errorHandler = this.handleError.bind(this);
    process.on('unhandledRejection', this.errorHandler);
    process.on('uncaughtException', this.errorHandler);
  }

  handleError(error) {
    this.logger.error('Fatal error:', error);
    this.cleanup();
    process.exit(1);
  }

  async start() {
    await this.run();
  }

  async stop() {
    this.pingInterval.cancel();
    this.statsTimeout.cancel();
    this.connectTimeout.cancel();
    if (this.bike && this.bike.disconnect) {
      await this.bike.disconnect();
    }
    await this.server.stop();
    this.stopAnt();
    if (this.hrClient) {
      await this.hrClient.disconnect();
    }
  }

  async cleanup() {
    try {
      await this.stop();
    } catch (e) {
      this.logger.error(e);
    }
    if (typeof this.antStick?.removeListener === 'function') {
      this.antStick.removeListener('startup', this.onAntStickStartup);
      this.antStick.removeListener('shutdown', this.stopAnt);
    }
    if (typeof this.antStick?.close === 'function' && !this.antStickClosed) {
      try {
        this.antStick.close();
        this.antStickClosed = true;
      } catch (e) {
        this.logger.error('Error closing ANT+ stick', e);
      }
    }
  }

  async run() {
    try {
      process.on('SIGINT', this.onSigInt);
      process.on('exit', this.onExit);

      const [state] = await once(this.noble, 'stateChange');
      if (state !== 'poweredOn')
        throw new Error(`Bluetooth adapter state: ${state}`);

      this.logger.log('connecting to bike...');
      this.bike = await createBikeClient(this.opts, this.noble);
      this.bike.on('disconnect', this.onBikeDisconnect.bind(this));
      this.bike.on('stats', this.onBikeStats.bind(this));
      this.connectTimeout.reset();
      await this.bike.connect();
      this.connectTimeout.cancel();
      this.logger.log(`bike connected ${this.bike.address}`);
      await this.server.start();
      this.startAnt();
      await this.hrClient.connect();
      this.pingInterval.reset();
      this.statsTimeout.reset();
    } catch (e) {
      this.logger.error(e);
      process.exit(1);
    }
  }

  onPedalStroke(timestamp) {
    this.pingInterval.reset();
    this.crank.timestamp = timestamp;
    this.crank.revolutions++;
    let {power, crank} = this;
    this.logger.log(`pedal stroke [timestamp=${timestamp} revolutions=${crank.revolutions} power=${power}W]`);
    this.server.updateMeasurement({ power, crank });
  }

  onPingInterval() {
    debuglog(`pinging app since no stats or pedal strokes for ${this.pingInterval.interval}s`);
    let {power, crank} = this;
    this.server.updateMeasurement({ power, crank });
  }

  onHeartRate(hr) {
    this.server.updateHeartRate(hr);
  }

  onBikeStats({ power, cadence }) {
    power = power > 0 ? Math.max(0, Math.round(power * this.powerScale + this.powerOffset)) : 0;
    this.logger.log(`received stats from bike [power=${power}W cadence=${cadence}rpm]`);
    this.statsTimeout.reset();
    this.power = power;
    this.simulation.cadence = cadence;
    let {crank} = this;
    this.server.updateMeasurement({ power, crank });
    this.antServer.updateMeasurement({ power, cadence });
  }

  onBikeStatsTimeout() {
    this.logger.log(`timed out waiting for bike stats after ${this.statsTimeout.interval}s`);
    process.exit(0);
  }

  onBikeDisconnect({ address }) {
    this.logger.log(`bike disconnected ${address}`);
    process.exit(0);
  }

  onBikeConnectTimeout() {
    this.logger.log(`bike connection timed out after ${this.connectTimeout.interval}s`);
    process.exit(1);
  }

  startAnt() {
    if (!this.antStick.is_present()) {
      this.logger.log('no ANT+ stick found');
      return;
    }
    try {
      const opened = this.antStick.open();
      if (opened === false) {
        this.logger.error('failed to open ANT+ stick');
        return;
      }
      this.antStickClosed = false;
      const hasEventEmitter = typeof this.antStick.on === 'function';
      if (!hasEventEmitter || opened === true) {
        this.onAntStickStartup();
      }
    } catch (err) {
      this.logger.error('failed to open ANT+ stick', err);
    }
  }

  onAntStickStartup() {
    if (this.antServer.isRunning) {
      return;
    }
    this.logger.log('ANT+ stick opened');
    this.antStickClosed = false;
    this.antServer.start();
  }

  stopAnt() {
    if (!this.antServer.isRunning) {
      return;
    }
    this.logger.log('stopping ANT+ server');
    this.antServer.stop();
    if (typeof this.antStick?.close === 'function' && !this.antStickClosed) {
      try {
        this.antStick.close();
        this.antStickClosed = true;
      } catch (err) {
        this.logger.error('failed to close ANT+ stick', err);
      }
    }
  }

  onSigInt() {
    const listeners = process.listeners('SIGINT');
    if (listeners[listeners.length-1] === this.onSigInt) {
      process.exit(0);
    }
  }

  onExit() {
    if (this.antServer.isRunning) {
      this.stopAnt();
    }
  }
}
