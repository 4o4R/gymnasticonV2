import {EventEmitter} from 'events';

import test from '../support/tape.js';
import {HeartRateClient} from '../../hr/heart-rate-client.js';
import {ScanCoordinator} from '../../util/scan-coordinator.js';

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

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createPeripheral({characteristics = []} = {}) {
  const peripheral = new EventEmitter();
  peripheral.address = 'AA:BB:CC:DD:EE:FF';
  peripheral.advertisement = {localName: 'HR Monitor', serviceUuids: ['180d']};
  peripheral.disconnectCalls = 0;
  peripheral.connectAsync = async () => {};
  peripheral.disconnectAsync = async () => {
    peripheral.disconnectCalls += 1;
  };
  peripheral.discoverServicesAsync = async () => [
    {
      discoverCharacteristicsAsync: async () => characteristics,
    },
  ];
  return peripheral;
}

function createCharacteristic() {
  const characteristic = new EventEmitter();
  characteristic.unsubscribeCalls = 0;
  characteristic.subscribeAsync = async () => {};
  characteristic.unsubscribeAsync = async () => {
    characteristic.unsubscribeCalls += 1;
  };
  return characteristic;
}

function createClient(noble) {
  return new HeartRateClient(noble, {
    connectionManager: {connect: async () => {}},
    scanCoordinator: new ScanCoordinator(noble, {logger: {warn() {}}}),
  });
}

test('HeartRateClient disconnects a peripheral whose GATT setup failed', async (t) => {
  const noble = new FakeNoble();
  const client = createClient(noble);
  const peripheral = createPeripheral({characteristics: []});
  let connectEvents = 0;
  client.on('connect', () => {
    connectEvents += 1;
  });

  await client.connect();
  await client.onDiscover(peripheral);

  t.equal(peripheral.disconnectCalls, 1, 'the physically connected peripheral is disconnected again');
  t.equal(client.connected, false, 'a failed setup never marks the client connected');
  t.equal(client.connecting, false, 'the connecting flag is cleared');
  t.equal(connectEvents, 0, 'no connect event is emitted');
  t.equal(client.peripheral, null, 'no stale peripheral reference is kept');
  t.equal(client.characteristic, null, 'no stale characteristic reference is kept');

  await client.disconnect();
  t.end();
});

test('HeartRateClient does not restart scanning after an intentional disconnect', async (t) => {
  const noble = new FakeNoble();
  const client = createClient(noble);

  await client.connect();
  t.equal(noble.scanStarts, 1, 'discovery started a scan');

  await client.disconnect();
  t.equal(noble.scanStops, 1, 'the shared scan was released');

  const startsAfterDisconnect = noble.scanStarts;
  let disconnectEvents = 0;
  client.on('disconnect', () => {
    disconnectEvents += 1;
  });

  client.onPeripheralDisconnect();
  await client.restartScan();
  await flush();

  t.equal(noble.scanStarts, startsAfterDisconnect, 'no scan restart after disconnect()');
  t.equal(disconnectEvents, 0, 'the deliberate stop does not emit a disconnect event');
  t.equal(client.connected, false, 'the client stays disconnected');

  await client.disconnect();
  t.end();
});

test('HeartRateClient never marks a connect completed after disconnect()', async (t) => {
  const noble = new FakeNoble();
  const client = createClient(noble);
  const characteristic = createCharacteristic();
  const peripheral = createPeripheral({characteristics: [characteristic]});

  let resolveServices = null;
  peripheral.discoverServicesAsync = () => new Promise((resolve) => {
    resolveServices = resolve;
  });

  let connectEvents = 0;
  client.on('connect', () => {
    connectEvents += 1;
  });

  await client.connect();
  const attempt = client.onDiscover(peripheral);
  await flush();
  await flush();

  await client.disconnect();
  resolveServices([{discoverCharacteristicsAsync: async () => [characteristic]}]);
  await attempt;

  t.equal(connectEvents, 0, 'the obsolete connection never emits connect');
  t.equal(client.connected, false, 'the obsolete connection never marks the client connected');
  t.equal(client.connecting, false, 'the connecting flag is cleared');
  t.equal(peripheral.disconnectCalls, 1, 'the abandoned peripheral is disconnected');

  await client.disconnect();
  t.end();
});

test('HeartRateClient releases its scan claim on disconnect so other sensors keep scanning', async (t) => {
  const noble = new FakeNoble();
  const coordinator = new ScanCoordinator(noble, {logger: {warn() {}}});
  const client = new HeartRateClient(noble, {
    connectionManager: {connect: async () => {}},
    scanCoordinator: coordinator,
  });

  await coordinator.acquire('watcher');
  await client.connect();
  t.equal(noble.scanStarts, 1, 'the heart-rate client joined the existing scan');

  await client.disconnect();
  t.equal(noble.scanStops, 0, 'the scan keeps running for the other holder');
  t.equal(coordinator.holderCount, 1, 'only the other holder remains');

  await coordinator.releaseAll();
  t.end();
});

test('HeartRateClient ignores a late discovery after disconnect()', async (t) => {
  const noble = new FakeNoble();
  const client = createClient(noble);
  const peripheral = createPeripheral({characteristics: [createCharacteristic()]});

  await client.connect();
  await client.disconnect();

  const startsAfterDisconnect = noble.scanStarts;
  await client.onDiscover(peripheral);

  t.equal(peripheral.disconnectCalls, 0, 'no connection is attempted after disconnect()');
  t.equal(client.connected, false, 'the client stays disconnected');
  t.equal(noble.scanStarts, startsAfterDisconnect, 'no scan is restarted');

  await client.disconnect();
  t.end();
});

test('HeartRateClient resumes discovery when a peripheral disappears during GATT discovery', async t => {
  const noble = new FakeNoble();
  const client = createClient(noble);
  const peripheral = createPeripheral();
  peripheral.discoverServicesAsync = () => new Promise(() => {});
  await client.connect();
  const setup = client.onDiscover(peripheral);
  await flush();
  t.equal(peripheral.listenerCount('disconnect'), 1, 'disconnect is observed before GATT setup finishes');
  peripheral.emit('disconnect');
  await setup;
  await flush();
  t.equal(client.connecting, false, 'a dead GATT request no longer holds the connecting latch');
  t.equal(client.isScanning, true, 'discovery is rearmed');
  await client.disconnect();
  t.end();
});

test('HeartRateClient bounds a silent GATT peer and never waits on unsubscribe during shutdown', async t => {
  const noble = new FakeNoble();
  const client = new HeartRateClient(noble, {
    connectionManager: {connect: async () => {}},
    setupTimeoutMs: 20,
  });
  const silent = createPeripheral();
  silent.discoverServicesAsync = () => new Promise(() => {});
  await client.connect();
  await client.onDiscover(silent);
  await flush();
  t.equal(silent.disconnectCalls, 1, 'the setup deadline releases a silent peer');
  t.equal(client.isScanning, true, 'a silent peer does not permanently disable discovery');
  const characteristic = createCharacteristic();
  characteristic.unsubscribeAsync = () => new Promise(() => {});
  const good = createPeripheral({characteristics: [characteristic]});
  await client.onDiscover(good);
  t.equal(client.connected, true, 'a later peer can finish setup');
  await client.disconnect();
  t.equal(good.disconnectCalls, 1, 'shutdown releases the physical link without awaiting a dead unsubscribe');
  t.equal(characteristic.listenerCount('data'), 0, 'our notification handler is removed');
  t.end();
});

test('HeartRateClient can retry after scan ownership is cancelled during startup', async t => {
  const noble = new FakeNoble();
  noble.startScanningAsync = () => new Promise(() => {});
  const client = createClient(noble);
  const starting = client.connect();
  await client.scanCoordinator.releaseAll();
  let failure;
  await starting.catch(error => { failure = error; });
  t.equal(failure?.code, 'BLE_SCAN_CANCELLED', 'cancelled acquisition is reported to the caller');
  t.equal(client.isScanning, false, 'the client does not claim a scan that never started');
  t.equal(noble.listenerCount('discover'), 0, 'failed acquisition leaves no discovery listener');
  t.equal(client.scanCoordinator.holderCount, 0, 'the cancelled owner is released');

  noble.startScanningAsync = FakeNoble.prototype.startScanningAsync.bind(noble);
  await client.connect();
  t.equal(noble.scanStarts, 1, 'a later connect makes a fresh scan request');
  t.equal(client.isScanning, true, 'the later scan is active');
  await client.disconnect();
  t.end();
});

test('HeartRateClient keeps discovering sensors that arrive after the setup budget', async t => {
  const noble = new FakeNoble();
  const client = createClient(noble);
  client.setupTimeoutMs = 5;
  await client.connect();
  await new Promise(resolve => setTimeout(resolve, 15));
  t.equal(client.isScanning, true, 'the GATT setup budget does not expire advertisement discovery');
  t.equal(noble.listenerCount('discover'), 1, 'late advertisements still have a listener');
  const peripheral = createPeripheral({characteristics: [createCharacteristic()]});
  noble.emit('discover', peripheral);
  await flush();
  t.equal(client.connected, true, 'a late sensor connects normally');
  await client.disconnect();
  t.end();
});

test('HeartRateClient shutdown during scan startup is an intentional cancellation', async t => {
  const noble = new FakeNoble();
  noble.startScanningAsync = () => new Promise(() => {});
  const client = createClient(noble);
  const starting = client.connect();
  await client.disconnect();
  await starting;
  t.equal(client.stopped, true, 'shutdown remains latched');
  t.equal(client.isScanning, false, 'a cancelled startup cannot revive scanning');
  t.equal(noble.listenerCount('discover'), 0, 'shutdown removes discovery listeners');
  t.equal(client.scanCoordinator.holderCount, 0, 'shutdown releases the scan owner');
  t.end();
});

test('HeartRateClient accepts a peripheral discovered before the scan-start callback', async t => {
  const noble = new FakeNoble();
  noble.startScanningAsync = () => {
    noble.scanning = true;
    return new Promise(() => {});
  };
  const client = createClient(noble);
  const starting = client.connect();
  const peripheral = createPeripheral({characteristics: [createCharacteristic()]});
  noble.emit('discover', peripheral);
  await starting;
  await flush();
  t.equal(client.connected, true, 'a real discovery can complete connection without the missing scan acknowledgement');
  t.equal(client.isScanning, false, 'connecting to a candidate ends scanning');
  t.equal(noble.scanning, false, 'the cancelled scan is stopped');
  t.equal(client.scanCoordinator.holderCount, 0, 'the connected client no longer holds discovery');
  await client.disconnect();
  t.end();
});

for (const failureMode of ['controller error', 'startup timeout']) {
  test(`HeartRateClient releases discovery after a scan ${failureMode}`, async t => {
    const noble = new FakeNoble();
    noble.startScanningAsync = failureMode === 'controller error'
      ? async () => { throw new Error('radio denied scan'); }
      : () => new Promise(() => {});
    const client = createClient(noble);
    client.scanCoordinator.startTimeoutMs = 5;
    let failure;
    await client.connect().catch(error => { failure = error; });
    t.ok(failure, 'the startup error reaches the caller');
    t.equal(client.isScanning, false, 'failed startup does not mark scanning active');
    t.equal(noble.listenerCount('discover'), 0, 'failed startup detaches discovery');
    t.equal(client.scanCoordinator.holderCount, 0, 'failed startup leaves no scan claim');
    noble.startScanningAsync = FakeNoble.prototype.startScanningAsync.bind(noble);
    await client.connect();
    t.equal(client.isScanning, true, 'a later explicit connect can retry');
    await client.disconnect();
    t.end();
  });
}
