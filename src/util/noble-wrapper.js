export const initializeBluetooth = async (adapter = 'hci0') => {
  const noble = require('@abandonware/noble');
  
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
