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
