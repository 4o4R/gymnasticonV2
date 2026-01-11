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
  const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
  let peripheral;
  let discoveryCount = 0;

  const timeoutLabel = hasTimeout ? `${timeoutMs}ms` : 'disabled';
  console.log(`[ble-scan] Starting BLE scan (timeout: ${timeoutLabel}, allowDuplicates: ${allowDuplicates})`);
  
  // Use on() async iterator like original ptx2 code
  const results = on(noble, 'discover');
  
  // Fire startScanningAsync but don't await it - it may hang on some Pi/noble combinations
  console.log(`[ble-scan] Calling noble.startScanningAsync(...)`);
  noble.startScanningAsync(serviceUuids, allowDuplicates)
    .then(() => console.log(`[ble-scan] startScanningAsync resolved`))
    .catch((err) => console.error(`[ble-scan] startScanningAsync error: ${err.message}`));
  
  try {
    // Race between finding a match and timeout
    await Promise.race([
      (async () => {
        for await (const [result] of results) {
          discoveryCount++;
          const name = result?.advertisement?.localName || '(no name)';
          const addr = result?.address || 'unknown';
          
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
      new Promise((_, reject) => {
        if (hasTimeout) {
          setTimeout(() => reject(new Error('timeout')), timeoutMs);
        } else {
          // If no timeout, never reject - scan indefinitely
          setInterval(() => {}, 1000);
        }
      })
    ]);
  } catch (err) {
    if (err.message === 'timeout') {
      console.log(`[ble-scan] ✗ Scan timed out after ${timeoutMs}ms (saw ${discoveryCount} devices)`);
      peripheral = null;
    } else {
      throw err;
    }
  } finally {
    try {
      await noble.stopScanningAsync();
    } catch (err) {
      console.error(`[ble-scan] Error stopping scan: ${err.message}`);
    }
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
