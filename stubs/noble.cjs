const {EventEmitter} = require('events');

class NobleStub extends EventEmitter {
  constructor() {
    super();
    this.state = 'poweredOn'; // Pretend the adapter is ready immediately
    process.nextTick(() => this.emit('stateChange', 'poweredOn')); // Trigger the state change event so awaiters proceed
  }

  async startScanningAsync() { /* no-op stub */ }
  async stopScanningAsync() { /* no-op stub */ }
  disconnect() { /* no-op stub */ }
}

module.exports = new NobleStub();
module.exports.__isStub = true;
