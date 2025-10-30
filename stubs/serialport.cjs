const {EventEmitter} = require('events');

class SerialPortStub extends EventEmitter {
  constructor(path, opts) {
    super();
    this.path = path;
    this.opts = opts;
    this.isOpen = false;
  }

  open(callback) {
    this.isOpen = true;
    if (callback) callback();
  }

  close(callback) {
    this.isOpen = false;
    if (callback) callback();
  }

  write(_data, callback) {
    if (callback) callback();
  }

  drain(callback) {
    if (callback) callback();
  }
}

module.exports = SerialPortStub;
module.exports.__isStub = true;
