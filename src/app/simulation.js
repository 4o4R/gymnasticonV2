import {EventEmitter} from 'events';

/**
 * Emit pedal stroke events at a rate that matches the given target cadence.
 * The target cadence can be updated on-the-fly.
 */
export class Simulation extends EventEmitter {
  constructor() {
    super();
    this._cadence = 0;
    this._interval = Infinity;
    this._lastPedalTime = -Infinity;
    this._timeoutId = null;
    this._stopped = false;
  }

  /**
   * Set the target cadence and (re)arm the pedal emitter.
   * @param {number} cadence - the target cadence in rpm.
   */
  set cadence(x) {
    this.applyCadence(x, !this._stopped);
  }

  /**
   * Get the current target cadence (rpm).
   */
  get cadence() {
    return this._cadence;
  }

  /**
   * True once stop() has latched the emitter off.
   */
  get stopped() {
    return this._stopped;
  }

  /**
   * Record a cadence without arming the pedal timer.
   *
   * Teaching note: real bike telemetry also reports cadence, but mirroring it
   * must not start the synthetic pedal emitter - that is what kept firing pedal
   * strokes (and re-broadcasting telemetry) during normal riding.
   * @param {number} cadence - the reported cadence in rpm.
   */
  mirrorCadence(cadence) {
    this.applyCadence(cadence, false);
  }

  /**
   * Re-arm the pedal emitter after a stop().
   */
  start() {
    this._stopped = false;
    this.applyCadence(this._cadence, true);
  }

  /**
   * Stop the pedal emitter and reset its timing state.
   * Safe to call repeatedly.
   */
  stop() {
    this._stopped = true;
    this._cadence = 0;
    this._interval = Infinity;
    this._lastPedalTime = -Infinity;
    if (this._timeoutId) {
      clearTimeout(this._timeoutId);
      this._timeoutId = null;
    }
  }

  /**
   * Handle a pedal event.
   * @emits Simulation#pedal
   * @private
   */
  onPedal(timestamp) {
    if (this._stopped) {
      return;
    }
    this._lastPedalTime = Number.isFinite(timestamp) ? timestamp : Date.now();
    /**
     * Pedal event.
     * @event Simulation#pedal
     * @type {number} timestamp - timestamp (ms) of this pedal event
     */
    this.emit('pedal', this._lastPedalTime);
  }

  /**
   * Apply a cadence value, optionally scheduling the next pedal event.
   * @param {number} cadence - target cadence in rpm.
   * @param {boolean} schedule - whether the pedal emitter should run.
   * @private
   */
  applyCadence(cadence, schedule) {
    this._cadence = cadence;
    this._interval = cadence > 0 ? 1000 * (60 / this._cadence) : Infinity;
    if (this._timeoutId) {
      clearTimeout(this._timeoutId);
      this._timeoutId = null;
    }
    if (schedule) {
      this.schedulePedal();
    }
  }

  /**
   * Schedule the next pedal event according to the target cadence.
   * @private
   */
  schedulePedal() {
    if (this._stopped || this._interval === Infinity) return;

    let now = Date.now();
    let timeSinceLast = now - this._lastPedalTime;
    let timeUntilNext = Math.max(0, this._interval - timeSinceLast);
    let nextPedalTime = now + timeUntilNext;
    this._timeoutId = setTimeout(() => {
      this._timeoutId = null;
      this.onPedal(nextPedalTime);
      this.schedulePedal();
    }, timeUntilNext);
  }
}
