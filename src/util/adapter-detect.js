// Detect available Bluetooth adapters and ANT+ sticks so the CLI can auto-configure itself on Pi hardware.

import {execSync} from 'child_process';
import fs from 'fs';
import path from 'path';

const BLUETOOTH_SYSFS = '/sys/class/bluetooth';

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
      try {
        modalias = fs.readFileSync(path.join(node, 'device', 'modalias'), 'utf8').trim();
      } catch (error) {
        // ignore missing modalias
      }
      let type = 'unknown';
      if (modalias.startsWith('usb:')) {
        type = 'usb';
      } else if (modalias.startsWith('platform:') || modalias.startsWith('brcm:') || modalias.startsWith('sdio:')) {
        type = 'builtin';
      }
      return { name, type, modalias };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
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
  summary.adapters = adapters.map(a => a.name);

  const builtin = adapters.filter((adapter) => adapter.type === 'builtin');
  const usb = adapters.filter((adapter) => adapter.type === 'usb');
  // Teaching note: use the *actual* adapter count to decide dual-mode behavior
  // so every board listed in the README (Pi 3/4/400/CM4/Zero 2/5, etc.) can
  // benefit from a second radio when it is physically present.
  const allowDual = adapters.length >= 2;

  if (builtin.length >= 1) {
    summary.bikeAdapter = builtin[0].name;
    summary.serverAdapter = allowDual && (usb[0]?.name || builtin[1]?.name) ? (usb[0]?.name || builtin[1]?.name) : builtin[0].name;
  } else if (usb.length >= 1) {
    summary.bikeAdapter = usb[0].name;
    summary.serverAdapter = allowDual && usb[1]?.name ? usb[1].name : usb[0].name;
  }
  if (allowDual) {
    summary.multiAdapter = true;
  }

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
