import {EventEmitter} from 'events';

import test from '../support/tape.js';
import {GymnasticonServer} from '../../servers/ble/index.js';
import {MultiBleServer} from '../../servers/ble/multi-server.js';

const SHORT_TIMEOUT_MS = 20; // Small bound so the suite never waits on a wedged adapter.

function createFakeBleno({state = 'poweredOn'} = {}) { // Minimal bleno double: only what BleServer/GymnasticonServer call.
  const bleno = new EventEmitter();
  bleno.state = state;
  bleno.advertising = false;
  bleno.startAdvertising = (name, uuids, callback) => {
    bleno.advertising = true;
    callback(null);
  };
  bleno.startAdvertisingWithEIRData = (advertisementData, scanData, callback) => {
    bleno.advertising = true;
    callback(null);
  };
  bleno.setServices = (services, callback) => callback(null);
  bleno.stopAdvertising = callback => {
    bleno.advertising = false;
    callback(null);
  };
  bleno.disconnect = () => {};
  return bleno;
}

function createServer(bleno, options = {}) {
  return new GymnasticonServer(bleno, 'gym-test', {
    includeHeartRate: false,
    startupTimeoutMs: SHORT_TIMEOUT_MS,
    ...options,
  });
}

function createLogger() {
  const entries = {log: [], warn: [], error: []};
  return {
    entries,
    log: message => entries.log.push(String(message)),
    warn: message => entries.warn.push(String(message)),
    error: message => entries.error.push(String(message)),
  };
}

test('GymnasticonServer.start() rejects within the startup bound when the adapter never powers on', async t => {
  t.timeoutAfter(5000);
  const bleno = createFakeBleno({state: 'poweredOff'});
  const server = createServer(bleno, {adapter: 'hci3'});

  const startedAt = Date.now();
  let error = null;
  try {
    await server.start();
  } catch (err) {
    error = err;
  }

  t.ok(error, 'start() rejects instead of hanging');
  t.equal(error && error.code, 'BLE_STARTUP_TIMEOUT', 'reports a startup timeout');
  t.ok(/hci3/.test(error.message), 'names the adapter that failed');
  t.ok(/poweredOn/.test(error.message), 'names the state it waited for');
  t.ok(/poweredOff/.test(error.message), 'reports the last observed state');
  t.ok(/20ms/.test(error.message), 'reports the configured bound');
  t.equal(server.state, 'stopped', 'restores the stopped state');
  t.equal(bleno.listenerCount('stateChange'), 0, 'removes the pending stateChange listener');
  t.ok(Date.now() - startedAt < 4000, 'resolves close to the bound rather than hanging');
  t.end();
});

test('GymnasticonServer.start() still fails fast on a terminal adapter state', async t => {
  t.timeoutAfter(5000);
  const bleno = createFakeBleno({state: 'unauthorized'});
  const server = createServer(bleno, {adapter: 'hci9'});

  let error = null;
  try {
    await server.start();
  } catch (err) {
    error = err;
  }

  t.ok(error, 'start() rejects');
  t.ok(/failed to power on: unauthorized/.test(error.message), 'keeps the original terminal-state message');
  t.ok(/hci9/.test(error.message), 'names the adapter');
  t.equal(server.state, 'stopped', 'restores the stopped state');
  t.end();
});

test('GymnasticonServer.start() advertises when the adapter powers on in time', async t => {
  t.timeoutAfter(5000);
  const bleno = createFakeBleno({state: 'poweredOff'});
  const server = createServer(bleno, {adapter: 'hci0'});

  const pending = server.start();
  setImmediate(() => {
    bleno.state = 'poweredOn';
    bleno.emit('stateChange', 'poweredOn');
  });

  await pending;
  t.equal(server.state, 'started', 'reaches the started state');
  t.ok(bleno.advertising, 'starts advertising');
  t.end();
});

test('MultiBleServer.start() keeps advertising on healthy adapters in degraded mode', async t => {
  t.timeoutAfter(5000);
  const healthyBleno = createFakeBleno({state: 'poweredOn'});
  const stuckBleno = createFakeBleno({state: 'poweredOff'});
  const healthy = createServer(healthyBleno, {adapter: 'hci0'});
  const stuck = createServer(stuckBleno, {adapter: 'hci1'});
  const logger = createLogger();
  const multi = new MultiBleServer(
    [{adapter: 'hci0', server: healthy}, {adapter: 'hci1', server: stuck}],
    logger
  );

  const startedAt = Date.now();
  await multi.start();

  t.ok(Date.now() - startedAt < 4000, 'does not wait on the wedged adapter');
  t.deepEqual(multi.activeEntries.map(entry => entry.adapter), ['hci0'], 'keeps only the healthy adapter active');
  t.deepEqual(multi.listAdapters(), ['hci0'], 'lists the active adapter');
  t.equal(multi.degraded, true, 'reports degraded operation');
  t.deepEqual(multi.failedAdapters, ['hci1'], 'records the failed adapter');
  t.equal(stuck.state, 'stopped', 'leaves the wedged server stopped for a later retry');
  t.equal(logger.entries.error.length, 1, 'logs the adapter failure');
  t.equal(logger.entries.warn.length, 1, 'logs a degraded-mode warning');
  t.ok(/DEGRADED/.test(logger.entries.warn[0]), 'the warning is explicit');
  t.ok(/hci1/.test(logger.entries.warn[0]), 'the warning lists the failed adapter');

  await multi.stop();
  t.equal(multi.degraded, false, 'clears degraded mode after stopping');
  t.end();
});

test('MultiBleServer.start() rejects when no adapter can advertise', async t => {
  t.timeoutAfter(5000);
  const first = createServer(createFakeBleno({state: 'poweredOff'}), {adapter: 'hci0'});
  const second = createServer(createFakeBleno({state: 'poweredOff'}), {adapter: 'hci1'});
  const logger = createLogger();
  const multi = new MultiBleServer(
    [{adapter: 'hci0', server: first}, {adapter: 'hci1', server: second}],
    logger
  );

  let error = null;
  try {
    await multi.start();
  } catch (err) {
    error = err;
  }

  t.ok(error, 'start() rejects');
  t.ok(/No BLE adapters available for advertising/.test(error.message), 'keeps the well-known failure message');
  t.ok(/hci0, hci1/.test(error.message), 'lists the failed adapters');
  t.equal(multi.activeEntries, null, 'leaves no active entries behind');
  t.equal(multi.degraded, false, 'is not marked degraded when nothing started');
  t.end();
});

test('MultiBleServer.start() bounds adapters that never settle', async t => {
  t.timeoutAfter(5000);
  const logger = createLogger();
  const hanging = {
    start: () => new Promise(() => {}),
    stop: async () => {},
  };
  const multi = new MultiBleServer([{adapter: 'hci7', server: hanging}], logger, {startupTimeoutMs: SHORT_TIMEOUT_MS});

  const startedAt = Date.now();
  let error = null;
  try {
    await multi.start();
  } catch (err) {
    error = err;
  }

  t.ok(error, 'start() rejects');
  t.ok(/No BLE adapters available for advertising/.test(error.message), 'reports that nothing could advertise');
  t.ok(/hci7/.test(error.message), 'names the stuck adapter');
  t.equal(logger.entries.error.length, 1, 'logs the per-adapter failure');
  t.ok(/did not finish starting within/.test(logger.entries.error[0]), 'reports the bounded startup timeout');
  t.ok(Date.now() - startedAt < 4000, 'rejects within the bound');
  t.end();
});

test('MultiBleServer.start() does not degrade when every adapter starts', async t => {
  t.timeoutAfter(5000);
  const first = createServer(createFakeBleno({state: 'poweredOn'}), {adapter: 'hci0'});
  const second = createServer(createFakeBleno({state: 'poweredOn'}), {adapter: 'hci1'});
  const logger = createLogger();
  const multi = new MultiBleServer(
    [{adapter: 'hci0', server: first}, {adapter: 'hci1', server: second}],
    logger
  );

  await multi.start();
  t.deepEqual(multi.activeEntries.map(entry => entry.adapter), ['hci0', 'hci1'], 'keeps every adapter active');
  t.equal(multi.degraded, false, 'stays out of degraded mode');
  t.equal(logger.entries.warn.length, 0, 'does not warn');
  await multi.stop();
  t.end();
});
