import {EventEmitter} from 'events';
import {createRequire} from 'module';

export const initializeBluetooth = async (adapter = 'hci0') => {
  const require = createRequire(import.meta.url);
  let noble;
  try {
    noble = require('@abandonware/noble');
  } catch (err) {
    console.warn('Using stub noble module - BLE not available');
    noble = new EventEmitter();
    noble.state = 'poweredOff';
    noble.startScanning = () => {};
    noble.startScanningAsync = async () => {};
    noble.stopScanning = () => {};
  }
  
  // Modern bluetooth initialization
  noble.on('stateChange', (state) => {
    if (state === 'poweredOn') {
      noble.startScanning([], true);
    }
  });

  // Add retry logic for robust connections
  const connect = async (peripheral, retries = 3) => {
    for (let i = 0; i < retries; i++) {
      try {
        await peripheral.connectAsync();
        return true;
      } catch (err) {
        if (i === retries - 1) throw err;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  };

  return { noble, connect };
};
