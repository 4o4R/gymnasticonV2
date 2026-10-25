import {EventEmitter} from 'events';
import {spawnSync} from 'child_process';

import test from '../support/tape.js';
import {ScanCoordinator, createScanTag, waitForPeripheral} from '../../util/scan-coordinator.js';
import {SpeedSensorClient} from '../../speed/speed-sensor-client.js';
import {CadenceSensorClient} from '../../cadence/cadence-sensor-client.js';

class FakeNoble extends EventEmitter {
  constructor() {
    super();
    this.state = 'poweredOn';
    this.scanStarts = 0;
    this.scanStops = 0;
    this.scanning = false;
  }

  async startScanningAsync() {
    if (this.scanning) {
      throw new Error('scan already in progress');
    }
    this.scanning = true;
    this.scanStarts += 1;
  }

  stopScanning() {
    this.scanning = false;
    this.scanStops += 1;
  }
}

const silentSensorLog = {log() {}, warn() {}, error() {}};

function sensorPeripheral(client) {
  const characteristic = new EventEmitter();
  characteristic.uuid = client.characteristicUuid;
  characteristic.subscribeAsync = async () => {};
  characteristic.unsubscribeAsync = async () => {};
  const peripheral = new EventEmitter();
  peripheral.state = 'disconnected';
  peripheral.advertisement = {serviceUuids: [client.serviceUuid]};
  peripheral.connectAsync = async () => { peripheral.state = 'connected'; };
  peripheral.disconnectAsync = async () => { peripheral.state = 'disconnected'; };
  peripheral.discoverServicesAndCharacteristicsAsync = async () => ({characteristics: [characteristic]});
  return peripheral;
}

for (const SensorClient of [SpeedSensorClient, CadenceSensorClient]) {
  test(`${SensorClient.name} does not wait for advertisements after scan acquisition is cancelled`, async t => {
    const noble = new FakeNoble();
    noble.startScanningAsync = () => new Promise(() => {});
    const coordinator = new ScanCoordinator(noble);
    const client = new SensorClient(noble, {scanCoordinator: coordinator});
    const discovering = client.scanForPeripheral(1000);
    await coordinator.releaseAll();
    let timer;
    const cancelled = await Promise.race([
      discovering,
      new Promise(resolve => { timer = setTimeout(() => resolve('still waiting'), 30); }),
    ]);
    clearTimeout(timer);
    t.equal(cancelled, null, 'cancelled acquisition finishes without waiting for discovery');
    t.equal(noble.listenerCount('discover'), 0, 'no listener remains on an unowned scan');
    t.equal(coordinator.holderCount, 0, 'no cancelled claim remains');
    const peripheral = {advertisement: {serviceUuids: [client.serviceUuid]}};
    // Settle an old implementation's discovery promise too, so a failed
    // regression does not leave its timeout running in the test process.
    noble.emit('discover', peripheral);
    await discovering;

    noble.startScanningAsync = FakeNoble.prototype.startScanningAsync.bind(noble);
    const retry = client.scanForPeripheral(1000);
    await new Promise(resolve => setImmediate(resolve));
    noble.emit('discover', peripheral);
    t.equal(await retry, peripheral, 'a subsequent acquisition discovers normally');
    t.equal(coordinator.holderCount, 0, 'successful discovery releases its own claim');
    await client.disconnect();
    t.end();
  });

  test(`${SensorClient.name} does not undo an intentional stop while reconnect cleanup is awaiting`, async t => {
    const noble = new FakeNoble();
    const coordinator = new ScanCoordinator(noble);
    const client = new SensorClient(noble, {
      scanCoordinator: coordinator, logger: silentSensorLog,
      connectTimeout: 0.02, maxConnectRetries: 0,
    });
    const reconnecting = client.reconnect();
    await client.disconnect();
    await reconnecting;
    t.equal(client.shouldReconnect, false, 'intentional stop stays latched');
    t.equal(client.connecting, false, 'the stale retry does not begin connecting');
    t.equal(noble.scanStarts, 0, 'no scan starts after shutdown');
    t.equal(noble.listenerCount('discover'), 0, 'no discovery listener is reattached');
    t.equal(coordinator.holderCount, 0, 'no retry claim remains');
    t.equal(client.retryTimer, null, 'shutdown does not leave a retry timer');
    t.end();
  });

  test(`${SensorClient.name} cancels active discovery immediately without stopping a healthy peer`, async t => {
    const noble = new FakeNoble();
    const coordinator = new ScanCoordinator(noble);
    await coordinator.acquire('healthy-peer');
    const client = new SensorClient(noble, {scanCoordinator: coordinator, logger: silentSensorLog});
    const discovering = client.scanForPeripheral(0);
    await new Promise(resolve => setImmediate(resolve));
    t.equal(noble.listenerCount('discover'), 1, 'an unlimited discovery is active');
    const attempt = client.discoveryAttempt;
    await client.disconnect();
    let timer;
    const cancelled = await Promise.race([
      discovering,
      new Promise(resolve => { timer = setTimeout(() => resolve('still waiting'), 30); }),
    ]);
    clearTimeout(timer);
    t.equal(cancelled, null, 'shutdown resolves active discovery without waiting for a deadline');
    t.equal(noble.listenerCount('discover'), 0, 'the discovery listener is removed immediately');
    t.equal(attempt?.listenerCount('cancel'), 0, 'the cancellation listener is removed too');
    t.equal(coordinator.holderCount, 1, 'only the healthy peer retains ownership');
    t.equal(noble.scanning, true, 'the peer keeps its native scan');
    const peripheral = sensorPeripheral(client);
    // Also settle a pre-fix unlimited discovery so a red run can finish.
    noble.emit('discover', peripheral);
    await discovering;
    const reconnecting = client.connect();
    await new Promise(resolve => setImmediate(resolve));
    noble.emit('discover', {advertisement: {serviceUuids: ['ffff']}});
    await new Promise(resolve => setImmediate(resolve));
    noble.emit('discover', peripheral);
    await reconnecting;
    t.equal(client.isConnected, true, 'a later explicit connect still accepts a late sensor');
    await client.disconnect();
    await coordinator.releaseAll();
    t.end();
  });

  test(`${SensorClient.name} old discovery cleanup cannot release a successor or clear its state`, async t => {
    const noble = new FakeNoble();
    const coordinator = new ScanCoordinator(noble);
    const client = new SensorClient(noble, {scanCoordinator: coordinator, logger: silentSensorLog});
    const oldConnection = client.connect();
    await new Promise(resolve => setImmediate(resolve));
    await client.disconnect();
    const successor = client.connect();
    const successorAttempt = client.discoveryAttempt;
    await oldConnection;
    await new Promise(resolve => setImmediate(resolve));
    t.equal(client.connecting, true, 'old cancellation does not clear the new connecting flag');
    t.equal(coordinator.holderCount, 1, 'the successor keeps its own scan claim');
    t.ok(coordinator.has(successorAttempt.scanTag), 'the current attempt still owns its tag');
    t.equal(noble.listenerCount('discover'), 1, 'only the successor listens for advertisements');
    noble.emit('discover', sensorPeripheral(client));
    await successor;
    t.equal(client.isConnected, true, 'successor setup completes normally');
    await client.disconnect();
    t.end();
  });
}

test('ScanCoordinator starts one native scan for two holders', async (t) => {
  const noble = new FakeNoble();
  const coordinator = new ScanCoordinator(noble, {logger: {warn() {}}});

  await coordinator.acquire('heart-rate');
  await coordinator.acquire('speed');

  t.equal(noble.scanStarts, 1, 'the second holder reuses the running scan');
  t.equal(coordinator.holderCount, 2, 'both holders are tracked');
  t.equal(coordinator.isScanning, true, 'the coordinator reports an active scan');
});

test('ScanCoordinator stops the scan only when the last holder releases', async (t) => {
  const noble = new FakeNoble();
  const coordinator = new ScanCoordinator(noble, {logger: {warn() {}}});

  await coordinator.acquire('heart-rate');
  await coordinator.acquire('cadence');

  t.equal(await coordinator.release('heart-rate'), false, 'the first release keeps the scan running');
  t.equal(noble.scanStops, 0, 'no native stop while a holder remains');
  t.equal(coordinator.isScanning, true, 'the scan is still owned');

  t.equal(await coordinator.release('cadence'), true, 'the last release stops the scan');
  t.equal(noble.scanStops, 1, 'the native scan is stopped exactly once');
  t.equal(coordinator.isScanning, false, 'the coordinator reports a stopped scan');
  t.equal(await coordinator.release('cadence'), false, 'releasing an unknown holder is a no-op');
});

test('ScanCoordinator releaseAll() drops every holder and stops once', async (t) => {
  const noble = new FakeNoble();
  const coordinator = new ScanCoordinator(noble, {logger: {warn() {}}});

  await coordinator.acquire('heart-rate');
  await coordinator.acquire('speed');

  t.equal(await coordinator.releaseAll(), true, 'releaseAll stops an active scan');
  t.equal(noble.scanStops, 1, 'one native stop');
  t.equal(coordinator.holderCount, 0, 'no holders remain');
  t.equal(await coordinator.releaseAll(), false, 'a second releaseAll is a no-op');
});

test('ScanCoordinator starts the scan once under concurrent acquires', async (t) => {
  const noble = new FakeNoble();
  const coordinator = new ScanCoordinator(noble, {logger: {warn() {}}});

  await Promise.all([
    coordinator.acquire('heart-rate'),
    coordinator.acquire('speed'),
    coordinator.acquire('cadence'),
  ]);

  t.equal(noble.scanStarts, 1, 'concurrent holders share a single start');
  t.equal(coordinator.holderCount, 3, 'all holders are tracked');
});

test('a holder timeout does not stop scanning for the other holders', async (t) => {
  const noble = new FakeNoble();
  const coordinator = new ScanCoordinator(noble, {logger: {warn() {}}});

  await coordinator.acquire('heart-rate');
  await coordinator.acquire('speed');

  const missed = await waitForPeripheral(noble, () => false, {timeoutMs: 10});
  t.equal(missed, null, 'the waiting holder times out without a match');

  await coordinator.release('speed');
  t.equal(noble.scanStops, 0, 'the still-connected holder keeps the radio scanning');
  t.equal(coordinator.isScanning, true, 'the scan is still owned');

  await coordinator.releaseAll();
  t.equal(noble.scanStops, 1, 'releasing everyone finally stops the scan');
});

test('waitForPeripheral() resolves with the first matching peripheral', async (t) => {
  const noble = new FakeNoble();
  const wanted = {address: 'AA:BB:CC:DD:EE:FF'};

  const found = waitForPeripheral(noble, (peripheral) => peripheral === wanted, {timeoutMs: 50});
  t.equal(noble.listenerCount('discover'), 1, 'the wait attaches exactly one listener');

  noble.emit('discover', {address: '00:00:00:00:00:01'});
  noble.emit('discover', wanted);

  t.equal(await found, wanted, 'the matching peripheral is returned');
  t.equal(noble.listenerCount('discover'), 0, 'the listener is detached once a match settles');

  const timedOut = await waitForPeripheral(noble, () => false, {timeoutMs: 5});
  t.equal(timedOut, null, 'an unmatched wait resolves null on timeout');
  t.equal(noble.listenerCount('discover'), 0, 'the listener is detached on timeout');
  t.end();
});

test('ScanCoordinator adopts a scan somebody else already started', async (t) => {
  const noble = new FakeNoble();
  noble.scanning = true; // A pre-existing owner (e.g. a bike scan) holds the radio.
  const coordinator = new ScanCoordinator(noble, {logger: {warn() {}}});

  await coordinator.acquire('heart-rate');

  t.equal(coordinator.isScanning, true, 'the coordinator adopts the running scan');
  t.equal(noble.scanStarts, 0, 'no second start attempt succeeded');
});

test('ScanCoordinator rolls back the holder when the scan cannot start', async (t) => {
  const noble = new FakeNoble();
  noble.startScanningAsync = async () => {
    throw new Error('adapter is not powered on');
  };
  const coordinator = new ScanCoordinator(noble, {logger: {warn() {}}});

  let error;
  try {
    await coordinator.acquire('heart-rate');
  } catch (err) {
    error = err;
  }

  t.equal(error?.message, 'adapter is not powered on', 'the start failure surfaces to the caller');
  t.equal(coordinator.holderCount, 0, 'the failed holder is not left registered');
  t.equal(coordinator.isScanning, false, 'the coordinator is not marked as scanning');
});

test('createScanTag() returns unique owner tags', (t) => {
  const first = createScanTag('speed');
  const second = createScanTag('speed');

  t.notEqual(first, second, 'each client instance gets its own tag');
  t.ok(first.startsWith('speed-'), 'the tag keeps the readable prefix');
  t.end();
});

test('pinned noble cancels scans and pending links without taking over successor operations', t => {
  // Keep the actual dependency cache isolated from the rest of the suite. Only
  // the HCI socket is replaced; all noble, GAP, GATT and Peripheral code is real.
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    encoding: 'utf8',
    timeout: 10000,
    input: String.raw`
import assert from 'assert';
import {EventEmitter} from 'events';
import {createRequire} from 'module';
import {pathToFileURL} from 'url';
import path from 'path';
const require = createRequire(pathToFileURL(path.join(process.cwd(), 'package.json')));
class Socket extends EventEmitter {
  constructor() { super(); this.writes = []; }
  bindRaw(id) { return id; }
  start() {} stop() {} isDevUp() { return false; } setFilter() {}
  write(buffer) { this.writes.push(Buffer.from(buffer)); }
}
const native = require.resolve('@abandonware/bluetooth-hci-socket');
require.cache[native] = {id: native, filename: native, loaded: true, exports: Socket};
const {initializeBluetooth, disconnectPeripheral, connectWithTimeout} = await import('./src/util/noble-wrapper.js');
const {scan} = await import('./src/util/ble-scan.js');
const {ScanCoordinator} = await import('./src/util/scan-coordinator.js');
const {HeartRateClient} = await import('./src/hr/heart-rate-client.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const makeNoble = async () => {
  const {noble} = await initializeBluetooth('hci0', {forceNewInstance: true});
  void noble.state;
  noble._state = 'poweredOn';
  noble._bindings._hci.address = '11:22:33:44:55:66';
  noble._bindings._hci.addressType = 'public';
  return noble;
};
const n = await makeNoble();
assert.strictEqual(await scan(n, [], () => false, {timeoutMs: 10}), null);
assert.strictEqual(n.listenerCount('scanStart'), 0, 'expired start callback removed');
const following = scan(n, [], () => true, {timeoutMs: 100, stopScanOnMatch: false});
n._bindings._hci.emit('leScanEnableSet', 0);
await tick();
assert.strictEqual(n._bindings._gap._scanState, 'started', 'old completion did not stop successor');
n.emit('discover', {});
await following;
const c = await makeNoble();
const coordinator = new ScanCoordinator(c, {startTimeoutMs: 10});
await assert.rejects(coordinator.acquire('first'), error => error.code === 'BLE_SCAN_START_TIMEOUT');
assert.strictEqual(coordinator.holderCount, 0);
assert.strictEqual(c.listenerCount('scanStart'), 0);
const cancelled = coordinator.acquire('cancelled');
await coordinator.releaseAll();
assert.strictEqual(await cancelled, false);
const next = coordinator.acquire('next');
c._bindings._hci.emit('leScanEnableSet', 0);
assert.strictEqual(await next, true);
assert.strictEqual(coordinator.isScanning, true);
await coordinator.releaseAll();
const {noble: lazy} = await initializeBluetooth('hci1', {forceNewInstance: true});
const lazyCoordinator = new ScanCoordinator(lazy, {startTimeoutMs: 10});
await assert.rejects(lazyCoordinator.acquire('lazy'), error => error.code === 'BLE_SCAN_START_TIMEOUT');
assert.strictEqual(lazy.listenerCount('stateChange'), 0, 'expired lazy-start callback removed');
lazy.emit('stateChange', 'poweredOn');
assert.strictEqual(lazy._bindings._hci._socket.writes.filter(b => b[0] === 1 && b.readUInt16LE(1) === 0x200c && b[4] === 1).length, 0);
const link = await makeNoble();
let serial = 0;
const peripheral = () => {
  const Peripheral = require('@abandonware/noble/lib/peripheral');
  const id = 'aabbccddee' + (++serial).toString(16).padStart(2, '0');
  const address = id.match(/../g).join(':');
  const p = new Peripheral(link, id, address, 'public', true, {serviceUuids: ['180d']}, -20);
  link._peripherals[id] = p;
  link._bindings._addresses[id] = address;
  link._bindings._addresseTypes[id] = 'public';
  return p;
};
const first = peripheral(), queued = peripheral();
const firstConnect = first.connectAsync().catch(() => {});
const queuedConnect = queued.connectAsync().catch(() => {});
assert.strictEqual(await disconnectPeripheral(queued, 30), true);
await queuedConnect;
assert.deepStrictEqual(link._bindings._connectionQueue, []);
const cancelling = disconnectPeripheral(first, 30);
assert.strictEqual(link._bindings._hci._socket.writes.slice(-1)[0].toString('hex'), '010e2000');
link._bindings.onLeConnComplete(2, 0, 0, 'public', first.address, 24, 0, 500, 0);
assert.strictEqual(await cancelling, true);
await firstConnect;
assert.strictEqual(link._bindings._pendingConnectionUuid, null);
const late = peripheral();
const lateConnect = late.connectAsync();
assert.strictEqual(await disconnectPeripheral(late, 10), false);
link._bindings.onLeConnComplete(0, 64, 0, 'public', late.address, 24, 0, 500, 0);
await lateConnect;
const disconnects = () => link._bindings._hci._socket.writes.filter(b => b[0] === 1 && b.readUInt16LE(1) === 0x0406);
assert.strictEqual(disconnects().slice(-1)[0].readUInt16LE(4), 64, 'late link released using real handle');
link._bindings.onDisconnComplete(64, 0x13);
const timed = peripheral();
const timedWork = connectWithTimeout(timed, 10);
await wait(20);
link._bindings.onLeConnComplete(2, 0, 0, 'public', timed.address, 24, 0, 500, 0);
await assert.rejects(timedWork, /Timed out/);
const hrPeripheral = peripheral();
const hr = new HeartRateClient(link, {setupTimeoutMs: 100, connectionRetries: 1});
const setup = hr.onDiscover(hrPeripheral);
await tick();
link._bindings.onLeConnComplete(0, 65, 0, 'public', hrPeripheral.address, 24, 0, 500, 0);
await tick();
assert.ok(hrPeripheral.listenerCount('disconnect') > 0);
link._bindings.onDisconnComplete(65, 0x13);
await setup;
link._bindings._hci.emit('leScanEnableSet', 0);
await tick();
assert.strictEqual(hr.connecting, false);
assert.strictEqual(hr.isScanning, true, 'mid-GATT loss resumes discovery');
await hr.disconnect();
const shutdownPeripheral = peripheral();
const shutdownHr = new HeartRateClient(link, {setupTimeoutMs: 100, connectionRetries: 1});
const pendingSetup = shutdownHr.onDiscover(shutdownPeripheral);
await tick();
const stopped = shutdownHr.disconnect();
await tick();
link._bindings.onLeConnComplete(0, 66, 0, 'public', shutdownPeripheral.address, 24, 0, 500, 0);
await tick();
assert.strictEqual(disconnects().slice(-1)[0].readUInt16LE(4), 66);
link._bindings.onDisconnComplete(66, 0x13);
await Promise.all([stopped, pendingSetup]);
assert.strictEqual(shutdownHr.connected, false);
assert.strictEqual(shutdownPeripheral.state, 'disconnected');
assert.ok(disconnects().every(b => b.readUInt16LE(4) !== 0), 'never disconnects undefined handle zero');
process.exit(0);
`,
  });
  t.equal(result.status, 0, result.stderr || result.stdout || 'actual noble lifecycle probes pass');
  t.end();
});

