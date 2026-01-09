import {on} from 'events';
import {macAddress} from './mac-address.js';

/**
 * Returns true if the given peripheral matches.
 * @callback FilterFunction
 * @param {Peripheral} peripheral - a noble Peripheral instance.
 * @returns {boolean} true if peripheral is a match, otherwise false
 */

/**
 * Scan for first matching BLE device.
 * @param {Noble} noble - a Noble instance.
 * @param {string[]} serviceUuids - find devices advertising these GATT service uuids
 * @param {FilterFunction} filter - find devices matching this filter
 * @param {object} options - scan options
 * @param {boolean} [options.allowDuplicates=true] - allow duplicate discovery events
 * @param {number} [options.timeoutMs=60000] - maximum time to scan in milliseconds
 * @returns {Peripheral} the matching peripheral, or null if timeout exceeded
 */
export async function scan(noble, serviceUuids, filter = () => true, options = {}) {
  const allowDuplicates = options.allowDuplicates ?? true;
  const timeoutMs = options.timeoutMs ?? 60000;
  let peripheral;
  let discoveryCount = 0;
  
  console.log(`[ble-scan] Starting BLE scan (timeout: ${timeoutMs}ms, allowDuplicates: ${allowDuplicates})`);
  
  const results = on(noble, 'discover');
  await noble.startScanningAsync(serviceUuids, allowDuplicates);
  
  try {
    // Use Promise.race to add a timeout
    await Promise.race([
      (async () => {
        for await (const [result] of results) {
          discoveryCount++;
          const name = result?.advertisement?.localName || '(no name)';
          const addr = result?.address || 'unknown';
          
          // Log every 10th discovery to avoid spam
          if (discoveryCount % 10 === 1) {
            console.log(`[ble-scan] Discovery #${discoveryCount}: ${name} [${addr}]`);
          }
          
          if (filter(result)) {
            peripheral = result;
            console.log(`[ble-scan] ✓ MATCH FOUND after ${discoveryCount} discoveries: ${name} [${addr}]`);
            return;
          }
        }
      })(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`timeout`)), timeoutMs)
      )
    ]);
  } catch (err) {
    if (err.message && err.message.includes('timeout')) {
      console.log(`[ble-scan] ✗ Scan timed out after ${timeoutMs}ms (saw ${discoveryCount} devices, none matched filter)`);
      peripheral = null;
    } else {
      throw err;
    }
  } finally {
    await noble.stopScanningAsync();
  }
  
  return peripheral;
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
  return (peripheral) => peripheral && peripheral.advertisement && name === peripheral.advertisement.localName
}

/**
 * Create a function that filters peripherals by address.
 * @param {string} address - address to match
 * @returns {FilterFunction} - the filter function
 */
export function createAddressFilter(address) {
  return (peripheral) => peripheral && peripheral.address && macAddress(address) == macAddress(peripheral.address)
}
