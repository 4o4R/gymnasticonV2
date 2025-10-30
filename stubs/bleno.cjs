const {EventEmitter} = require('events');

class BlenoStub extends EventEmitter {
  constructor() {
    super();
    this.state = 'poweredOff';
  }

  startAdvertising() {}
  startAdvertisingWithEIRData(_advertisementData, _scanData, callback) {
    if (callback) callback();
  }
  stopAdvertising() {}
  setServices() {}
  disconnect() {}
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
