const {EventEmitter} = require('events');

class BlenoStub extends EventEmitter {
  constructor() {
    super();
    this.state = 'poweredOn'; // Pretend the adapter is ready immediately
    process.nextTick(() => this.emit('stateChange', 'poweredOn')); // Notify listeners that the adapter is "powered on"
  }

  startAdvertising() { /* no-op stub */ }
  startAdvertisingWithEIRData(_advertisementData, _scanData, callback) {
    if (callback) callback();
  }
  async startAdvertisingAsync() { /* no-op stub */ }
  stopAdvertising() { /* no-op stub */ }
  async stopAdvertisingAsync() { /* no-op stub */ }
  setServices() { /* no-op stub */ }
  async setServicesAsync() { /* no-op stub */ }
  disconnect() { /* no-op stub */ }
}

class Characteristic {
  constructor(opts) {
    Object.assign(this, opts);
  }
  async subscribeAsync() {}
  updateValue() {}
}

class Descriptor {
  constructor(opts) {
    Object.assign(this, opts);
  }
}

class PrimaryService {
  constructor(opts) {
    Object.assign(this, opts);
  }
}

const bleno = new BlenoStub();
module.exports = bleno;
module.exports.Characteristic = Characteristic;
module.exports.Descriptor = Descriptor;
module.exports.PrimaryService = PrimaryService;
module.exports.__isStub = true;
