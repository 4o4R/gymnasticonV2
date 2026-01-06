import {macAddress} from './mac-address.js';

/**
 * Returns true if the given peripheral matches.
 * @callback FilterFunction
 * @param {Peripheral} peripheral - a noble Peripheral instance.
 * @returns {boolean} true if peripheral is a match, otherwise false
 */

/**
 * Scan for first matching BLE device using event listeners (compatible with noble).
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
  let peripheral = null;
  let discoveryCount = 0;
  let timeoutHandle = null;
  
  console.log(`[ble-scan] Starting BLE scan (timeout: ${timeoutMs}ms, allowDuplicates: ${allowDuplicates})`);
  
  return new Promise(async (resolve, reject) => {
    // Handler for discovery events
    const onDiscover = (result) => {
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
        cleanup();
        resolve(peripheral);
      }
    };
    
    // Cleanup function
    const cleanup = async () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      noble.removeListener('discover', onDiscover);
      try {
        await noble.stopScanningAsync();
      } catch (err) {
        // Ignore stop errors
      }
    };
    
    // Set timeout
    timeoutHandle = setTimeout(async () => {
      console.log(`[ble-scan] ✗ Scan timed out after ${timeoutMs}ms (saw ${discoveryCount} devices total, none matched filter)`);
      await cleanup();
      resolve(null);
    }, timeoutMs);
    
    try {
      // Attach listener BEFORE starting scan so we catch early discoveries
      noble.on('discover', onDiscover);
      
      // Start scanning
      await noble.startScanningAsync(serviceUuids, allowDuplicates);
    } catch (err) {
      await cleanup();
      reject(err);
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
