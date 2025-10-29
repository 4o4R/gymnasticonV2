import {EventEmitter} from 'events';

class BlenoStub extends EventEmitter {
  constructor() {
    super();
    this.state = 'poweredOff';
  }
  startAdvertising(name, uuids) {}
  startAdvertisingWithEIRData(advertisementData, scanData, callback) {
    if (callback) callback();
  }
  stopAdvertising() {}
  setServices(services) {}
  disconnect() {}
}

class Characteristic {
  constructor(opts) { Object.assign(this, opts); }
  async subscribeAsync() {}
  updateValue() {}
}
class Descriptor {
  constructor(opts) { Object.assign(this, opts); }
}
class PrimaryService {
  constructor(opts) { Object.assign(this, opts); }
}

const bleno = new BlenoStub();
export default bleno;
export {Characteristic, Descriptor, PrimaryService};
