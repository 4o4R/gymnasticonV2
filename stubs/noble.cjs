const {EventEmitter} = require('events');

class NobleStub extends EventEmitter {
  constructor() {
    super();
    this.state = 'poweredOff';
  }

  async startScanningAsync() {}
  async stopScanningAsync() {}
  disconnect() {}
}

module.exports = new NobleStub();
module.exports.__isStub = true;
