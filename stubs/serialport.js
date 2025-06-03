import {EventEmitter} from 'events';

export default class SerialPort extends EventEmitter {
  constructor(path, opts) {
    super();
    this.path = path;
    this.opts = opts;
  }
  open(callback) { if (callback) callback(); }
  close(callback) { if (callback) callback(); }
  write() {}
}
