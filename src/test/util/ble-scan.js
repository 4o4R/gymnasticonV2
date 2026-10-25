import {EventEmitter} from 'events';

import test from '../support/tape.js';
import {createFilter, createNameFilter, createAddressFilter, scan} from '../../util/ble-scan.js';

// peripherals
const match = {address: '11-11-11-11-11-11', advertisement: { localName: 'Match'}};
const other = {address: '00-00-00-00-00-00', advertisement: { localName: 'Other'}};
const empty = {};

test('createFilter()', t => {
  t.plan(4);
  const allMatch = createFilter({ name: 'Match', address: '11-11-11-11-11-11' });
  const addressMatches = createFilter({ name: 'Natch', address: '11-11-11-11-11-11' });
  const nameMatches = createFilter({ name: 'Match', address: '11-11-11-11-11-10' });
  const noneMatch = createFilter({ name: 'Natch', address: '11-11-11-11-11-10' });
  t.ok(allMatch(match), 'true when all match');
  t.notOk(addressMatches(match), 'false when only address matches');
  t.notOk(nameMatches(match), 'false when only name matches');
  t.notOk(noneMatch(match), 'false when none match');
});

test('createNameFilter()', t => {
  t.plan(3);
  const filter = createNameFilter('Match');
  t.ok(filter(match), 'true when name matches');
  t.notOk(filter(other), 'false when name does not match');
  t.notOk(filter(empty), 'false when name given but peripheral name is missing');
});

test('createAddressFilter()', t => {
  t.plan(3);
  const filter = createAddressFilter('11-11-11-11-11-11');
  t.ok(filter(match), 'true when address matches');
  t.notOk(filter(other), 'false when address does not match');
  t.notOk(filter(empty), 'false when address given but peripheral address is missing');
});

test('scan() stops and returns null on timeout', async (t) => {
  const noble = new EventEmitter();
  let startCalls = 0;
  let stopCalls = 0;
  noble.startScanningAsync = async () => {
    startCalls += 1;
  };
  noble.stopScanningAsync = async () => {
    stopCalls += 1;
  };

  const result = await scan(noble, ['181a'], () => false, {
    timeoutMs: 1,
    stopScanOnTimeout: true,
  });

  t.equal(result, null, 'returns null when the noble scan times out');
  t.equal(startCalls, 1, 'starts a noble scan');
  t.equal(stopCalls, 1, 'stops the noble scan on timeout');
  t.end();
});

test('scan() preserves noble startup failures', async t => {
  const noble = new EventEmitter();
  noble.startScanningAsync = async () => {
    throw new Error('scan-start-failed');
  };

  try {
    await scan(noble, [], () => false, {timeoutMs: 1});
    t.fail('scan should reject');
  } catch (error) {
    t.equal(error.message, 'scan-start-failed', 'caller can reinitialize the failed noble adapter');
  }
  t.end();
});

test('scan() reports every discovered peripheral via onDiscovery', async (t) => {
  const noble = new EventEmitter();
  noble.startScanningAsync = async () => {};
  noble.stopScanningAsync = async () => {};

  const discovered = [];
  const pending = scan(noble, [], (p) => p.advertisement.localName === 'Target', {
    timeoutMs: 50,
    onDiscovery: (p) => discovered.push(p.advertisement.localName),
  });

  // Defer the discoveries a tick so scan() has attached its listener after
  // the async startScanningAsync() call.
  setTimeout(() => {
    noble.emit('discover', {advertisement: {localName: 'Other1'}});
    noble.emit('discover', {advertisement: {localName: 'Other2'}});
    noble.emit('discover', {advertisement: {localName: 'Target'}});
  }, 0);

  const result = await pending;
  t.equal(result.advertisement.localName, 'Target', 'returns the first matching peripheral');
  t.deepEqual(discovered, ['Other1', 'Other2', 'Target'], 'reports matched and unmatched discoveries in order');
  t.end();
});

test('scan() resolves on timeout even when stopScanningAsync never settles', async (t) => {
  // Regression for issue #10 follow-up: on some Pi/BlueZ combos noble.state
  // stays "unknown" and stopScanningAsync() waits forever for a scanStop event,
  // which wedged autodetect (no "No supported bike found" log, no fallback) and
  // the app's shutdown path. The result must not wait on the stop.
  const noble = new EventEmitter();
  noble.startScanningAsync = async () => {};
  noble.stopScanningAsync = () => new Promise(() => {}); // never settles

  const result = await scan(noble, [], () => false, {
    timeoutMs: 5,
    stopScanOnTimeout: true,
  });

  t.equal(result, null, 'returns null on timeout without waiting for stopScanningAsync');
  t.end();
});

test('scan() resolves on match even when stopScanningAsync never settles', async (t) => {
  const noble = new EventEmitter();
  noble.startScanningAsync = async () => {};
  noble.stopScanningAsync = () => new Promise(() => {}); // never settles

  const pending = scan(noble, [], (p) => p.advertisement.localName === 'Target', {
    timeoutMs: 50,
    stopScanOnMatch: true,
  });

  setTimeout(() => {
    noble.emit('discover', {advertisement: {localName: 'Target'}});
  }, 0);

  const result = await pending;
  t.equal(result.advertisement.localName, 'Target', 'resolves with the match without waiting for stopScanningAsync');
  t.end();
});

test('scan() resolves on timeout when noble scan startup never settles', async (t) => {
  // Regression: the pinned noble silently swallows some controller failures
  // (e.g. "Command Disallowed"), leaving startScanningAsync() pending forever.
  // The discovery deadline used to be armed only after startup resolved, so
  // autodetection hung with no watchdog.
  const noble = new EventEmitter();
  let stopCalls = 0;
  noble.startScanningAsync = () => new Promise(() => {}); // never settles
  noble.stopScanning = () => {
    stopCalls += 1;
  };
  noble.stopScanningAsync = async () => {
    stopCalls += 1;
  };

  const startedAt = Date.now();
  const result = await scan(noble, [], () => false, {timeoutMs: 50, stopScanOnTimeout: true});
  const elapsed = Date.now() - startedAt;

  t.equal(result, null, 'returns null when the scan never starts');
  t.ok(elapsed < 1000, `settled promptly instead of hanging (${elapsed}ms)`);
  t.equal(noble.listenerCount('discover'), 0, 'removes the discovery listener');
  t.equal(stopCalls, 1, 'cancels the pending controller operation at the deadline');
  t.end();
});

test('scan() stops a scan that only starts after the timeout already fired', async (t) => {
  const noble = new EventEmitter();
  let finishStartup;
  noble.startScanningAsync = () => new Promise((resolve) => {
    finishStartup = resolve;
  });
  let stopCalls = 0;
  noble.stopScanning = () => {
    stopCalls += 1;
  };

  const result = await scan(noble, [], () => false, {timeoutMs: 10, stopScanOnTimeout: true});
  t.equal(result, null, 'times out while startup is pending');
  t.equal(stopCalls, 1, 'cancels the pending start before another scan can take ownership');

  finishStartup();
  await new Promise((resolve) => setTimeout(resolve, 10));

  t.equal(stopCalls, 1, 'late completion cannot stop a successor scan');
  t.end();
});

test('scan() reuses an already running noble scan without stopping it', async (t) => {
  const noble = new EventEmitter();
  noble.startScanningAsync = async () => {
    throw new Error('Could not start scanning, already scanning');
  };
  let stopCalls = 0;
  noble.stopScanning = () => {
    stopCalls += 1;
  };

  const pending = scan(noble, [], (p) => p.advertisement.localName === 'Target', {
    timeoutMs: 100,
    stopScanOnMatch: true,
  });
  setTimeout(() => noble.emit('discover', {advertisement: {localName: 'Target'}}), 5);

  const result = await pending;
  t.equal(result.advertisement.localName, 'Target', 'discoveries still resolve the scan');
  t.equal(stopCalls, 0, 'never stops a scan owned by somebody else');
  t.end();
});
