// Detect available Bluetooth adapters and ANT+ sticks so the CLI can auto-configure itself on Pi hardware.

import {execSync} from 'child_process';
import fs from 'fs';
import path from 'path';

const BLUETOOTH_SYSFS = '/sys/class/bluetooth';
const HCI_VERSION_REGEX = /HCI Version:\s*(?:0x([0-9a-f]+)|(\d+))/i;

function discoverAdapters() {
  if (!fs.existsSync(BLUETOOTH_SYSFS)) {
    return [];
  }
  return fs
    .readdirSync(BLUETOOTH_SYSFS)
    .filter((name) => name.startsWith('hci'))
    .map((name) => {
      const node = path.join(BLUETOOTH_SYSFS, name);
      let modalias = '';
      let devicePath = '';
      try {
        modalias = fs.readFileSync(path.join(node, 'device', 'modalias'), 'utf8').trim();
      } catch (error) {
        // ignore missing modalias
      }
      try {
        devicePath = fs.realpathSync(path.join(node, 'device'));
      } catch (error) {
        // ignore missing device symlink
      }
      let type = 'unknown';
      const lowerModalias = modalias.toLowerCase();
      const lowerDevicePath = devicePath.toLowerCase();
      if (lowerModalias.startsWith('usb:') || lowerDevicePath.includes('/usb')) {
        type = 'usb';
      } else if (
        lowerModalias.startsWith('platform:') ||
        lowerModalias.startsWith('brcm:') ||
        lowerModalias.startsWith('sdio:') ||
        lowerModalias.startsWith('of:') ||
        lowerDevicePath
      ) {
        type = 'builtin';
      }
      return { name, type, modalias, devicePath };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function bringUpAdapters(adapters) {
  adapters.forEach(({ name }) => {
    try {
      execSync(`hciconfig ${name} up`, { stdio: 'ignore' });
    } catch (_) {
      // ignore failures so detection keeps running
    }
  });
}

export function detectAdapters() {
  const summary = {
    bikeAdapter: 'hci0',
    serverAdapter: 'hci0',
    antPresent: false,
    multiAdapter: false,
    adapters: [],
  };

  const adapters = discoverAdapters();
  bringUpAdapters(adapters);
  Object.assign(summary, chooseAdapterRoles(adapters));

  try {
    const usbList = execSync('lsusb', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .toLowerCase();
    summary.antPresent = /\b0fcf:10(06|08|09)\b/.test(usbList);
  } catch (_error) {
    // leave antPresent false if lsusb fails.
  }

  return summary;
}

export function chooseAdapterRoles(adapters = []) {
  const summary = {
    bikeAdapter: 'hci0',
    serverAdapter: 'hci0',
    multiAdapter: false,
    adapters: adapters.map(a => a.name).filter(Boolean),
  };

  const candidates = adapters.filter((adapter) => adapter?.name);
  const nonUsb = candidates.filter((adapter) => adapter.type !== 'usb');
  const usb = candidates.filter((adapter) => adapter.type === 'usb');
  const allowDual = candidates.length >= 2;

  // Pi onboard UART radios do not always expose a useful modalias. Treat any
  // non-USB controller as the preferred bike scanner, then put USB radios on
  // BLE advertising where possible.
  if (nonUsb.length >= 1) {
    summary.bikeAdapter = nonUsb[0].name;
    summary.serverAdapter = allowDual && (usb[0]?.name || nonUsb[1]?.name)
      ? (usb[0]?.name || nonUsb[1]?.name)
      : nonUsb[0].name;
  } else if (usb.length >= 1) {
    summary.bikeAdapter = usb[0].name;
    summary.serverAdapter = allowDual && usb[1]?.name ? usb[1].name : usb[0].name;
  }
  summary.multiAdapter = allowDual;

  return summary;
}

export function getHciVersion(adapterName) {
  // Teaching note: `hciconfig -a` prints the controller's HCI version, which
  // is a quick proxy for BLE feature support (extended scan needs 5.0+).
  if (!adapterName) {
    return null;
  }
  try {
    const output = execSync(`hciconfig -a ${adapterName}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString();
    const match = output.match(HCI_VERSION_REGEX);
    if (!match) {
      return null;
    }
    // hciconfig prints the HCI version code in either hex ("0x0b (11)") or
    // decimal ("9 (0x09)") form depending on the BlueZ build; parse both.
    const version = match[1] !== undefined ? parseInt(match[1], 16) : Number(match[2]);
    return Number.isFinite(version) ? version : null;
  } catch (_error) {
    return null; // If hciconfig is missing or fails, treat version as unknown.
  }
}

export function supportsExtendedScan(adapterName) {
  // Teaching note: Extended scanning is a Bluetooth 5.0+ feature, so only
  // enable it when the controller advertises HCI version >= 9 (BLE 5.0).
  const version = getHciVersion(adapterName);
  if (version === null) {
    return { supported: false, version: null, reason: 'unknown-version' };
  }
  const supported = version >= 9;
  return {
    supported,
    version,
    reason: supported ? 'hci-5-plus' : 'hci-legacy'
  };
}
