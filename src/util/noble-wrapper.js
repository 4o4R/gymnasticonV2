import {EventEmitter} from 'events';
import {createRequire} from 'module';
import {loadDependency, toDefaultExport} from './optional-deps.js';
import {normalizeAdapterId} from './adapter-id.js';

const requireFromWrapper = createRequire(import.meta.url);
const NOBLE_REQUEST = '@abandonware/noble';

function patchNobleMtu(noble) {
  // Guard against the noble MTU race (#55) where a peripheral drops mid-update.
  if (!noble || noble.__gymnasticonMtuPatched) {
    return;
  }
  const bindings = noble._bindings;
  if (!bindings || typeof bindings.on !== 'function') {
    return;
  }

  const safeOnMtu = (peripheralUuid, mtu) => {
    const peripheral = noble._peripherals?.[peripheralUuid];
    if (!peripheral) {
      if (typeof noble.emit === 'function') {
        noble.emit('warning', `unknown peripheral ${peripheralUuid} mtu update ignored`);
      }
      return;
    }
    peripheral.mtu = mtu;
  };

  if (typeof bindings.removeAllListeners === 'function') {
    bindings.removeAllListeners('onMtu');
  }
  bindings.on('onMtu', safeOnMtu);
  noble.__gymnasticonMtuPatched = true;
}

function isHciBindRaceError(error) {
  const message = String(error?.message || error || '');
  return error?.code === 'EALREADY' ||
    /operation already in progress/i.test(message) ||
    /bind/i.test(message);
}

function patchNobleHciInit(noble) {
  if (!noble || noble.__gymnasticonHciInitPatched) {
    return;
  }
  const hci = noble?._bindings?._hci;
  if (!hci || typeof hci.init !== 'function') {
    return;
  }

  const originalInit = hci.init.bind(hci);
  hci.init = function patchedHciInit(...args) {
    try {
      return originalInit(...args);
    } catch (error) {
      if (!isHciBindRaceError(error)) {
        throw error;
      }

      if (typeof noble.emit === 'function') {
        noble.emit(
          'warning',
          `suppressed noble HCI bind race (${error?.code || 'EALREADY'}); continuing in degraded mode`
        );
      }
      // Keep noble alive even when BlueZ reports transient bind races.
      if (typeof this.emit === 'function') {
        this.emit('stateChange', 'poweredOff');
      }
      // Re-arm the poll loop after the transient bind failure.
      setTimeout(() => {
        try {
          if (typeof this.pollIsDevUp === 'function') {
            this.pollIsDevUp();
          }
        } catch (retryError) {
          if (typeof noble.emit === 'function') {
            noble.emit('warning', `HCI poll retry failed: ${retryError?.message || retryError}`);
          }
        }
      }, 1000);
      return;
    }
  };

  noble.__gymnasticonHciInitPatched = true;
}

export const initializeBluetooth = async (adapter = 'hci0', options = {}) => {
  const {forceNewInstance = false} = options; // Allow callers to request a dedicated noble instance.
  const previousAdapter = process.env.NOBLE_HCI_DEVICE_ID;
  // Teaching note: noble expects a numeric adapter index in the env var, so
  // normalize "hci0" to "0" before loading the module.
  const adapterId = normalizeAdapterId(adapter);
  if (adapterId !== undefined) {
    process.env.NOBLE_HCI_DEVICE_ID = adapterId; // Point noble at the requested adapter while we load it.
  }

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

    patchNobleMtu(noble);
    patchNobleHciInit(noble);

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
