import {EventEmitter} from 'events';

import test from '../support/tape.js';
import {ScanCoordinator, createScanTag, waitForPeripheral} from '../../util/scan-coordinator.js';

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

