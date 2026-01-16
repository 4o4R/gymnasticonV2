import {macAddress} from './mac-address.js';

/**
 * Callback function that determines if a BLE device is the one we're looking for.
 * @callback FilterFunction
 * @param {Peripheral} peripheral - a noble Peripheral instance with address, advertisement, etc
 * @returns {boolean} true if this is the bike we want, false otherwise
 */

/**
 * Scan for a single BLE device matching a filter using callback-based event listeners.
 * This version works reliably on Pi/noble combinations that don't emit discover events with async iterators.
 * 
 * How it works:
 * 1. Attach a listener for 'discover' events from noble
 * 2. Start scanning the BLE adapter (without awaiting)
 * 3. As devices broadcast their advertisements, check each one with the filter
 * 4. Return the first device that matches the filter
 * 5. Stop scanning when done
 *
 * @param {Noble} noble - instance of noble BLE library (from @abandonware/noble)
 * @param {string[]} serviceUuids - optional: only find devices advertising specific GATT services
 * @param {FilterFunction} filter - callback to identify the bike we're looking for
 * @param {object} [options] - optional scan configuration
 * @param {boolean} [options.allowDuplicates=true] - whether to emit duplicate advertisements
 * @returns {Peripheral} the matching device peripheral, or null if not found
 */
export async function scan(noble, serviceUuids, filter = () => true, options = {}) {
  const allowDuplicates = options.allowDuplicates !== false;
  let peripheral = null;
  let discoveryCount = 0;

  console.log(`[ble-scan] Starting BLE scan (allowDuplicates: ${allowDuplicates})`);

  return new Promise(async (resolve, reject) => {
    // Handler for discovery events
    const onDiscover = (result) => {
      discoveryCount++;
      const name = result?.advertisement?.localName || '(no name)';
      const addr = result?.address || 'unknown';

      // Log every 10th discovery to avoid spam
      if (discoveryCount === 1) {
        console.log(`[ble-scan] ✓ Discover events ARE firing! First device: ${name} [${addr}]`);
      } else if (discoveryCount % 10 === 1) {
        console.log(`[ble-scan] Discovery #${discoveryCount}: ${name} [${addr}]`);
      }

      if (filter(result)) {
        peripheral = result;
        console.log(`[ble-scan] ✓✓✓ MATCH FOUND after ${discoveryCount} discoveries: ${name} [${addr}]`);
        cleanup();
        resolve(peripheral);
      }
    };

    // Cleanup function
    const cleanup = async () => {
      noble.removeListener('discover', onDiscover);
      try {
        console.log(`[ble-scan] Stopping adapter scan...`);
        await noble.stopScanningAsync();
      } catch (err) {
        // Ignore stop errors
      }
    };

    try {
      // Attach listener BEFORE starting scan so we catch early discoveries
      console.log(`[ble-scan] Attaching discover event listener...`);
      noble.on('discover', onDiscover);

      // Start scanning (don't await - it may hang on some Pi/noble combinations)
      console.log(`[ble-scan] Starting noble.startScanningAsync (not awaited)...`);
      noble.startScanningAsync(serviceUuids, allowDuplicates)
        .then(() => console.log(`[ble-scan] ✓ startScanningAsync completed`))
        .catch((err) => console.error(`[ble-scan] ✗ startScanningAsync error: ${err.message}`));

      // Give scan a moment to start emitting events
      await new Promise(r => setTimeout(r, 100));
      
      if (discoveryCount === 0) {
        console.warn(`[ble-scan] ⚠ WARNING: No discover events after 100ms. Noble may not be emitting events.`);
        console.warn(`[ble-scan]   noble.state=${noble.state}, noble.scanning=${noble.scanning}`);
      }
      
      // Wait indefinitely for a match (app layer handles timeouts)
      console.log(`[ble-scan] Waiting for discover events...`);
      // Note: if no match is found, this promise never resolves and relies on app timeout
    } catch (err) {
      await cleanup();
      reject(err);
    }
  });
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
