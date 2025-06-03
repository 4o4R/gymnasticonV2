import {EventEmitter} from 'events';

class NobleStub extends EventEmitter {
  constructor() {
    super();
    this.state = 'poweredOff';
  }
  async startScanningAsync() {}
  async stopScanningAsync() {}
  disconnect() {}
}

export default new NobleStub();
