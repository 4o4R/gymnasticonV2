// Detect available Bluetooth adapters and ANT+ sticks so the CLI can auto-configure itself on Pi hardware.

import {execSync} from 'child_process'; // Use synchronous exec to keep the function side-effect free and deterministic.

export function detectAdapters() { // Return a summary describing which adapters should be used for bike/server roles and whether ANT+ is available.
  const summary = { // Seed the return object with conservative defaults that work on single-adapter setups.
    bikeAdapter: 'hci0', // Assume the first HCI interface drives the bike connection unless we detect otherwise.
    serverAdapter: 'hci0', // Default the BLE server to the same adapter so single-radio Pi setups still work.
    antPresent: false, // Assume no ANT+ stick until we see a known USB identifier.
    adapters: [], // Record every discovered adapter so other subsystems (e.g., HR auto-enable) can gauge hardware capability.
  };

  try { // Wrap detection in a try/catch so missing tools do not crash headless installs.
    const hciconfig = execSync('hciconfig -a', { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); // Query BlueZ for all available HCI interfaces.
    const matches = Array.from(hciconfig.matchAll(/\bhci(\d+):/g)).map(match => Number(match[1])).sort((a, b) => a - b); // Extract adapter indices and sort them numerically.
    summary.adapters = matches.map(index => `hci${index}`); // Expose the entire list (e.g., ["hci0","hci1"]) for downstream heuristics.
    if (matches.length >= 2) { // When two or more adapters exist pick a dedicated role for each.
      summary.bikeAdapter = `hci${matches[0]}`; // Use the lowest-index adapter for the bike (often the onboard radio).
      summary.serverAdapter = `hci${matches[1]}`; // Use the next adapter for advertising to apps (often a USB dongle).
    } else if (matches.length === 1) { // With a single adapter we simply share it between roles.
      summary.bikeAdapter = `hci${matches[0]}`; // Explicitly set to whichever index BlueZ exposed.
      summary.serverAdapter = summary.bikeAdapter; // Mirror the same adapter for the server path.
    }
  } catch (error) {
    // If hciconfig is missing or fails we keep the conservative defaults and let the app proceed.
  }

  try { // Run lsusb to discover common ANT+ stick vendor/product IDs.
    const usb = execSync('lsusb', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().toLowerCase(); // Enumerate USB devices and normalize to lowercase for regex matching.
    summary.antPresent = /\b0fcf:10(06|08|09)\b/.test(usb); // Garmin USB-M sticks report these VID:PID combinations; mark presence when found.
  } catch (error) {
    // Missing lsusb is fine; we simply leave antPresent as false and allow manual overrides.
  }

  return summary; // Hand the calling code the detection results (or defaults when detection failed).
}
