import {EventEmitter} from 'events';
import {loadDependency, toDefaultExport} from './optional-deps.js';

export const initializeBluetooth = async (adapter = 'hci0') => {
  const nobleModule = loadDependency('@abandonware/noble', '../stubs/noble.cjs', import.meta);
  const usingStub = Boolean(nobleModule && nobleModule.__isStub);
  let noble = toDefaultExport(nobleModule);

  if (usingStub) {
    console.warn('Using stub noble module - BLE not available');
    if (!(noble instanceof EventEmitter)) {
      const emitter = new EventEmitter();
      emitter.state = 'poweredOff';
      emitter.startScanningAsync = async () => {};
      emitter.stopScanningAsync = async () => {};
      emitter.disconnect = () => {};
      noble = emitter;
    } else {
      noble.state = noble.state || 'poweredOff';
      noble.startScanningAsync = noble.startScanningAsync || (async () => {});
      noble.stopScanningAsync = noble.stopScanningAsync || (async () => {});
      noble.disconnect = noble.disconnect || (() => {});
    }
  }
  
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
