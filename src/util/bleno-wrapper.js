import {EventEmitter} from 'events';
import {createRequire} from 'module';
import {loadDependency, toDefaultExport} from './optional-deps.js';
import {normalizeAdapterId} from './adapter-id.js';

const requireFromWrapper = createRequire(import.meta.url);
const BLENO_REQUEST = '@abandonware/bleno';

export const initializeBleno = async (adapter = 'hci0', options = {}) => {
  const {forceNewInstance = false} = options;
  const previousAdapter = process.env.BLENO_HCI_DEVICE_ID;
  const adapterId = normalizeAdapterId(adapter);
  if (adapterId !== undefined) {
    process.env.BLENO_HCI_DEVICE_ID = adapterId;
  }

  if (forceNewInstance) {
    try {
      const cachedPath = requireFromWrapper.resolve(BLENO_REQUEST);
      delete require.cache[cachedPath];
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
    // Teaching note: trigger bleno init while the adapter env var is set so
    // each instance binds to the intended HCI device.
    if (!usingStub && bleno && !bleno.initialized && typeof bleno.once === 'function') {
      bleno.once('stateChange', () => {});
    }
    return { bleno };
  } finally {
    if (previousAdapter === undefined) {
      delete process.env.BLENO_HCI_DEVICE_ID;
    } else {
      process.env.BLENO_HCI_DEVICE_ID = previousAdapter;
    }
  }
};
