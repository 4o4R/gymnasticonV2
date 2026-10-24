import {EventEmitter} from 'events';
import util from 'util';

import test from '../support/tape.js';
import {Ic4BikeClient, matchesIc4OrSchwinn290, parse} from '../../bikes/ic4.js';
import {connectWithTimeout} from '../../util/noble-wrapper.js';

test('parse() parses Schwinn IC4 indoor bike data values', t => {
  t.plan(2);
  const buf = Buffer.from('4402da020201220100', 'hex');
  const {power, cadence} = parse(buf);
  t.equal(power, 290, 'power (watts)');
  t.equal(cadence, 129, 'cadence (rpm)');
});

test('parse() rejects short IC4 frames gracefully (no RangeError crash)', t => {
  t.plan(1);
  // Flags 0x0244 (speed + cadence + power) followed by a truncated payload.
  const buf = Buffer.from('4402da02', 'hex');
  t.throws(() => parse(buf), /unable to parse message/, 'throws the graceful parse error, not RangeError');
});

test('parse() decodes a cadence-only frame where flags report no speed and no power', t => {
  // flags 0x0005 = "more data" (bit0, so no instantaneous speed) + cadence.
  const buf = Buffer.from('05006400', 'hex');
  const parsed = parse(buf);
  t.equal(parsed.cadence, 50, 'cadence (1/2 rpm units -> 50 rpm)');
  t.equal(parsed.power, undefined, 'power is absent instead of decoding garbage');
  t.equal(parsed.speed, undefined, 'speed is absent when bit0 is set');
  t.end();
});

test('parse() returns undefined power/cadence for a speed-only frame', t => {
  // flags 0x0000 -> instantaneous speed only.
  const buf = Buffer.from('0000da02', 'hex');
  const parsed = parse(buf);
  t.equal(parsed.power, undefined, 'no power field present');
  t.equal(parsed.cadence, undefined, 'no cadence field present');
  t.ok(Math.abs(parsed.speed - (730 / 100) * (1000 / 3600)) < 1e-9, 'speed converted from 0.01 km/h to m/s');
  t.end();
});

test('parse() walks flag-ordered fields before cadence and power', t => {
  // flags 0x0046 = speed present (bit0 clear), average speed (bit1),
  // instantaneous cadence (bit2) and instantaneous power (bit6).
  const buf = Buffer.from('4600da02ee01fe002201', 'hex');
  const parsed = parse(buf);
  t.equal(parsed.cadence, 127, 'cadence read after the average speed field');
  t.equal(parsed.power, 290, 'power read after the average speed field');
  t.end();
});

test('parse() rejects a frame truncated in a field that precedes power', t => {
  // flags claim average speed + cadence + power, but only the average speed
  // field actually arrived.
  const buf = Buffer.from('4600da02ee01', 'hex');
  t.throws(() => parse(buf), /unable to parse message/, 'rejects instead of reading past the end');
  t.end();
});

test('parse() rejects an empty frame', t => {
  t.throws(() => parse(Buffer.alloc(0)), /unable to parse message/, 'no flag word to read');
  t.throws(() => parse(undefined), /unable to parse message/, 'no buffer at all');
  t.end();
});

test('connectWithTimeout() connects when noble connectAsync takes no arguments', async t => {
  const peripheral = createFakePeripheral();
  await connectWithTimeout(peripheral, 50);
  t.equal(peripheral.connectArgs.length, 0, 'connect() was called without an options object');
  t.equal(peripheral.state, 'connected', 'the link is up');
  t.end();
});

test('connectWithTimeout() rejects when noble connectAsync is given options (the old bug)', async t => {
  const peripheral = createFakePeripheral();
  try {
    // This is what ic4.js/flywheel.js used to do. noble's connectAsync is
    // util.promisify(connect) and connect(callback) has no options parameter,
    // so the options object lands in the callback slot.
    await peripheral.connectAsync({timeout: 10000});
    t.fail('the object-argument call should throw');
  } catch (error) {
    t.match(error.message, /callback is not a function/, 'reproduces the reported TypeError');
  }
  t.end();
});

test('connectWithTimeout() rejects at the deadline and releases the radio', async t => {
  const peripheral = createFakePeripheral({completes: false});
  try {
    await connectWithTimeout(peripheral, 25);
    t.fail('a connect that never completes must time out');
  } catch (error) {
    t.match(error.message, /Timed out after 25ms/, 'reports the connect budget');
    t.equal(error instanceof TypeError, false, 'the timeout is not a callback TypeError');
  }
  t.equal(peripheral.disconnectCalls, 1, 'best-effort disconnect so the adapter is not left half-open');
  t.end();
});

test('Ic4BikeClient.connect() establishes a connection without passing noble options', async t => {
  const {noble, peripheral} = createIc4Harness();
  const client = new Ic4BikeClient(noble, matchesIc4OrSchwinn290);

  await client.connect();

  t.equal(peripheral.connectArgs.length, 0, 'connectAsync() invoked with no arguments');
  t.equal(client.state, 'connected', 'client reports connected');

  await client.disconnect();
  t.end();
});

/**
 * Fake noble peripheral whose connectAsync is util.promisify of a
 * callback-style connect, exactly like @abandonware/noble 1.9.2-10.
 */
function createFakePeripheral({completes = true} = {}) {
  const peripheral = new EventEmitter();
  peripheral.address = 'aa:bb:cc:dd:ee:ff';
  peripheral.state = 'disconnected';
  peripheral.connectArgs = null;
  peripheral.disconnectCalls = 0;

  // Same shape as noble: connect(callback) only, connectAsync promisified on top.
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
 * Minimal noble + FTMS bike stand-in for Ic4BikeClient.connect().
 */
function createIc4Harness() {
  const noble = new EventEmitter();
  noble.state = 'poweredOn';
  noble.startScanningAsync = async () => {};
  noble.stopScanningAsync = async () => {};
  noble.stopScanning = () => {};

  const peripheral = createFakePeripheral();
  peripheral.advertisement = {localName: 'IC Bike', serviceUuids: ['1826']};

  const indoorBikeData = new EventEmitter();
  indoorBikeData.uuid = '2ad2';
  indoorBikeData.descriptors = [];
  indoorBikeData.discoverDescriptorsAsync = async () => {
    indoorBikeData.descriptors.push({uuid: '2902', writeValueAsync: async () => {}});
  };
  peripheral.discoverSomeServicesAndCharacteristicsAsync = async () => ({characteristics: [indoorBikeData]});

  setTimeout(() => noble.emit('discover', peripheral), 0);
  return {noble, peripheral, indoorBikeData};
}
