import {EventEmitter} from 'events';
import {spawnSync} from 'child_process';

import test from '../support/tape.js';
import {GymnasticonServer} from '../../servers/ble/index.js';
import {MultiBleServer} from '../../servers/ble/multi-server.js';

const SHORT_TIMEOUT_MS = 20; // Small bound so the suite never waits on a wedged adapter.

test('an expired advertising command cannot revive an adapter after stop', async t => {
  const bleno = createFakeBleno();
  let complete;
  bleno.startAdvertising = (_name, _uuids, callback) => {
    complete = () => { bleno.advertising = true; callback(); };
  };
  const server = createServer(bleno);
  const multi = new MultiBleServer([{adapter: 'hci1', server}], createLogger());
  const error = await multi.start().then(() => null, failure => failure);
  t.ok(error, 'the controller command has a bounded wait');
  await multi.stop();
  complete();
  await new Promise(resolve => setImmediate(resolve));
  t.equal(bleno.advertising, false, 'late completion is stopped');
  t.equal(server.state, 'stopped', 'late completion does not restore the started state');
  t.end();
});

test('stopping an adapter while waiting for power cancels startup immediately', async t => {
  const bleno = createFakeBleno({state: 'poweredOff'});
  const server = createServer(bleno, {startupTimeoutMs: 10000});
  const pending = server.start().then(() => null, error => error);
  await server.stop();
  t.ok(await pending, 'startup rejects on stop without waiting ten seconds');
  bleno.state = 'poweredOn';
  bleno.emit('stateChange', 'poweredOn');
  t.equal(bleno.advertising, false, 'a later power event cannot advertise');
  t.equal(bleno.listenerCount('stateChange'), 0, 'the cancelled listener is gone');
  t.end();
});

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

test('retrying a stalled adapter preserves an already healthy mirror', async t => {
  const stalledBleno = createFakeBleno();
  stalledBleno.startAdvertising = () => {};
  const stalled = createServer(stalledBleno);
  const healthyBleno = createFakeBleno();
  const healthy = createServer(healthyBleno);
  let healthyStops = 0;
  const originalStop = healthyBleno.stopAdvertising;
  healthyBleno.stopAdvertising = callback => { healthyStops++; originalStop(callback); };
  const replacement = createServer(createFakeBleno());
  const entry = {adapter: 'hci0', server: stalled, createServer: async () => replacement};
  const multi = new MultiBleServer([entry, {adapter: 'hci1', server: healthy}], createLogger());
  await multi.start();
  t.equal(multi.degraded, true, 'the healthy mirror remains available after the other adapter stalls');
  await multi.start();
  t.equal(entry.server, replacement, 'retry replaces the stalled server');
  t.equal(stalled.retired, true, 'the abandoned binding cannot be reused');
  t.equal(healthyStops, 0, 'repair never stops the healthy mirror');
  t.equal(healthy.state, 'started', 'the healthy output remains started');
  t.equal(multi.degraded, false, 'both outputs are available after repair');
  await multi.stop();
  t.end();
});

test('a retired binding can reopen after a factory failure and late old completion', async t => {
  const oldBleno = createFakeBleno();
  let oldComplete;
  oldBleno.startAdvertising = (_name, _uuids, callback) => { oldComplete = callback; };
  const old = createServer(oldBleno);
  const replacement = createServer(createFakeBleno());
  let opens = 0;
  const entry = {adapter: 'hci0', server: old, createServer: async () => {
    if (++opens === 1) throw new Error('adapter temporarily unavailable');
    return replacement;
  }};
  const multi = new MultiBleServer([entry], createLogger());
  try {
    t.ok(await multi.start().then(() => null, error => error), 'the original command times out');
    t.ok(await multi.start().then(() => null, error => error), 'the first replacement attempt can fail');
    oldComplete(null);
    await new Promise(resolve => setImmediate(resolve));
    t.equal(old.pendingStartOperation, null, 'the old controller eventually finishes its command');
    t.equal(old.retired, true, 'late completion cannot make the old binding reusable');
    await multi.start();
    t.equal(opens, 2, 'the next retry opens another binding instead of starting the retired one');
    t.equal(entry.server, replacement, 'the later replacement owns the adapter');
    t.equal(replacement.state, 'started', 'advertising recovers after the transient factory failure');
  } finally {
    await multi.stop();
  }
  t.end();
});

test('shutdown retires a replacement that finishes opening after cancellation', async t => {
  const old = createServer(createFakeBleno());
  old.pendingStartOperation = new Promise(() => {});
  let finishOpen;
  const entry = {adapter: 'hci0', server: old,
    createServer: () => new Promise(resolve => { finishOpen = resolve; })};
  const multi = new MultiBleServer([entry], createLogger());
  const starting = multi.start().then(() => null, error => error);
  await multi.stop();
  const replacementBleno = createFakeBleno();
  const replacement = createServer(replacementBleno);
  finishOpen(replacement);
  t.ok(await starting, 'the cancelled startup rejects');
  t.equal(replacement.retired, true, 'a late factory result releases its binding');
  t.equal(replacementBleno.advertising, false, 'the late replacement never advertises');
  t.equal(entry.server, old, 'the cancelled replacement cannot change the current entry');
  t.equal(multi.activeEntries, null, 'shutdown cannot be revived by a late factory');
  t.end();
});

test('a replacement factory has the same bounded lifetime as adapter startup', async t => {
  const old = createServer(createFakeBleno());
  old.pendingStartOperation = new Promise(() => {});
  let finishOpen;
  const entry = {adapter: 'hci0', server: old,
    createServer: () => new Promise(resolve => { finishOpen = resolve; })};
  const multi = new MultiBleServer([entry], createLogger(), {startupTimeoutMs: SHORT_TIMEOUT_MS});
  const failure = await multi.start().then(() => null, error => error);
  t.ok(failure, 'an unresponsive factory cannot hang startup');
  const replacement = createServer(createFakeBleno());
  finishOpen(replacement);
  await new Promise(resolve => setImmediate(resolve));
  t.equal(replacement.retired, true, 'a factory result past the deadline releases its binding');
  t.equal(entry.server, old, 'the expired factory cannot install a replacement');
  t.equal(multi.activeEntries, null, 'the expired attempt never publishes an active output');
  await multi.stop();
  t.end();
});

test('actual App retries a never-completing first-adapter command using a fresh pinned bleno binding', t => {
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    encoding: 'utf8', timeout: 10000,
    input: String.raw`
import assert from 'assert';
import {createRequire} from 'module';
import {EventEmitter} from 'events';
import path from 'path';
const require = createRequire(path.join(process.cwd(), 'package.json'));
let rawCount = 0;
class Socket extends EventEmitter {
  constructor() { super(); this.writes = []; this.stops = 0; }
  bindRaw(id) { this.id = id; this.rawNumber = ++rawCount; return id; }
  bindControl() { return 0; }
  start() {} stop() { this.stops++; } isDevUp() { return true; } setFilter() {}
  write(buffer) {
    this.writes.push(Buffer.from(buffer));
    if (!this.rawNumber || buffer[0] !== 1) return;
    const opcode = buffer.readUInt16LE(1);
    const complete = result => {
      const params = Buffer.from([1, opcode & 255, opcode >> 8, 0, ...result]);
      setImmediate(() => this.emit('data', Buffer.concat([Buffer.from([4, 14, params.length]), params])));
    };
    if (opcode === 0x1001) complete([7, 0, 0, 7, 15, 0, 0, 0]);
    else if (opcode === 0x1009) complete([6, 5, 4, 3, 2, 1]);
    else if (opcode === 0x2006) complete([]);
    else if (opcode === 0x200a && (buffer[4] === 0 || this.rawNumber > 1)) complete([]);
  }
}
const native = require.resolve('@abandonware/bluetooth-hci-socket');
require.cache[native] = {id: native, filename: native, loaded: true, exports: Socket};
const {App} = await import('./src/app/app.js');
const noble = new EventEmitter(); noble.state = 'poweredOn';
const app = new App({noble, antEnabled: false, heartRateEnabled: false,
  bike: 'bot', bikeAdapter: 'hci0', serverAdapter: 'hci1', serverAdapters: ['hci1'],
  healthMonitor: {on() {}, stop() {}}, speedSensorEnabled: false, cadenceSensorEnabled: false});
app.logger = {log() {}, warn() {}, error() {}};
try {
  await app.initializeBleServers();
  const entry = app.server.entries[0];
  const old = entry.server;
  old.startupTimeoutMs = 100;
  app.server.startupTimeoutMs = 100;
  await assert.rejects(app.ensureServerStarted('first'), /No BLE adapters/);
  assert.ok(old.pendingStartOperation);
  await app.ensureServerStarted('retry');
  const replacement = entry.server;
  assert.notStrictEqual(replacement, old);
  assert.notStrictEqual(replacement.bleno, old.bleno);
  assert.notStrictEqual(replacement.bleno._bindings, old.bleno._bindings);
  assert.strictEqual(replacement.bleno._bindings._hci._socket.id, 1);
  assert.strictEqual(replacement.state, 'started');
  assert.strictEqual(old.retired, true);
  assert.strictEqual(old.bleno.__gymnasticonStopped, true);
  const oldSocket = old.bleno._bindings._hci._socket;
  const oldWrites = oldSocket.writes.length;
  old.bleno.emit('advertisingStart', null);
  old.bleno.emit('servicesSet', null);
  old.bleno.emit('accept', '11:22:33:44:55:66');
  old.bleno.emit('disconnect', '11:22:33:44:55:66');
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(oldSocket.writes.length, oldWrites, 'old callbacks cannot stop the successor radio');
  assert.strictEqual(old.connectionCount, 0);
  assert.strictEqual(old.state, 'stopped');
  assert.strictEqual(replacement.state, 'started');
  assert.strictEqual(app.serverStarted, true);
  await app.stop();
  await app.stop();
  assert.strictEqual(oldSocket.stops, 1, 'retirement stays idempotent through App.stop');
  assert.strictEqual(replacement.bleno._bindings._hci._socket.stops, 1);
} finally {
  await app.cleanup();
}
`,
  });
  t.equal(result.status, 0, result.stderr || result.stdout || 'actual App and pinned bleno recovery passed');
  t.end();
});
