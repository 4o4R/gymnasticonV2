import {execSync} from 'child_process';
import {macAddress} from './mac-address.js';

/**
 * Returns true if the given peripheral matches.
 * @callback FilterFunction
 * @param {Peripheral} peripheral - a noble Peripheral instance.
 * @returns {boolean} true if peripheral is a match, otherwise false
 */

/**
 * Scan for first matching BLE device.
 *
 * Some Pi/noble combinations don't properly report adapter state, so noble.state
 * stays 'unknown' even though the adapter is up. In that case this function
 * retries through noble's binding so the result remains a connectable Peripheral.
 *
 * @param {Noble} noble - a Noble instance.
 * @param {string[]} serviceUuids - find devices advertising these GATT service uuids
 * @param {FilterFunction} filter - find devices matching this filter
 * @param {object} options
 * @param {boolean} [options.allowDuplicates=true] - forward to noble scan
 * @param {number} [options.timeoutMs] - stop scanning after this duration (ms)
 * @param {boolean} [options.stopScanOnMatch=true] - stop scanning after match
 * @param {boolean} [options.stopScanOnTimeout=true] - stop scanning when timing out
 * @returns {Peripheral} the matching peripheral
 */
export async function scan(noble, serviceUuids, filter = () => true, options = {}) {
  const allowDuplicates = options?.allowDuplicates ?? true;
  const adapter = resolveAdapterName(options);
  const timeoutMs = Number.isFinite(options?.timeoutMs) ? options.timeoutMs : null;
  const stopScanOnMatch = options?.stopScanOnMatch !== false;
  const stopScanOnTimeout = options?.stopScanOnTimeout !== false;
  let startedScan = false;

  try {
    await startScanningWithAdapter(noble, serviceUuids, allowDuplicates, adapter);
    startedScan = true;
    console.log('[ble-scan] ✓ Noble scan started successfully');
  } catch (error) {
    if (isAlreadyScanningError(error)) {
      console.log('[ble-scan] Noble scan already running; reusing existing scan');
    } else {
      throw error;
    }
  }

  return waitForDiscovery(noble, filter, {
    timeoutMs,
    startedScan,
    stopScanOnMatch,
    stopScanOnTimeout,
  });
}

function resolveAdapterName(options = {}) {
  if (options.adapter) {
    return options.adapter;
  }
  if (options.adapterName) {
    return options.adapterName;
  }
  const envAdapter = process.env.NOBLE_HCI_DEVICE_ID;
  if (envAdapter !== undefined && envAdapter !== null) {
    const text = String(envAdapter).trim();
    if (/^\d+$/.test(text)) {
      return `hci${text}`;
    }
    if (/^hci\d+$/i.test(text)) {
      return text;
    }
  }
  return 'hci0';
}

function isAlreadyScanningError(error) {
  const message = String(error?.message || error || '');
  return /already (?:start(ed)? )?scanning/i.test(message) || /scan already in progress/i.test(message);
}

function isStateUnknownError(error) {
  const message = String(error?.message || error || '');
  return /state is unknown/i.test(message) || /not poweredon/i.test(message);
}

function isAdapterUp(adapterName) {
  if (!adapterName) {
    return false;
  }
  try {
    const output = execSync(`hciconfig ${adapterName}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString();
    return /UP RUNNING/.test(output);
  } catch (_error) {
    return false;
  }
}

function forceNoblePoweredOn(noble) {
  if (!noble) {
    return;
  }
  try {
    noble.state = 'poweredOn';
    if ('_state' in noble) {
      noble._state = 'poweredOn';
    }
    if (typeof noble.emit === 'function') {
      noble.emit('stateChange', 'poweredOn');
    }
  } catch (_error) {
    // ignore - best-effort shim for broken state machines
  }
}

async function startScanningWithAdapter(noble, serviceUuids, allowDuplicates, adapter) {
  try {
    await noble.startScanningAsync(serviceUuids, allowDuplicates);
  } catch (error) {
    if (isStateUnknownError(error) && isAdapterUp(adapter)) {
      console.warn(`[ble-scan] ⚠ Noble state unknown but ${adapter} is UP; forcing state to poweredOn and retrying scan`);
      forceNoblePoweredOn(noble);
      try {
        await noble.startScanningAsync(serviceUuids, allowDuplicates);
        return;
      } catch (retryError) {
        if (isStateUnknownError(retryError) && tryStartScanViaBindings(noble, serviceUuids, allowDuplicates)) {
          return;
        }
        throw retryError;
      }
    }
    throw error;
  }
}

function tryStartScanViaBindings(noble, serviceUuids, allowDuplicates) {
  const bindings = noble?._bindings;
  if (!bindings || typeof bindings.startScanning !== 'function') {
    return false;
  }
  try {
    // Mirror noble's bookkeeping so duplicate filtering remains consistent.
    noble._discoveredPeripheralUUids = [];
    noble._allowDuplicates = allowDuplicates;
    bindings.startScanning(serviceUuids, allowDuplicates);
    console.warn('[ble-scan] ⚠ Started scan via noble bindings fallback (state remained unknown)');
    return true;
  } catch (error) {
    console.warn(`[ble-scan] ⚠ Direct bindings scan start failed: ${error?.message || error}`);
    return false;
  }
}

function waitForDiscovery(noble, filter, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId = null;

    const finish = (peripheral, didMatch) => {
      if (settled) return;
      settled = true;
      noble.removeListener('discover', onDiscover);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      const shouldStop = options.startedScan && (
        (didMatch && options.stopScanOnMatch) ||
        (!didMatch && options.stopScanOnTimeout)
      );

      if (shouldStop) {
        Promise.resolve()
          .then(() => noble.stopScanningAsync())
          .catch((err) => {
            if (!/not scanning/i.test(String(err?.message || err))) {
              console.warn(`[ble-scan] ⚠ stopScanning failed: ${err.message}`);
            }
          })
          .finally(() => resolve(peripheral));
      } else {
        resolve(peripheral);
      }
    };

    const onDiscover = (result) => {
      if (settled) return;
      if (filter(result)) {
        finish(result, true);
      }
    };

    noble.on('discover', onDiscover);

    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        finish(null, false);
      }, options.timeoutMs);
    }
  });
}

/**
 * Create a function that filters peripherals on multiple properties.
 * @param {object} properties
 * @param {string} properties.name - name
 * @param {string} properties.address - address
 * @returns {FilterFunction} - the filter function
 */
export function createFilter({ name, address }) {
  const filters = [];
  if (name) filters.push(createNameFilter(name));
  if (address) filters.push(createAddressFilter(address));
  return (peripheral) => filters.every(f => f(peripheral));
}

/**
 * Create a function that filters peripherals by name.
 * @param {string} name - name to match
 * @returns {FilterFunction} - the filter function
 */
export function createNameFilter(name) {
  return (peripheral) => peripheral &&
    peripheral.advertisement &&
    name === peripheral.advertisement.localName
}

/**
 * Create a function that filters peripherals by address.
 * @param {string} address - address to match
 * @returns {FilterFunction} - the filter function
 */
export function createAddressFilter(address) {
  return (peripheral) => peripheral &&
    peripheral.address &&
    macAddress(address) == macAddress(peripheral.address)
}
