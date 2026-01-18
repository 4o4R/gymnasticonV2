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
      await noble.startScanningAsync(serviceUuids, allowDuplicates);
      startedScan = true;
      console.log('[ble-scan] ✓ Noble scan started successfully');
    } catch (err) {
      if (isAlreadyScanningError(err)) {
        console.log('[ble-scan] Noble scan already running; reusing existing scan');
      } else {
        throw err;
      }
    }

    return await waitForDiscovery(noble, filter, {
      timeoutMs,
      startedScan,
      stopScanOnMatch,
      stopScanOnTimeout,
    });
  } catch (err) {
    // Noble failed - try hcitool fallback
    console.warn(`[ble-scan] ⚠ Noble scan failed: ${err.message}`);
    console.warn(`[ble-scan] ⚠ Falling back to hcitool lescan...`);
    return scanWithHcitool(filter, { adapter, timeoutMs: options?.timeoutMs });
  }
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
      const needsSudo = typeof process.getuid === 'function' && process.getuid() !== 0;
      const sudoPrefix = needsSudo ? 'sudo -n ' : '';
      const cmd = `${sudoPrefix}hcitool -i ${adapter} lescan`;
      const scanProcess = spawn('bash', ['-c', cmd], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let output = '';
      let errorOutput = '';
      let foundMatch = false;
      const seenDevices = new Set();
      const timeout = setTimeout(() => {
        try {
          scanProcess.kill();
        } catch (e) {
          // ignore
        }
        if (!foundMatch) {
          reject(new Error('hcitool scan timeout - no devices found'));
        }
      }, timeoutMs);  // 30 second timeout

      scanProcess.stdout.on('data', (data) => {
        output += data.toString();
        const lines = output.split('\n');

        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          if (!line || line.includes('LE Scan')) continue;

          const parts = line.split(/\s+/);
          if (parts.length < 2) continue;

          const addr = parts[0];
          const name = parts.slice(1).join(' ') || '(no name)';
          const deviceKey = `${addr}:${name}`;

          if (seenDevices.has(deviceKey)) continue;
          seenDevices.add(deviceKey);

          console.log(`[ble-scan] hcitool found: ${name} [${addr}]`);

          const fakePeripheral = {
            address: addr,
            advertisement: {
              localName: name
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
            return;
          }
        }

        output = lines[lines.length - 1];
      });

      scanProcess.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      scanProcess.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`hcitool process error: ${err.message}`));
      });

      scanProcess.on('exit', () => {
        clearTimeout(timeout);
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
          reject(new Error('hcitool scan ended without finding device'));
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
