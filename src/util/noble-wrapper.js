import {EventEmitter} from 'events';
import {createRequire} from 'module';
import {execSync} from 'child_process';
import path from 'path';
import {loadDependency, toDefaultExport} from './optional-deps.js';
import {normalizeAdapterId, normalizeAdapterName} from './adapter-id.js';

const requireFromWrapper = createRequire(import.meta.url);
const NOBLE_REQUEST = '@abandonware/noble';

export const CONNECT_TIMEOUT_MS = 10000;

/**
 * Connect to a peripheral with a bounded wait.
 *
 * @param {Peripheral} peripheral - a noble Peripheral instance.
 * @param {number} [timeoutMs] - how long to wait before giving up.
 * @returns {Promise<void>} resolves once the link is up.
 */
export async function connectWithTimeout(peripheral, timeoutMs = CONNECT_TIMEOUT_MS) {
  if (!peripheral || typeof peripheral.connectAsync !== 'function') {
    throw new Error('connectWithTimeout() needs a noble peripheral with connectAsync()');
  }

  // Teaching note: the pinned noble exposes connectAsync = util.promisify(connect)
  // and connect() only takes a callback, so connectAsync({timeout: 10000}) hands
  // the options object to promise resolution as the callback and blows up with
  // "callback is not a function" once the connection completes. The connect
  // budget therefore has to be enforced here instead of being passed to noble.
  let timerId = null;
  let timedOut = false;
  const deadline = new Promise((_resolve, reject) => {
    timerId = setTimeout(() => {
      timedOut = true;
      const address = peripheral.address || peripheral.id || 'peripheral';
      reject(new Error(`Timed out after ${timeoutMs}ms connecting to ${address}`));
    }, timeoutMs);
  });

  try {
    await Promise.race([peripheral.connectAsync(), deadline]);
  } catch (error) {
    if (timedOut) {
      // Teaching note: noble leaves the central half-connected when the
      // controller never reports the link, and a half-open handle wedges the
      // next connection attempt on the same radio.
      try {
        if (typeof peripheral.disconnectAsync === 'function') {
          await peripheral.disconnectAsync();
        }
      } catch (_disconnectError) {
        // Best effort only; the timeout error is the one worth reporting.
      }
    }
    throw error;
  } finally {
    if (timerId) {
      clearTimeout(timerId);
    }
  }
}

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

function isStateUnknownScanError(error) {
  const message = String(error?.message || error || '');
  return /state is unknown/i.test(message) || /not poweredon/i.test(message);
}

function resolveAdapterNameFromEnv() {
  const raw = String(process.env.NOBLE_HCI_DEVICE_ID || '').trim();
  if (!raw) {
    return 'hci0';
  }
  if (/^\d+$/.test(raw)) {
    return `hci${raw}`;
  }
  if (/^hci\d+$/i.test(raw)) {
    return raw.toLowerCase();
  }
  return 'hci0';
}

function resolveAdapterName(noble) {
  // Teaching note: the adapter requested by the caller lives on the noble
  // instance (see patchNobleAdapterBinding) because the ambient env var is only
  // set for the duration of a bind and is restored afterwards.
  const stashed = normalizeAdapterName(noble?.__gymnasticonAdapterId);
  if (stashed) {
    return stashed;
  }
  return resolveAdapterNameFromEnv();
}

function isAdapterUp(adapterName) {
  if (!adapterName) {
    return false;
  }
  try {
    const output = execSync(`hciconfig ${adapterName}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return /UP RUNNING/.test(output);
  } catch (_error) {
    return false;
  }
}

function tryStartScanViaBindings(noble, serviceUuids, allowDuplicates) {
  const bindings = noble?._bindings;
  if (!bindings || typeof bindings.startScanning !== 'function') {
    return false;
  }
  try {
    noble._discoveredPeripheralUUids = [];
    noble._allowDuplicates = allowDuplicates;
    bindings.startScanning(serviceUuids, allowDuplicates);
    return true;
  } catch (_error) {
    return false;
  }
}

function patchNobleAdapterBinding(noble, adapter) {
  if (!noble) {
    return;
  }
  // Teaching note: noble only reads NOBLE_HCI_DEVICE_ID lazily inside
  // Hci.prototype.init() (which calls _socket.bindRaw(deviceId)), long after the
  // module was required, so setting the env var around the require was a no-op.
  // Stash the requested adapter on the instance instead and apply it at bind
  // time, which keeps two clients (bike + heart rate) on separate radios.
  const adapterId = normalizeAdapterId(adapter);
  if (adapterId !== undefined) {
    noble.__gymnasticonAdapterId = adapterId;
  }

  const hci = noble?._bindings?._hci;
  if (!hci || typeof hci.init !== 'function' || hci.__gymnasticonAdapterPatched) {
    return;
  }

  const originalInit = hci.init.bind(hci);
  hci.init = function patchedHciInit(...args) {
    const targetId = noble.__gymnasticonAdapterId;
    if (targetId === undefined) {
      return originalInit(...args);
    }

    const previousAdapter = process.env.NOBLE_HCI_DEVICE_ID;
    process.env.NOBLE_HCI_DEVICE_ID = targetId; // Synchronous window around bindRaw().
    try {
      return originalInit(...args);
    } finally {
      if (previousAdapter === undefined) {
        delete process.env.NOBLE_HCI_DEVICE_ID;
      } else {
        process.env.NOBLE_HCI_DEVICE_ID = previousAdapter;
      }
    }
  };

  hci.__gymnasticonAdapterPatched = true;
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
      return;
    }
  };

  noble.__gymnasticonHciInitPatched = true;
}

function patchNobleUnknownStateScan(noble) {
  if (!noble || noble.__gymnasticonUnknownStateScanPatched) {
    return;
  }
  if (typeof noble.startScanningAsync !== 'function') {
    return;
  }

  const originalStartScanningAsync = noble.startScanningAsync.bind(noble);
  noble.startScanningAsync = async function patchedStartScanningAsync(serviceUuids, allowDuplicates) {
    try {
      return await originalStartScanningAsync(serviceUuids, allowDuplicates);
    } catch (error) {
      if (!isStateUnknownScanError(error)) {
        throw error;
      }

      const adapterName = resolveAdapterName(noble);
      if (!isAdapterUp(adapterName)) {
        throw error;
      }

      // Some Pi/BlueZ builds report state "unknown" forever, but the adapter
      // can still scan if we invoke bindings directly.
      if (!tryStartScanViaBindings(noble, serviceUuids, allowDuplicates)) {
        throw error;
      }

      if (typeof noble.emit === 'function') {
        noble.emit(
          'warning',
          `state unknown on ${adapterName}; started scan via bindings fallback`
        );
      }
      return undefined;
    }
  };

  noble.__gymnasticonUnknownStateScanPatched = true;
}

export const initializeBluetooth = async (adapter = 'hci0', options = {}) => {
  const {forceNewInstance = false, loadModule} = options; // Allow callers to request a dedicated noble instance / inject a fake module.
  const previousAdapter = process.env.NOBLE_HCI_DEVICE_ID;
  // Teaching note: noble expects a numeric adapter index in the env var, so
  // normalize "hci0" to "0". This env var only covers the window in which the
  // module is loaded; the durable adapter binding is applied by
  // patchNobleAdapterBinding() below.
  const adapterId = normalizeAdapterId(adapter);
  if (adapterId !== undefined) {
    process.env.NOBLE_HCI_DEVICE_ID = adapterId; // Point noble at the requested adapter while we load it.
  }

  if (forceNewInstance && typeof loadModule !== 'function') {
    try {
      // Noble's entry point, bindings, HCI, and GAP modules all cache singleton
      // state. Evict the whole package so the new client owns a distinct HCI
      // socket instead of wrapping the original adapter's binding again.
      clearDependencyCache(NOBLE_REQUEST);
    } catch (error) {
      // Module may not be installed yet; skip cache cleanup in that case.
    }
  }

  const nobleModule = typeof loadModule === 'function'
    ? loadModule()
    : loadDependency(NOBLE_REQUEST, '../stubs/noble.cjs', import.meta);
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

    patchNobleAdapterBinding(noble, adapter);
    patchNobleMtu(noble);
    patchNobleHciInit(noble);
    patchNobleUnknownStateScan(noble);

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
