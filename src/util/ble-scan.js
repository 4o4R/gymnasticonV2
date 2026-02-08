import {execSync, spawn} from 'child_process';
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
 * stays 'unknown' even though the adapter is up. When noble.startScanningAsync()
 * fails due to state issues, this function falls back to using hcitool lescan.
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
  
  // Try the normal noble path first
  try {
    // Start scanning - this may fail if noble.state is 'unknown'
    try {
      await startScanningWithAdapter(noble, serviceUuids, allowDuplicates, adapter);
      startedScan = true;
      console.log('[ble-scan] ✓ Noble scan started successfully');
    } catch (err) {
      if (isAlreadyScanningError(err)) {
        console.log('[ble-scan] Noble scan already running; reusing existing scan');
      } else {
        throw err;
      }
    }

    const discovered = await waitForDiscovery(noble, filter, {
      timeoutMs,
      startedScan,
      stopScanOnMatch,
      stopScanOnTimeout,
    });
    if (discovered) {
      return discovered;
    }
    // Teaching note: when noble starts scanning but never emits discover
    // events, treat that as a noble failure so we can fall back to hcitool.
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      throw new Error(`noble scan timeout - no matching devices found after ${timeoutMs}ms`);
    }
    return discovered;
  } catch (err) {
    // Noble failed - try hcitool fallback
    console.warn(`[ble-scan] ⚠ Noble scan failed: ${err.message}`);
    console.warn(`[ble-scan] ⚠ Falling back to hcitool lescan...`);
    const skipReset = resolveHcitoolResetPolicy({ error: err, noble, options });
    return scanWithHcitool(filter, { adapter, timeoutMs: options?.timeoutMs, skipReset });
  }
}

function resolveHcitoolResetPolicy({ error, noble, options }) {
  // Explicit per-call override wins over all heuristics.
  if (typeof options?.hcitoolReset === 'boolean') {
    return options.hcitoolReset !== true;
  }

  // Optional global override for field debugging.
  const envPolicy = String(process.env.GYMNASTICON_HCITOOL_RESET || '').trim().toLowerCase();
  if (['1', 'true', 'always', 'force', 'on'].includes(envPolicy)) {
    return false;
  }
  if (['0', 'false', 'never', 'off'].includes(envPolicy)) {
    return true;
  }

  // Auto policy: avoid adapter resets while noble is in the "unknown" failure
  // mode because that path is known to trigger EALREADY bind races on Pi.
  const message = String(error?.message || error || '');
  if (isStateUnknownError(error)) {
    return true;
  }
  if (/ealready|operation already in progress/i.test(message) || /syscall.*bind/i.test(message)) {
    return true;
  }
  if (String(noble?.state || '').toLowerCase() === 'unknown') {
    return true;
  }

  // For non-noble-state failures, keep the original reset behavior.
  return false;
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
 * Fallback BLE scan using hcitool.
 * Used when noble fails (e.g., due to state machine issues on some Pi hardware).
 */
async function scanWithHcitool(filter, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const adapter = options.adapter || 'hci0';
      const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : 30000;
      const skipReset = options.skipReset === true;
      const needsSudo = typeof process.getuid === 'function' && process.getuid() !== 0;
      const sudoPrefix = needsSudo ? 'sudo -n ' : '';
      
      // Aggressively reset adapter before scanning to clear any stuck state from noble
      // This fixes "Input/output error" and "EALREADY" errors when noble exits without cleanup
      // Strategy: DOWN → RESET → UP ensures clean state and prevents conflicts
      // IMPORTANT: We must wait long enough for noble's polling to settle after state changes
      if (!skipReset) {
        const resetStart = Date.now();
        try {
          // Bring adapter DOWN to release all HCI bindings
          console.log(`[ble-scan] ℹ Resetting adapter ${adapter}...`);
          execSync(`${sudoPrefix}hciconfig ${adapter} down`, { stdio: 'ignore', timeout: 2000 });
          // Busy wait for cleanup (1 second)
          while (Date.now() - resetStart < 1000) {
            // spin - wait for noble to see state change and settle
          }
          // Reset the hardware state
          execSync(`${sudoPrefix}hciconfig ${adapter} reset`, { stdio: 'ignore', timeout: 2000 });
          // Busy wait (2 seconds from start = 1 second after reset command)
          while (Date.now() - resetStart < 2000) {
            // spin - wait for hardware reset to complete
          }
          // Bring adapter back UP
          execSync(`${sudoPrefix}hciconfig ${adapter} up`, { stdio: 'ignore', timeout: 2000 });
          // Busy wait for stabilization - CRITICAL: must be long enough for noble's polling to settle
          // Noble polls every ~1 second, so wait 4-5 seconds to ensure at least 1 full poll cycle completes
          while (Date.now() - resetStart < 5000) {
            // spin - let noble's polling timer fire and settle
          }
          console.log(`[ble-scan] ✓ Adapter ${adapter} reset complete, hcitool ready`);
        } catch (e) {
          // Reset sequence failed but we'll try hcitool anyway
          console.log(`[ble-scan] ⚠ Adapter reset sequence failed: ${e.message}`);
        }
      } else {
        console.log(`[ble-scan] ℹ Skipping adapter reset for ${adapter} (avoids noble EALREADY crash)`);
      }
      
      const cmd = `${sudoPrefix}hcitool -i ${adapter} lescan --duplicates`;
      const scanProcess = spawn('bash', ['-c', cmd], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let errorOutput = '';
      let foundMatch = false;
      const seenDevices = new Set();
      let discoveredCount = 0;
      const timeout = setTimeout(() => {
        try {
          scanProcess.kill();
        } catch (e) {
          // ignore
        }
        if (!foundMatch) {
          reject(new Error(`hcitool scan timeout - no matching devices found (saw ${discoveredCount})`));
        }
      }, timeoutMs);  // 30 second timeout

      const processLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (/^LE Scan/i.test(trimmed)) return;

        // hcitool output is usually:
        //   AA:BB:CC:DD:EE:FF Name
        // but some stacks emit only the address with no name.
        const match = trimmed.match(/^([0-9A-F]{2}(?::[0-9A-F]{2}){5})(?:\s+(.*))?$/i);
        if (!match) {
          return;
        }

        const addr = match[1];
        const rawName = (match[2] || '').trim();
        const name = rawName || '(no name)';
        const deviceKey = `${addr}:${name}`;

        if (seenDevices.has(deviceKey)) return;
        seenDevices.add(deviceKey);
        discoveredCount += 1;

        console.log(`[ble-scan] hcitool found: ${name} [${addr}]`);

        const fakePeripheral = {
          address: addr,
          advertisement: {
            localName: rawName
          }
        };

        if (filter(fakePeripheral)) {
          console.log(`[ble-scan] ✓ MATCH via hcitool: ${name} [${addr}]`);
          foundMatch = true;
          clearTimeout(timeout);
          try {
            scanProcess.kill();
          } catch (e) {
            // ignore
          }
          resolve(fakePeripheral);
        }
      };

      const consumeStream = (chunk, source) => {
        const text = chunk.toString();
        if (source === 'stderr') {
          errorOutput += text;
        }
        const next = (source === 'stdout' ? stdoutBuffer : stderrBuffer) + text;
        const lines = next.split('\n');
        const rest = lines.pop() || '';
        for (const line of lines) {
          processLine(line);
          if (foundMatch) {
            break;
          }
        }
        if (source === 'stdout') {
          stdoutBuffer = rest;
        } else {
          stderrBuffer = rest;
        }
      };

      scanProcess.stdout.on('data', (data) => {
        consumeStream(data, 'stdout');
      });

      scanProcess.stderr.on('data', (data) => {
        consumeStream(data, 'stderr');
      });

      scanProcess.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`hcitool process error: ${err.message}`));
      });

      scanProcess.on('exit', () => {
        clearTimeout(timeout);
        // Flush any trailing unterminated line.
        if (!foundMatch) {
          if (stdoutBuffer) processLine(stdoutBuffer);
          if (stderrBuffer) processLine(stderrBuffer);
        }
        stdoutBuffer = '';
        stderrBuffer = '';

        if (foundMatch) {
          return;
        }
        if (!foundMatch) {
          if (/sudo:.*password/i.test(errorOutput)) {
            reject(new Error('hcitool requires passwordless sudo; run `sudo visudo` or execute Gymnasticon as root'));
            return;
          }
          if (/sudo: command not found/i.test(errorOutput)) {
            reject(new Error('sudo is not installed; install it or run Gymnasticon as root'));
            return;
          }
          if (/hcitool:.*not found/i.test(errorOutput)) {
            reject(new Error('hcitool is missing; install bluez (sudo apt-get install -y bluez)'));
            return;
          }
          if (/invalid option|unrecognized option|usage:/i.test(errorOutput)) {
            reject(new Error('hcitool does not support --duplicates on this system'));
            return;
          }
          reject(new Error(`hcitool scan ended without finding device (saw ${discoveredCount})`));
        }
      });
    } catch (err) {
      reject(new Error(`Failed to start hcitool: ${err.message}`));
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
