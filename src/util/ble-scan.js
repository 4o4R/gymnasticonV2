import {execSync} from 'child_process';
import {macAddress} from './mac-address.js';
import {normalizeAdapterName} from './adapter-id.js';

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
  const adapter = resolveAdapterName(noble, options);
  const timeoutMs = Number.isFinite(options?.timeoutMs) ? options.timeoutMs : null;
  const stopScanOnMatch = options?.stopScanOnMatch !== false;
  const stopScanOnTimeout = options?.stopScanOnTimeout !== false;
  // Teaching note: optional per-discovery callback so callers (autodetect)
  // can count/log every advertisement, not just the ones that match. This is
  // what lets a failed scan distinguish "radio saw nothing" from "radio saw
  // devices but none matched a supported bike".
  const onDiscovery = typeof options?.onDiscovery === 'function' ? options.onDiscovery : null;

  // Teaching note: the discovery deadline is armed inside waitForDiscovery()
  // *before* scanning is started. The pinned noble silently swallows some
  // controller failures (e.g. "Command Disallowed"), which leaves
  // startScanningAsync() pending forever; awaiting startup first used to hang
  // autodetection indefinitely with no watchdog.
  return waitForDiscovery(noble, filter, {
    timeoutMs,
    stopScanOnMatch,
    stopScanOnTimeout,
    onDiscovery,
    startScan: () => startScanningWithAdapter(noble, serviceUuids, allowDuplicates, adapter),
  });
}

function resolveAdapterName(noble, options = {}) {
  if (options.adapter) {
    return options.adapter;
  }
  if (options.adapterName) {
    return options.adapterName;
  }
  const stashed = normalizeAdapterName(noble?.__gymnasticonAdapterId);
  if (stashed) {
    return stashed;
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

/**
 * Stop BLE scanning without ever hanging.
 *
 * noble's stopScanningAsync() can wait forever for a scanStop event on some
 * Pi/BlueZ combos when noble.state stays "unknown" (which is exactly the
 * degraded mode the bindings-fallback scan uses). Callers must not block
 * results or shutdown on it, so prefer the synchronous stopScanning() and cap
 * the async variant with a timeout.
 */
export function stopScanningSafely(noble) {
  if (!noble) {
    return Promise.resolve();
  }
  if (typeof noble.stopScanning === 'function') {
    try {
      noble.stopScanning();
      return Promise.resolve();
    } catch (_error) {
      // fall through to the bounded async variant
    }
  }
  if (typeof noble.stopScanningAsync === 'function') {
    return Promise.race([
      noble.stopScanningAsync().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  }
  return Promise.resolve();
}

function waitForDiscovery(noble, filter, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId = null;
    let scanningStarted = false;
    // Set when the caller asked for the scan to be stopped but the scan had not
    // finished starting yet, so the stop has to happen once startup lands.
    let stopWhenStarted = false;

    let onDiscover = null;

    const removeListeners = () => {
      if (onDiscover) {
        noble.removeListener('discover', onDiscover);
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const settle = (peripheral, didMatch) => {
      if (settled) return;
      settled = true;
      removeListeners();

      const shouldStop = (didMatch && options.stopScanOnMatch) ||
        (!didMatch && options.stopScanOnTimeout);

      if (shouldStop && !scanningStarted) {
        // Startup is still in flight (e.g. it timed out). Remember to stop the
        // scan the moment it actually starts instead of leaving it running.
        stopWhenStarted = true;
      } else if (shouldStop) {
        // Fire-and-forget the stop: it must never delay the result, because
        // stopScanningAsync() can hang forever in noble's "unknown" state and
        // that would wedge autodetect and the app's shutdown path.
        stopScanningSafely(noble);
      }

      resolve(peripheral);
    };

    const fail = (error) => {
      if (settled) {
        // The promise already settled (match/timeout); a late startup failure
        // has nowhere to go, so surface it in the log instead of swallowing it.
        console.warn(`[ble-scan] ⚠ Noble scan startup failed after the scan settled: ${error?.message || error}`);
        return;
      }
      settled = true;
      removeListeners();
      if (scanningStarted) {
        stopScanningSafely(noble);
      }
      reject(error);
    };

    onDiscover = (result) => {
      if (settled) return;
      if (options.onDiscovery) {
        options.onDiscovery(result);
      }
      if (filter(result)) {
        settle(result, true);
      }
    };

    noble.on('discover', onDiscover);

    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        settle(null, false);
      }, options.timeoutMs);
    }

    // Start scanning without ever awaiting it in the caller's path: the result
    // is already bounded by the deadline armed above.
    Promise.resolve()
      .then(() => options.startScan())
      .then(() => {
        scanningStarted = true;
        if (stopWhenStarted) {
          console.log('[ble-scan] scan started after the result settled; stopping it now');
          stopScanningSafely(noble);
          return;
        }
        if (!settled) {
          console.log('[ble-scan] ✓ Noble scan started successfully');
        }
      })
      .catch((error) => {
        if (isAlreadyScanningError(error)) {
          // Someone else owns the scan: never stop a scan we did not start.
          console.log('[ble-scan] Noble scan already running; reusing existing scan');
          return;
        }
        fail(error);
      });
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
