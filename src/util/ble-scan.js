import {on} from 'events';
import {macAddress} from './mac-address.js';

/**
 * Callback function that determines if a BLE device is the one we're looking for.
 * @callback FilterFunction
 * @param {Peripheral} peripheral - a noble Peripheral instance with address, advertisement, etc
 * @returns {boolean} true if this is the bike we want, false otherwise
 */

/**
 * Scan for a single BLE device matching a filter.
 * This is the exact original ptx2 implementation with added comments.
 * 
 * How it works:
 * 1. Set up a listener for 'discover' events from noble
 * 2. Start scanning the BLE adapter
 * 3. As devices broadcast their advertisements, check each one with the filter
 * 4. Return the first device that matches the filter
 * 5. Stop scanning when done
 *
 * @param {Noble} noble - instance of noble BLE library (from @abandonware/noble)
 * @param {string[]} serviceUuids - optional: only find devices advertising specific GATT services
 * @param {FilterFunction} filter - callback to identify the bike we're looking for
 * @param {object} [options] - optional scan configuration
 * @param {boolean} [options.allowDuplicates=true] - whether to emit duplicate advertisements
 * @param {boolean} [options.active=true] - whether to use active scanning
 * @returns {Peripheral} the matching device peripheral, or null if not found
 * @throws {Error} if scanning fails
 * 
 * IMPORTANT: This function WILL NOT TIMEOUT. It will scan forever until a match is found.
 * If your bike is not turned on or not in range, this function will hang indefinitely.
 * This is by design - the app layer handles timeouts via the Timer class.
 */
export async function scan(noble, serviceUuids, filter = () => true, options = {}) {
  // Where we'll store the device we find, or null if nothing matches
  let peripheral;
  let discoveredDevices = new Map(); // Track seen devices to avoid duplicates in logging
  
  console.log(`[ble-scan] Starting BLE scan...`);
  
  // Set up scan parameters (allowDuplicates defaults to true if not specified)
  const allowDuplicates = options.allowDuplicates !== false;
  console.log(`[ble-scan] Starting adapter scan (allowDuplicates=${allowDuplicates})...`);
  console.log(`[ble-scan] noble state BEFORE scan: ${noble.state}, scanning: ${noble.scanning}`);
  
  // Set up a fallback listener to detect if discover events are being emitted
  let eventCount = 0;
  const fallbackListener = (peripheral) => {
    eventCount++;
    if (eventCount === 1) {
      console.log(`[ble-scan] ✓ DISCOVER EVENTS ARE FIRING! First event received.`);
    }
  };
  noble.on('discover', fallbackListener);
  
  // Use 'on()' from the events module to create an async iterator
  // Each time noble emits 'discover', we get a new item in this async loop
  const results = on(noble, 'discover');
  
  // Tell the Bluetooth adapter to start advertising scans
  try {
    await noble.startScanningAsync(serviceUuids, allowDuplicates);
    console.log(`[ble-scan] ✓ startScanningAsync completed (no error thrown)`);
    console.log(`[ble-scan] noble state AFTER startScanningAsync: ${noble.state}, scanning: ${noble.scanning}`);
  } catch (err) {
    console.error(`[ble-scan] ✗ ERROR in startScanningAsync: ${err.message}`);
    noble.removeListener('discover', fallbackListener);
    throw err;
  }
  
  // Wait 100ms to see if any discover events fire
  await new Promise(r => setTimeout(r, 100));
  if (eventCount === 0) {
    console.warn(`[ble-scan] ⚠ WARNING: No discover events received after 100ms! Noble may not be emitting events.`);
  }
  
  // Loop: for each device that broadcasts near us
  console.log(`[ble-scan] Waiting for discover events (timeout=30s)...`);
  let deviceCount = 0;
  
  try {
    for await (const [result] of results) {
      // Store device by address to track what we've seen
      if (!discoveredDevices.has(result?.address)) {
        discoveredDevices.set(result?.address, result?.advertisement?.localName);
        console.log(`[ble-scan] Discovered: ${result?.advertisement?.localName || '(no name)'} [${result?.address}]`);
      }
      
      // Check if this device is the one we want (bike name, address, etc)
      if (filter(result)) {
        // Found it! Store the device object and exit the loop
        peripheral = result;
        console.log(`[ble-scan] ✓✓✓ MATCH FOUND! Device: ${result?.advertisement?.localName} [${result?.address}]`);
        break;
      }
    }
  } finally {
    noble.removeListener('discover', fallbackListener);
  }
  
  // Stop scanning the Bluetooth adapter (important to save power)
  console.log(`[ble-scan] Stopping adapter scan...`);
  await noble.stopScanningAsync();
  
  // Return the device we found, or null if loop exited without finding anything
  return peripheral;
}


/**
 * Combine multiple filter rules into one (all must pass).
 * 
 * Example: createFilter({ name: 'M3i', address: '11:22:33:44:55:66' })
 * returns a function that checks BOTH the name AND address match.
 *
 * @param {object} properties - filter criteria
 * @param {string} [properties.name] - if set, only match devices with this BLE advertisement name
 * @param {string} [properties.address] - if set, only match devices with this MAC address
 * @returns {FilterFunction} a function that returns true if device matches all specified criteria
 */
export function createFilter({ name, address }) {
  const filters = [];
  if (name) filters.push(createNameFilter(name));
  if (address) filters.push(createAddressFilter(address));
  
  // Return a function that checks ALL filters pass
  return (peripheral) => filters.every(f => f(peripheral));
}

/**
 * Create a filter that matches devices by BLE advertisement name.
 * 
 * The "name" is what appears in the device's BLE advertisement packet.
 * For a Keiser M3i bike, the name might be "M3i#000" or similar.
 *
 * @param {string} name - exact name to match (case-sensitive)
 * @returns {FilterFunction} a function that returns true if device name matches exactly
 */
export function createNameFilter(name) {
  // Return a function that checks if a peripheral has the matching name
  return (peripheral) => {
    // Make sure peripheral exists and has advertisement data
    if (!peripheral || !peripheral.advertisement) {
      return false;
    }
    // Check if the local name matches exactly
    return name === peripheral.advertisement.localName;
  };
}

/**
 * Create a filter that matches devices by MAC address.
 * 
 * MAC addresses can be formatted different ways (with colons, hyphens, or no separators).
 * This function normalizes both the search address and device address before comparing,
 * so "11:22:33:44:55:66" and "11-22-33-44-55-66" are treated the same.
 *
 * @param {string} address - MAC address to match (format-flexible)
 * @returns {FilterFunction} a function that returns true if device address matches
 */
export function createAddressFilter(address) {
  // Return a function that checks if a peripheral has the matching address
  return (peripheral) => {
    // Make sure peripheral exists and has an address
    if (!peripheral || !peripheral.address) {
      return false;
    }
    // Compare addresses after normalizing them (handles different formats)
    return macAddress(address) == macAddress(peripheral.address);
  };
}
