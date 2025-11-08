import {EventEmitter} from 'events';
import {createRequire} from 'module';
import {loadDependency, toDefaultExport} from './optional-deps.js';

const requireFromWrapper = createRequire(import.meta.url);
const NOBLE_REQUEST = '@abandonware/noble';

export const initializeBluetooth = async (adapter = 'hci0', options = {}) => {
  const {forceNewInstance = false} = options; // Allow callers to request a dedicated noble instance.
  const previousAdapter = process.env.NOBLE_HCI_DEVICE_ID;
  process.env.NOBLE_HCI_DEVICE_ID = adapter; // Point noble at the requested adapter while we load it.

  if (forceNewInstance) {
    try {
      const cachedPath = requireFromWrapper.resolve(NOBLE_REQUEST);
      delete require.cache[cachedPath]; // Clear the cache so we get a new instance bound to the new adapter.
    } catch (error) {
      // Module may not be installed yet; skip cache cleanup in that case.
    }
  }

  const nobleModule = loadDependency(NOBLE_REQUEST, '../stubs/noble.cjs', import.meta);
  const usingStub = Boolean(nobleModule && nobleModule.__isStub);
  let noble = toDefaultExport(nobleModule);

  try {
    if (usingStub) {
      console.warn('Using stub noble module - BLE not available');
      if (!(noble instanceof EventEmitter)) {
        const emitter = new EventEmitter();
        emitter.state = 'poweredOff';
        emitter.startScanningAsync = async () => {};
        emitter.stopScanningAsync = async () => {};
        emitter.disconnect = () => {};
        noble = emitter;
      } else {
        noble.state = noble.state || 'poweredOff';
        noble.startScanningAsync = noble.startScanningAsync || (async () => {});
        noble.stopScanningAsync = noble.stopScanningAsync || (async () => {});
        noble.disconnect = noble.disconnect || (() => {});
      }
    }

    // Add retry logic for robust connections.
    const connect = async (peripheral, retries = 3) => {
      for (let i = 0; i < retries; i++) {
        try {
          await peripheral.connectAsync();
          return true;
        } catch (err) {
          if (i === retries - 1) throw err;
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    };

    return { noble, connect };
  } finally {
    // Restore the previous adapter so future callers are unaffected by this temporary override.
    if (previousAdapter === undefined) {
      delete process.env.NOBLE_HCI_DEVICE_ID;
    } else {
      process.env.NOBLE_HCI_DEVICE_ID = previousAdapter;
    }
  }
};
