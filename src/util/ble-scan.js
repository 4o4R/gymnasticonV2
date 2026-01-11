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
  let timeoutHandle;

  const timeoutLabel = hasTimeout ? `${timeoutMs}ms` : 'disabled';
  console.log(`[ble-scan] Starting BLE scan (timeout: ${timeoutLabel}, allowDuplicates: ${allowDuplicates})`);
  
  return new Promise((resolve, reject) => {
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
    
    const onTimeout = async () => {
      console.log(`[ble-scan] ✗ Scan timed out after ${timeoutMs}ms (saw ${discoveryCount} devices, none matched filter)`);
      cleanup();
      resolve(null);
    };
    
    const cleanup = async () => {
      noble.removeListener('discover', onDiscover);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      try {
        await noble.stopScanningAsync();
      } catch (err) {
        console.error(`[ble-scan] Error stopping scan: ${err.message}`);
      }
    };
    
    console.log(`[ble-scan] Attaching discover event listener...`);
    noble.on('discover', onDiscover);
    console.log(`[ble-scan] Starting scan with noble.startScanningAsync(serviceUuids=${JSON.stringify(serviceUuids)}, allowDuplicates=${allowDuplicates})...`);
    if (hasTimeout) {
      timeoutHandle = setTimeout(onTimeout, timeoutMs);
    }
    
    noble.startScanningAsync(serviceUuids, allowDuplicates)
      .then(() => {
        console.log(`[ble-scan] Scanning started successfully`);
      })
      .catch((err) => {
        console.error(`[ble-scan] Error starting scan: ${err.message}`);
        cleanup().then(() => resolve(null));
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
