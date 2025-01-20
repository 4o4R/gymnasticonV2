/**
 * Timestamped logger.
 */
export class Logger {
  constructor(cons = console) {
    this._cons = cons;
    this.debugEnabled = process.env.DEBUG === 'true';
  }

  log(...args) {
    return this._cons.log(this.prefix, ...args);
  }

  error(...args) {
    return this._cons.error(this.prefix, ...args);
  }

  debug(...args) {
    if (this.debugEnabled) {
      this._cons.debug(this.prefix, ...args);
    }
  }

  get prefix() {
    const time = new Date().toISOString();
    return `[${time}]`;
  }
}