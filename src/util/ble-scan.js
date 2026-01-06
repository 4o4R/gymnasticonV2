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
export async function scan(noble, serviceUuids, filter = () => true, options = {}) { // Scan for the first peripheral that satisfies the filter.
  const allowDuplicates = options.allowDuplicates ?? true; // Noble accepts an allowDuplicates flag when starting a scan.
  const timeoutMs = options.timeoutMs ?? 60000; // Default 60 second timeout to prevent infinite hangs
  let peripheral; // Track the matched peripheral so we can stop scanning once found.
  const results = on(noble, 'discover'); // Convert noble discover events into an async iterator.
  await noble.startScanningAsync(serviceUuids, allowDuplicates); // Kick off the scan using the caller's duplicate preference.
  
  try {
    // Race between finding a match and timeout
    await Promise.race([
      (async () => {
        for await (const [result] of results) {
          if (filter(result)) {
            peripheral = result;
            return; // Found match, exit the loop
          }
        }
      })(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`BLE scan timeout after ${timeoutMs}ms`)), timeoutMs)
      )
    ]);
  } catch (err) {
    // If timeout or other error, we'll return null below and let the caller retry
    if (err.message && err.message.includes('timeout')) {
      // Timeout is expected behavior, not a fatal error
      peripheral = null;
    } else {
      throw err; // Re-throw unexpected errors
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
