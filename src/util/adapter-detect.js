// Detect available Bluetooth adapters and ANT+ sticks so the CLI can auto-configure itself on Pi hardware.

import {execSync} from 'child_process';
import fs from 'fs';
import path from 'path';

const BLUETOOTH_SYSFS = '/sys/class/bluetooth';
const MODEL_PATH = '/proc/device-tree/model';

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
  const allowDual = allowMultiAdapterBoards();

  if (builtin.length >= 1) {
    summary.bikeAdapter = builtin[0].name;
    summary.serverAdapter = allowDual && (usb[0]?.name || builtin[1]?.name) ? (usb[0]?.name || builtin[1]?.name) : builtin[0].name;
  } else if (usb.length >= 1) {
    summary.bikeAdapter = usb[0].name;
    summary.serverAdapter = allowDual && usb[1]?.name ? usb[1].name : usb[0].name;
  }
  if (allowDual && adapters.length >= 2) {
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

function allowMultiAdapterBoards() {
  try {
    const model = fs.readFileSync(MODEL_PATH, 'utf8').toLowerCase();
    // Models known to expose stable dual-HCI setups on Buster when BlueZ/firmware are refreshed.
    // Example strings:
    //   "Raspberry Pi Zero 2 W Rev 1.0"
    //   "Raspberry Pi 3 Model B Rev 1.2"
    //   "Raspberry Pi 4 Model B Rev 1.4"
    return model.includes('raspberry pi 4') ||
           model.includes('raspberry pi 3') ||
           model.includes('raspberry pi zero 2');
  } catch (_) {
    return false;
  }
}
