import {EventEmitter} from 'events';

import test from '../support/tape.js';
import {Ic8BikeClient} from '../../bikes/ic8.js';
import {Ewma} from '../../util/power-estimator.js';

/**
 * Create an IC8 client with a stub noble so no BLE stack is touched.
 */
function createClient() {
  return new Ic8BikeClient({noble: {}});
}

// Keeps connect()/disconnect() logging out of the test output.
const silentLog = {info() {}, warn() {}, log() {}};

/**
 * Combined wheel + crank CSC packet (flags 0x03): six wheel bytes come first,
 * then the crank revolution count and crank event time.
 */
function combinedPacket({wheelRevolutions, wheelTime, crankRevolutions, crankTimestamp}) {
  const buf = Buffer.alloc(11);
  buf.writeUInt8(0x03, 0);
  buf.writeUInt32LE(wheelRevolutions, 1);
  buf.writeUInt16LE(wheelTime, 5);
  buf.writeUInt16LE(crankRevolutions, 7);
  buf.writeUInt16LE(crankTimestamp, 9);
  return buf;
}

/**
 * Crank-only CSC packet (flags 0x02).
 */
function crankPacket({crankRevolutions, crankTimestamp}) {
  const buf = Buffer.alloc(5);
  buf.writeUInt8(0x02, 0);
  buf.writeUInt16LE(crankRevolutions, 1);
  buf.writeUInt16LE(crankTimestamp, 3);
  return buf;
}

test('onCscData() skips the wheel fields of a combined CSC packet (60 rpm)', t => {
  const client = createClient();
  const stats = [];
  client.on('stats', (value) => stats.push(value));

  // Wheel data is cumulative and irrelevant to cadence, but it shifts the crank
  // offsets by six bytes. One crank revolution per second is 60 rpm.
  client.onCscData(combinedPacket({wheelRevolutions: 10, wheelTime: 2048, crankRevolutions: 100, crankTimestamp: 1024}));
  client.onCscData(combinedPacket({wheelRevolutions: 12, wheelTime: 4096, crankRevolutions: 101, crankTimestamp: 2048}));

  const latest = stats[stats.length - 1];
  t.equal(latest.cadence, 60, 'decodes 60 rpm from the crank half of the packet');
  t.ok(latest.power > 0, 'emits an estimated power for a pedalling rider');
  t.end();
});

test('onCscData() decodes a crank-only CSC packet', t => {
  const client = createClient();
  const stats = [];
  client.on('stats', (value) => stats.push(value));

  client.onCscData(crankPacket({crankRevolutions: 100, crankTimestamp: 1024}));
  client.onCscData(crankPacket({crankRevolutions: 102, crankTimestamp: 2048}));

  t.equal(stats[stats.length - 1].cadence, 120, 'two revolutions in one second is 120 rpm');
  t.end();
});

test('onCscData() ignores malformed CSC frames instead of throwing', t => {
  const client = createClient();
  const stats = [];
  client.on('stats', (value) => stats.push(value));

  t.doesNotThrow(() => client.onCscData(Buffer.from([0x02, 0x64])), 'crank-only frame shorter than 5 bytes is ignored');
  t.doesNotThrow(() => client.onCscData(Buffer.from([0x03, 0, 0, 0, 0, 0, 0, 0x64])), 'combined frame truncated before the crank time is ignored');
  t.doesNotThrow(() => client.onCscData(Buffer.alloc(0)), 'empty frame is ignored');
  t.equal(stats.length, 0, 'no stats emitted for malformed frames');
  t.equal(client.state.rpm, 0, 'no cadence decoded from garbage');
  t.end();
});

test('onCscData() reports 0 rpm and 0 W when the cranks stop advancing', t => {
  const client = createClient();
  const stats = [];
  client.on('stats', (value) => stats.push(value));

  client.onCscData(crankPacket({crankRevolutions: 100, crankTimestamp: 1024}));
  client.onCscData(crankPacket({crankRevolutions: 101, crankTimestamp: 2048}));
  const pedalling = stats[stats.length - 1];
  t.equal(pedalling.cadence, 60, 'pedalling cadence is 60 rpm');
  t.ok(pedalling.power > 0, 'power estimate is non-zero while pedalling');

  // Same crank revolutions and timestamp: the bike keeps notifying while the
  // cranks are stationary.
  client.onCscData(crankPacket({crankRevolutions: 101, crankTimestamp: 2048}));
  const stationary = stats[stats.length - 1];
  t.equal(stationary.cadence, 0, 'cadence drops to 0 instead of holding the previous value');
  t.equal(stationary.power, 0, 'power does not keep the stale estimate');
  t.end();
});

test('Ewma.reset() clears the smoothed value and re-seeds on the next sample', t => {
  const filter = new Ewma(0.25);
  t.equal(filter.push(200), 200, 'first sample seeds the filter');
  t.equal(filter.push(0), 150, 'the second sample is smoothed normally');

  filter.reset();
  t.equal(filter.value, 0, 'the accumulated value is dropped');
  t.equal(filter.initialized, false, 'the filter behaves like a fresh instance');
  t.equal(filter.push(80), 80, 'the first sample after reset seeds again instead of smoothing from 150');
  t.end();
});

test('parseIndoorBikeData frames from FTMS override the CSC/estimator values', async t => {
  const harness = createBleHarness({csc: true, ftms: true});
  const client = new Ic8BikeClient({noble: harness.noble, log: silentLog});
  const stats = [];
  client.on('stats', (value) => stats.push(value));
  await client.connect();

  t.ok(harness.ftms.subscribed, 'FTMS Indoor Bike Data was subscribed');
  t.ok(harness.csc.subscribed, 'CSC was still subscribed as a fallback');

  // FTMS reports its own cadence and power: those are authoritative.
  harness.ftms.emit('data', indoorBikeFrame({cadenceRpm: 90, powerWatts: 250, speedHundredthsKmh: 3000}));
  const fromFtms = stats[stats.length - 1];
  t.equal(fromFtms.cadence, 90, 'FTMS cadence is used as-is');
  t.equal(fromFtms.power, 250, 'FTMS power is used instead of the estimator');
  t.ok(Math.abs(fromFtms.speed - 30 * (1000 / 3600)) < 1e-9, 'FTMS speed is forwarded in m/s');

  // CSC keeps arriving in parallel (one crank revolution per second = 60 rpm)
  // but must not pull cadence/power back to the fallback values.
  harness.csc.emit('data', crankPacket({crankRevolutions: 100, crankTimestamp: 1024}));
  harness.csc.emit('data', crankPacket({crankRevolutions: 101, crankTimestamp: 2048}));
  const afterCsc = stats[stats.length - 1];
  t.equal(afterCsc.cadence, 90, 'the CSC-derived 60 rpm does not override native cadence');
  t.equal(afterCsc.power, 250, 'native power is not replaced by the CSC estimate');

  await client.disconnect();
  t.end();
});

test('IC8 keeps working on CSC-only consoles', async t => {
  const harness = createBleHarness({csc: true, ftms: false});
  const client = new Ic8BikeClient({noble: harness.noble, log: silentLog});
  const stats = [];
  const ready = [];
  client.on('stats', (value) => stats.push(value));
  client.on('ready', (value) => ready.push(value));

  await client.connect();
  t.equal(ready.length, 1, 'the client reports ready without FTMS Indoor Bike Data');

  harness.csc.emit('data', crankPacket({crankRevolutions: 100, crankTimestamp: 1024}));
  harness.csc.emit('data', crankPacket({crankRevolutions: 102, crankTimestamp: 2048}));
  const latest = stats[stats.length - 1];
  t.equal(latest.cadence, 120, 'CSC cadence is still decoded');
  t.ok(latest.power > 0, 'CSC cadence still produces a power estimate');
  t.notOk('speed' in latest, 'no speed field is invented when the console does not report it');

  await client.disconnect();
  t.end();
});

test('IC8 estimates power from resistance when FTMS reports cadence but no power', async t => {
  const harness = createBleHarness({csc: true, ftms: true, resistance: true});
  const client = new Ic8BikeClient({noble: harness.noble, log: silentLog});
  const stats = [];
  client.on('stats', (value) => stats.push(value));
  await client.connect();

  harness.resistance.emit('data', Buffer.from([80]));
  harness.ftms.emit('data', indoorBikeFrame({cadenceRpm: 80, withPower: false, withSpeed: false}));
  const latest = stats[stats.length - 1];
  t.equal(latest.cadence, 80, 'FTMS cadence is used as-is');
  t.ok(latest.power > 0, 'power falls back to the resistance estimator');

  await client.disconnect();
  t.end();
});

test('IC8 uses native FTMS power even when no cadence source reports rotation', async t => {
  const harness = createBleHarness({csc: false, ftms: true});
  const client = new Ic8BikeClient({noble: harness.noble, log: silentLog});
  const stats = [];
  client.on('stats', (value) => stats.push(value));
  await client.connect();

  harness.ftms.emit('data', indoorBikeFrame({powerWatts: 180, withCadence: false, withSpeed: false}));
  t.equal(stats[stats.length - 1].power, 180, 'native power is trusted without a cadence source');

  await client.disconnect();
  t.end();
});

test('IC8 drops to 0 W immediately when FTMS reports a stopped rider', async t => {
  const harness = createBleHarness({csc: false, ftms: true});
  const client = new Ic8BikeClient({noble: harness.noble, log: silentLog});
  const stats = [];
  client.on('stats', (value) => stats.push(value));
  await client.connect();

  harness.ftms.emit('data', indoorBikeFrame({cadenceRpm: 85, powerWatts: 220, withSpeed: false}));
  t.equal(stats[stats.length - 1].power, 220, 'pedalling power is reported');

  harness.ftms.emit('data', indoorBikeFrame({cadenceRpm: 0, powerWatts: 0, withSpeed: false}));
  const stopped = stats[stats.length - 1];
  t.equal(stopped.power, 0, 'no stale smoothed wattage is emitted');
  t.equal(stopped.cadence, 0, 'cadence drops to 0');

  await client.disconnect();
  t.end();
});

test('IC8 ignores malformed FTMS Indoor Bike Data frames', async t => {
  const harness = createBleHarness({csc: false, ftms: true});
  const client = new Ic8BikeClient({noble: harness.noble, log: silentLog});
  const stats = [];
  client.on('stats', (value) => stats.push(value));
  await client.connect();

  t.doesNotThrow(() => harness.ftms.emit('data', Buffer.from([0x45, 0x00])), 'truncated frame is swallowed');
  t.doesNotThrow(() => harness.ftms.emit('data', Buffer.alloc(0)), 'empty frame is swallowed');
  t.equal(stats.length, 0, 'no stats emitted for malformed frames');

  await client.disconnect();
  t.end();
});

test('IC8 connect() rejects with the existing error when neither CSC nor FTMS is present', async t => {
  const harness = createBleHarness({csc: false, ftms: false});
  const client = new Ic8BikeClient({noble: harness.noble, log: silentLog});

  try {
    await client.connect();
    t.fail('connect() must fail when there is no measurement source');
  } catch (error) {
    t.match(error.message, /CSC Measurement characteristic not found/, 'keeps the reported error message');
  }
  t.end();
});

test('IC8 falls back to CSC when the console refuses FTMS notifications', async t => {
  const harness = createBleHarness({csc: true, ftms: true, ftmsSubscribeFails: true});
  const client = new Ic8BikeClient({noble: harness.noble, log: silentLog});
  const stats = [];
  client.on('stats', (value) => stats.push(value));

  await client.connect();
  harness.csc.emit('data', crankPacket({crankRevolutions: 100, crankTimestamp: 1024}));
  harness.csc.emit('data', crankPacket({crankRevolutions: 101, crankTimestamp: 2048}));
  t.equal(stats[stats.length - 1].cadence, 60, 'CSC still drives cadence after a failed FTMS subscribe');

  await client.disconnect();
  t.end();
});

/**
 * Indoor Bike Data frame (0x2AD2) with the fields the tests need.
 * Flag bits: 0 = "speed absent" (inverted), 2 = cadence, 6 = power.
 */
function indoorBikeFrame({cadenceRpm = 0, powerWatts = 0, speedHundredthsKmh = 0, withSpeed = true, withCadence = true, withPower = true}) {
  let flags = 0;
  if (!withSpeed) flags |= 0x0001;
  if (withCadence) flags |= 0x0004;
  if (withPower) flags |= 0x0040;

  const parts = [Buffer.alloc(2)];
  parts[0].writeUInt16LE(flags, 0);
  if (withSpeed) {
    const speed = Buffer.alloc(2);
    speed.writeUInt16LE(speedHundredthsKmh, 0);
    parts.push(speed);
  }
  if (withCadence) {
    const cadence = Buffer.alloc(2);
    cadence.writeUInt16LE(Math.round(cadenceRpm * 2), 0);
    parts.push(cadence);
  }
  if (withPower) {
    const power = Buffer.alloc(2);
    power.writeInt16LE(powerWatts, 0);
    parts.push(power);
  }
  return Buffer.concat(parts);
}

/**
 * Build a GATT characteristic stand-in with the noble surface ic8.js uses.
 */
function createCharacteristic(uuid, {subscribeFails = false} = {}) {
  const characteristic = new EventEmitter();
  characteristic.uuid = uuid;
  characteristic.subscribed = false;
  characteristic.subscribeAsync = async () => {
    if (subscribeFails) {
      throw new Error(`subscribe failed for ${uuid}`);
    }
    characteristic.subscribed = true;
  };
  return characteristic;
}

/**
 * Minimal noble + peripheral stand-in so Ic8BikeClient.connect() can run
 * without touching a real BLE stack.
 */
function createBleHarness({csc = true, ftms = true, resistance = false, ftmsSubscribeFails = false} = {}) {
  const noble = new EventEmitter();
  noble.state = 'poweredOn';
  noble.startScanningAsync = async () => {};
  noble.stopScanningAsync = async () => {};
  noble.stopScanning = () => {};

  const characteristics = [];
  const handles = {};
  if (csc) {
    handles.csc = createCharacteristic('2a5b');
    characteristics.push(handles.csc);
  }
  if (ftms) {
    handles.ftms = createCharacteristic('2ad2', {subscribeFails: ftmsSubscribeFails});
    characteristics.push(handles.ftms);
  }
  if (resistance) {
    handles.resistance = createCharacteristic('fff2');
    characteristics.push(handles.resistance);
  }

  const peripheral = new EventEmitter();
  peripheral.address = 'aa:bb:cc:dd:ee:ff';
  peripheral.advertisement = {localName: 'IC8', serviceUuids: []};
  peripheral.connectAsync = async () => {};
  peripheral.disconnectAsync = async () => peripheral.emit('disconnect');
  peripheral.discoverSomeServicesAndCharacteristicsAsync = async () => ({characteristics});

  setTimeout(() => noble.emit('discover', peripheral), 0);
  return Object.assign({noble, peripheral, characteristics}, handles);
}

