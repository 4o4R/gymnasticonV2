import {EventEmitter} from 'events';
import util from 'util';

import test from '../support/tape.js';
import {FlywheelBikeClient, parse} from '../../bikes/flywheel.js';

test('parse() parses Flywheel stats messages', t => {
  t.plan(3);
  const buf = Buffer.from('ff1f0c0122000000000000005a00000000000000000000000000000a000000016155', 'hex');
  const {type, payload: {power, cadence}} = parse(buf);
  t.equal(type, 'stats', 'message type');
  t.equal(power, 290, 'power (watts)');
  t.equal(cadence, 90, 'cadence (rpm)');
});

test('parse() rejects short Flywheel frames gracefully (no RangeError crash)', t => {
  t.plan(1);
  // Stats magic prefix followed by a truncated payload.
  const buf = Buffer.from('ff1f0c0122', 'hex');
  t.throws(() => parse(buf), /unable to parse message/, 'throws the graceful parse error, not RangeError');
});

test('FlywheelBikeClient.connect() connects without passing noble options', async t => {
  const {noble, peripheral} = createFlywheelHarness();
  const client = new FlywheelBikeClient(noble, (p) => p.advertisement.localName === 'Flywheel 1');

  await client.connect();

  t.equal(peripheral.connectArgs.length, 0, 'connectAsync() invoked with no arguments (noble connect() takes only a callback)');
  t.equal(peripheral.state, 'connected', 'the link is up');
  t.equal(client.state, 'connected', 'client reports connected');

  await client.disconnect();
  t.end();
});

test('FlywheelBikeClient.connect() rejects with a clear timeout instead of a callback TypeError', async t => {
  const {noble, peripheral} = createFlywheelHarness({completes: false});
  const client = new FlywheelBikeClient(noble, (p) => p.advertisement.localName === 'Flywheel 1', {connectTimeoutMs: 25});

  try {
    await client.connect();
    t.fail('connect() must not hang forever');
  } catch (error) {
    t.match(error.message, /Timed out after \d+ms connecting to/, 'reports the connect budget');
    t.equal(error instanceof TypeError, false, 'not the "callback is not a function" error');
  }
  t.equal(peripheral.disconnectCalls, 1, 'best-effort disconnect so the radio is not left half-open');
  t.end();
});

/**
 * Fake noble peripheral whose connectAsync is util.promisify of a
 * callback-style connect, exactly like @abandonware/noble 1.9.2-10.
 */
function createFakePeripheral({completes = true} = {}) {
  const peripheral = new EventEmitter();
  peripheral.address = 'aa:bb:cc:dd:ee:01';
  peripheral.state = 'disconnected';
  peripheral.connectArgs = null;
  peripheral.disconnectCalls = 0;

  const connect = function connect(callback) {
    if (callback) {
      peripheral.once('connect', (error) => callback(error));
    }
    peripheral.state = 'connecting';
    if (completes) {
      peripheral.state = 'connected';
      peripheral.emit('connect', null);
    }
  };
  const connectAsync = util.promisify(connect);
  peripheral.connect = connect;
  peripheral.connectAsync = function connectAsyncWithRecordedArgs(...args) {
    peripheral.connectArgs = args; // Caller-supplied arguments only, before promisify adds the callback.
    return connectAsync.apply(peripheral, args);
  };
  peripheral.disconnectAsync = async () => {
    peripheral.disconnectCalls += 1;
    peripheral.state = 'disconnected';
    peripheral.emit('disconnect');
  };
  return peripheral;
}

/**
 * Minimal noble + Nordic UART bike stand-in for FlywheelBikeClient.connect().
 */
function createFlywheelHarness({completes = true} = {}) {
  const noble = new EventEmitter();
  noble.state = 'poweredOn';
  noble.startScanningAsync = async () => {};
  noble.stopScanningAsync = async () => {};
  noble.stopScanning = () => {};

  const peripheral = createFakePeripheral({completes});
  peripheral.advertisement = {localName: 'Flywheel 1', serviceUuids: ['6e400001b5a3f393e0a9e50e24dcca9e']};

  const tx = new EventEmitter();
  tx.uuid = '6e400003b5a3f393e0a9e50e24dcca9e';
  tx.subscribeAsync = async () => {};
  const rx = {uuid: '6e400002b5a3f393e0a9e50e24dcca9e', writeAsync: async () => {}};
  peripheral.discoverSomeServicesAndCharacteristicsAsync = async () => ({characteristics: [tx, rx]});

  setTimeout(() => noble.emit('discover', peripheral), 0);
  return {noble, peripheral, tx, rx};
}
