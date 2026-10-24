import {EventEmitter} from 'events';

import test from '../support/tape.js';
import {initializeBluetooth} from '../../util/noble-wrapper.js';

/**
 * Build a noble stand-in whose HCI init binds lazily, exactly like the pinned
 * @abandonware/noble: Hci.prototype.init() reads NOBLE_HCI_DEVICE_ID and calls
 * _socket.bindRaw(deviceId) long after the module was required.
 *
 * @param {number[]} bindRawCalls - collects the device ids handed to bindRaw().
 */
function createFakeStack(bindRawCalls) {
  const hci = {
    _socket: {
      bindRaw(deviceId) {
        bindRawCalls.push(deviceId === undefined ? null : deviceId);
      },
    },
    init() {
      const raw = process.env.NOBLE_HCI_DEVICE_ID;
      const deviceId = raw ? parseInt(raw, 10) : undefined;
      this._socket.bindRaw(deviceId);
    },
  };

  const bindings = new EventEmitter();
  bindings._hci = hci;

  const noble = new EventEmitter();
  noble.state = 'poweredOn';
  noble._bindings = bindings;
  noble.startScanningAsync = async () => {};
  noble.stopScanningAsync = async () => {};
  noble.stopScanning = () => {};
  return noble;
}

test('initializeBluetooth() binds each noble instance to its own adapter', async (t) => {
  const bindRawCalls = [];
  const bikeNoble = createFakeStack(bindRawCalls);
  const heartRateNoble = createFakeStack(bindRawCalls);

  // Previously both instances bound adapter 0 because the env var was already
  // restored by the time noble actually read it.
  await initializeBluetooth('hci0', {loadModule: () => bikeNoble});
  bikeNoble._bindings._hci.init();
  await initializeBluetooth('hci1', {loadModule: () => heartRateNoble, forceNewInstance: true});
  heartRateNoble._bindings._hci.init();

  t.deepEqual(bindRawCalls, [0, 1], 'bindRaw() receives [0, 1] for hci0 and hci1');
  t.end();
});

test('initializeBluetooth() stashes the adapter on the instance and restores the env', async (t) => {
  const previous = process.env.NOBLE_HCI_DEVICE_ID;
  delete process.env.NOBLE_HCI_DEVICE_ID;

  const bindRawCalls = [];
  const noble = createFakeStack(bindRawCalls);
  await initializeBluetooth('hci1', {loadModule: () => noble});

  t.equal(noble.__gymnasticonAdapterId, '1', 'adapter id is stored on the noble instance');
  t.equal(process.env.NOBLE_HCI_DEVICE_ID, undefined, 'the env override is restored once loading finishes');

  noble._bindings._hci.init();
  t.deepEqual(bindRawCalls, [1], 'the bind uses the stashed adapter');
  t.equal(process.env.NOBLE_HCI_DEVICE_ID, undefined, 'the env override is restored after the bind');

  if (previous !== undefined) {
    process.env.NOBLE_HCI_DEVICE_ID = previous;
  }
  t.end();
});

test('initializeBluetooth() keeps the existing noble patches installed', async (t) => {
  const noble = createFakeStack([]);
  const {noble: patched} = await initializeBluetooth('hci0', {loadModule: () => noble});

  t.equal(patched, noble, 'returns the module instance');
  t.ok(patched.__gymnasticonMtuPatched, 'MTU patch installed');
  t.ok(patched.__gymnasticonHciInitPatched, 'HCI init race patch installed');
  t.ok(patched.__gymnasticonUnknownStateScanPatched, 'unknown-state scan patch installed');
  t.equal(typeof patched.startScanningAsync, 'function', 'scan patch keeps the noble API');
  t.end();
});

test('initializeBluetooth() still suppresses HCI bind race errors', async (t) => {
  // Other suites legitimately leave an adapter override in the environment, so
  // assert restoration against the ambient value instead of assuming it is unset.
  const previous = process.env.NOBLE_HCI_DEVICE_ID;

  const noble = createFakeStack([]);
  noble._bindings._hci.init = () => {
    const error = new Error('bind: Operation already in progress');
    error.code = 'EALREADY';
    throw error;
  };

  const {noble: patched} = await initializeBluetooth('hci0', {loadModule: () => noble});

  t.doesNotThrow(() => patched._bindings._hci.init(), 'bind races do not crash the wrapper');
  t.equal(process.env.NOBLE_HCI_DEVICE_ID, previous, 'the adapter env override is restored even on failure');
  t.end();
});
