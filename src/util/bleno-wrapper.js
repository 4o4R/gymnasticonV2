import {EventEmitter} from 'events';
import {createRequire} from 'module';
import path from 'path';
import {loadDependency, toDefaultExport} from './optional-deps.js';
import {normalizeAdapterId} from './adapter-id.js';
import {captureBluetoothInitialization, stopBluetoothStack} from './bluetooth-shutdown.js';

const requireFromWrapper = createRequire(import.meta.url);
const BLENO_REQUEST = '@abandonware/bleno';

function clearDependencyCache(request) {
  const entryPath = requireFromWrapper.resolve(request);
  const packageRoot = path.dirname(requireFromWrapper.resolve(`${request}/package.json`));
  const packagePrefix = `${packageRoot}${path.sep}`;

  for (const cachedPath of Object.keys(requireFromWrapper.cache)) {
    if (cachedPath === entryPath || cachedPath.startsWith(packagePrefix)) {
      delete requireFromWrapper.cache[cachedPath];
    }
  }
}

function guardSharedAdapter(bleno) {
  const bindings = bleno._bindings;
  if (!bindings || bleno.__gymnasticonAdvertising) return;
  const gap = bindings._gap;
  const hci = bindings._hci;
  const health = {restartAt: null, error: null};
  bleno.__gymnasticonAdvertising = health;

  // Raw HCI sockets also see central-role bike/accessory disconnects. Bleno
  // must only end the GATT stream belonging to its accepted watch/app.
  const disconnectComplete = bindings.onDisconnComplete;
  bindings.onDisconnComplete = function(handle, reason) {
    if (this._handle === null || this._handle !== handle) return;
    return disconnectComplete.call(this, handle, reason);
  };

  const restart = gap.restartAdvertising;
  const stop = gap.stopAdvertising;
  let onComplete;
  const cancelRestart = () => {
    if (!onComplete) return;
    hci.removeListener('leAdvertiseEnableSet', onComplete);
    onComplete = null;
    health.restartAt = null;
    health.error = health.error || new Error('Advertising restart ended without a controller acknowledgement');
  };
  gap.restartAdvertising = function() {
    cancelRestart();
    health.restartAt = Date.now();
    onComplete = status => {
      onComplete = null;
      health.restartAt = null;
      health.error = status ? new Error(`Advertising restart failed (HCI status ${status})`) : null;
      // The pinned GAP implementation ignores acknowledgements in restarting.
      this._advertiseState = status ? 'stopped' : 'started';
    };
    hci.once('leAdvertiseEnableSet', onComplete);
    try {
      return restart.call(this);
    } catch (error) {
      cancelRestart();
      health.error = error;
    }
  };
  gap.stopAdvertising = function() {
    cancelRestart();
    return stop.call(this);
  };
}

export const initializeBleno = async (adapter = 'hci0', options = {}) => {
  const {forceNewInstance = false} = options;
  const previousAdapter = process.env.BLENO_HCI_DEVICE_ID;
  const adapterId = normalizeAdapterId(adapter);
  if (adapterId !== undefined) {
    process.env.BLENO_HCI_DEVICE_ID = adapterId;
  }

  if (forceNewInstance) {
    try {
      // Bleno keeps its binding and HCI socket in internal cached modules. A
      // second entry-point object is not enough; clear the package subtree so
      // each advertised adapter receives an independent low-level binding.
      clearDependencyCache(BLENO_REQUEST);
    } catch (_error) {
      // Module may not be installed yet; skip cache cleanup in that case.
    }
  }

  const blenoModule = loadDependency(BLENO_REQUEST, '../stubs/bleno.cjs', import.meta);
  const usingStub = Boolean(blenoModule && blenoModule.__isStub);
  let bleno = toDefaultExport(blenoModule);

  try {
    if (usingStub) {
      console.warn('Using stub bleno module - BLE advertising not available');
      if (!(bleno instanceof EventEmitter)) {
        const emitter = new EventEmitter();
        emitter.state = 'poweredOn';
        emitter.startAdvertising = (_name, _uuids, callback) => callback?.();
        emitter.stopAdvertising = (callback) => callback?.();
        emitter.setServices = (_services, callback) => callback?.();
        emitter.disconnect = () => {};
        bleno = emitter;
      }
    }
    if (!usingStub) {
      guardSharedAdapter(bleno);
      // SMP loads a second, management-channel socket at package import time.
      // Cache eviction gives each forced instance a different singleton, so
      // capture its owner now rather than looking up the last one at shutdown.
      const managementPath = requireFromWrapper.resolve(`${BLENO_REQUEST}/lib/hci-socket/mgmt`);
      bleno.__gymnasticonManagement = requireFromWrapper.cache[managementPath]?.exports;
    }
    // Teaching note: trigger bleno init while the adapter env var is set so
    // each instance binds to the intended HCI device.
    if (!usingStub && bleno && !bleno.initialized && typeof bleno.once === 'function') {
      captureBluetoothInitialization(bleno, () => bleno.once('stateChange', () => {}));
    }
    return { bleno };
  } catch (error) {
    stopBluetoothStack(bleno);
    if (!usingStub) clearDependencyCache(BLENO_REQUEST);
    throw error;
  } finally {
    if (previousAdapter === undefined) {
      delete process.env.BLENO_HCI_DEVICE_ID;
    } else {
      process.env.BLENO_HCI_DEVICE_ID = previousAdapter;
    }
  }
};
