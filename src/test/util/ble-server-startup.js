import {EventEmitter} from 'events';

import test from '../support/tape.js';
import {BleServer} from '../../util/ble-server.js';
import {DEFAULT_STARTUP_TIMEOUT_MS, resolveStartupTimeout, waitForPoweredOn} from '../../util/ble-startup.js';

const SHORT_TIMEOUT_MS = 20; // Small bound so the suite never waits on a wedged adapter.

function createFakeBleno({state = 'poweredOn'} = {}) { // Minimal bleno double: only what BleServer calls.
  const bleno = new EventEmitter();
  bleno.state = state;
  bleno.advertising = false;
  bleno.startAdvertising = (name, uuids, callback) => {
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
  return new BleServer(bleno, 'ble-test', [], {startupTimeoutMs: SHORT_TIMEOUT_MS, ...options});
}

async function captureError(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

test('BleServer.start() rejects within the startup bound when the adapter never powers on', async t => {
  t.timeoutAfter(5000);
  const bleno = createFakeBleno({state: 'poweredOff'});
  const server = createServer(bleno, {adapter: 'hci4'});
  server.connectionCount = 2; // Prove a failed startup drops stale connection tracking.

  const startedAt = Date.now();
  const error = await captureError(server.start());

  t.ok(error, 'start() rejects instead of hanging');
  t.equal(error && error.code, 'BLE_STARTUP_TIMEOUT', 'reports a startup timeout');
  t.equal(error && error.adapter, 'hci4', 'records the failing adapter on the error');
  t.equal(error && error.state, 'poweredOff', 'records the last observed state on the error');
  t.ok(/hci4/.test(error.message), 'names the adapter that failed');
  t.ok(/poweredOn/.test(error.message), 'names the state it waited for');
  t.ok(/20ms/.test(error.message), 'reports the configured bound');
  t.equal(server.state, 'stopped', 'restores the stopped state');
  t.equal(server.connectionCount, 0, 'resets connection tracking');
  t.equal(bleno.listenerCount('stateChange'), 0, 'removes the pending stateChange listener');
  t.equal(bleno.advertising, false, 'never starts advertising');
  t.ok(Date.now() - startedAt < 4000, 'rejects close to the bound rather than hanging');
  t.end();
});

test('BleServer.start() fails fast on a terminal adapter state', async t => {
  t.timeoutAfter(5000);
  const bleno = createFakeBleno({state: 'unsupported'});
  const server = createServer(bleno, {adapter: 'hci9', startupTimeoutMs: 5000});

  const startedAt = Date.now();
  const error = await captureError(server.start());

  t.ok(error, 'start() rejects');
  t.ok(/failed to power on: unsupported/.test(error.message), 'rejects on the terminal state');
  t.ok(/hci9/.test(error.message), 'names the adapter');
  t.notEqual(error && error.code, 'BLE_STARTUP_TIMEOUT', 'is not reported as a timeout');
  t.ok(Date.now() - startedAt < 1000, 'does not wait for the bound');
  t.equal(server.state, 'stopped', 'restores the stopped state');
  t.equal(bleno.listenerCount('stateChange'), 0, 'removes the stateChange listener');
  t.end();
});

test('BleServer.start() advertises when the adapter is already powered on', async t => {
  t.timeoutAfter(5000);
  const bleno = createFakeBleno({state: 'poweredOn'});
  const server = createServer(bleno);

  await server.start();

  t.equal(server.state, 'started', 'reaches the started state');
  t.equal(server.startupTimeoutMs, SHORT_TIMEOUT_MS, 'keeps the configured bound');
  t.ok(bleno.advertising, 'starts advertising');
  t.equal(bleno.listenerCount('stateChange'), 1, 'keeps one runtime radio-state monitor');
  await server.stop();
  t.equal(bleno.listenerCount('stateChange'), 0, 'removes the runtime monitor on stop');
  await server.stop();
  t.end();
});

test('BleServer.start() waits through a transient powered-off state', async t => {
  t.timeoutAfter(5000);
  const bleno = createFakeBleno({state: 'poweredOff'});
  const server = createServer(bleno, {adapter: 'hci1'});

  const pending = server.start();
  setImmediate(() => {
    bleno.emit('stateChange', 'resetting');
    bleno.state = 'poweredOn';
    bleno.emit('stateChange', 'poweredOn');
  });

  await pending;

  t.equal(server.state, 'started', 'starts once the adapter powers on');
  t.ok(bleno.advertising, 'starts advertising after the wait');
  t.equal(bleno.listenerCount('stateChange'), 1, 'replaces the startup wait with one runtime monitor');
  await server.stop();
  t.equal(bleno.listenerCount('stateChange'), 0, 'the runtime monitor does not leak after stopping');
  await server.stop();
  t.end();
});

test('waitForPoweredOn() removes its listener exactly once and cannot double-settle', async t => {
  t.timeoutAfter(5000);
  const bleno = createFakeBleno({state: 'poweredOff'});
  const pending = waitForPoweredOn(bleno, {timeoutMs: SHORT_TIMEOUT_MS, adapterName: 'hci2'});

  t.equal(bleno.listenerCount('stateChange'), 1, 'listens while it waits');
  const error = await captureError(pending);

  t.ok(error, 'the bounded wait rejects');
  t.equal(bleno.listenerCount('stateChange'), 0, 'listener is gone after the timeout');
  bleno.emit('stateChange', 'poweredOn'); // A late event must not resurrect the wait.
  t.equal(bleno.listenerCount('stateChange'), 0, 'stays detached after a late state change');
  t.end();
});

test('waitForPoweredOn() tolerates a bleno without a state value', async t => {
  t.timeoutAfter(5000);
  const bleno = createFakeBleno();
  delete bleno.state;

  const pending = waitForPoweredOn(bleno, {timeoutMs: SHORT_TIMEOUT_MS});
  bleno.state = 'poweredOn';
  bleno.emit('stateChange', 'poweredOn');

  await pending;
  t.equal(bleno.listenerCount('stateChange'), 0, 'settles and detaches');
  t.end();
});

test('resolveStartupTimeout() only accepts finite positive numbers', t => {
  t.equal(resolveStartupTimeout(250), 250, 'keeps a usable override');
  t.equal(resolveStartupTimeout(0), DEFAULT_STARTUP_TIMEOUT_MS, 'rejects a zero bound');
  t.equal(resolveStartupTimeout(-5), DEFAULT_STARTUP_TIMEOUT_MS, 'rejects a negative bound');
  t.equal(resolveStartupTimeout(Number.POSITIVE_INFINITY), DEFAULT_STARTUP_TIMEOUT_MS, 'rejects an infinite bound');
  t.equal(resolveStartupTimeout(Number.NaN), DEFAULT_STARTUP_TIMEOUT_MS, 'rejects NaN');
  t.equal(resolveStartupTimeout('250'), DEFAULT_STARTUP_TIMEOUT_MS, 'rejects a string');
  t.equal(resolveStartupTimeout(undefined), DEFAULT_STARTUP_TIMEOUT_MS, 'falls back to the default');
  t.end();
});
