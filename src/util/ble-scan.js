import {on} from 'events';
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
 * stays 'unknown' even though the adapter is up. When noble.startScanningAsync()
 * fails due to state issues, this function falls back to using hcitool lescan.
 * 
 * @param {Noble} noble - a Noble instance.
 * @param {string[]} serviceUuids - find devices advertising these GATT service uuids
 * @param {FilterFunction} filter - find devices matching this filter
 * @returns {Peripheral} the matching peripheral
 */
export async function scan(noble, serviceUuids, filter = () => true) {
  let peripheral;
  
  // Try the normal noble path first
  try {
    let results = on(noble, 'discover');
    
    // Start scanning - this may fail if noble.state is 'unknown'
    await noble.startScanningAsync(serviceUuids, true);
    
    console.log('[ble-scan] ✓ Noble scan started successfully');
    for await (const [result] of results) {
      if (filter(result)) {
        peripheral = result;
        break;
      }
    }
    await noble.stopScanningAsync();
    return peripheral;
  } catch (err) {
    // Noble failed - try hcitool fallback
    console.warn(`[ble-scan] ⚠ Noble scan failed: ${err.message}`);
    console.warn(`[ble-scan] ⚠ Falling back to hcitool lescan...`);
    return scanWithHcitool(filter);
  }
}

/**
 * Fallback BLE scan using hcitool.
 * Used when noble fails (e.g., due to state machine issues on some Pi hardware).
 */
async function scanWithHcitool(filter) {
  return new Promise((resolve, reject) => {
    try {
      const cmd = 'sudo hcitool -i hci0 lescan';
      const process = require('child_process').spawn('bash', ['-c', cmd], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let output = '';
      let foundMatch = false;
      const seenDevices = new Set();
      const timeout = setTimeout(() => {
        try {
          process.kill();
        } catch (e) {
          // ignore
        }
        if (!foundMatch) {
          reject(new Error('hcitool scan timeout - no devices found'));
        }
      }, 30000);  // 30 second timeout

      process.stdout.on('data', (data) => {
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
              process.kill();
            } catch (e) {
              // ignore
            }
            resolve(fakePeripheral);
            return;
          }
        }

        output = lines[lines.length - 1];
      });

      process.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`hcitool process error: ${err.message}`));
      });

      process.on('exit', () => {
        clearTimeout(timeout);
        if (!foundMatch) {
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
