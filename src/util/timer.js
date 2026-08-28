import {EventEmitter} from 'events';

/**
 * Emit an event after the specified time interval. One-shot or repeated.
 */
export class Timer extends EventEmitter {
  /**
   * Create a Timer instance.
   * @param {number} interval - time until expires in seconds
   * @param {object} options
   * @param {boolean} [options.repeats=true] - restart the timer each time it expires
   * @param {boolean} [options.immediate=false] - fire the first tick immediately on the first reset
   */
  constructor(interval, { repeats = true, immediate = false }={}) {
    super();
    this._interval = interval;
    this._repeats = repeats;
    this._immediate = immediate;
    this._everStarted = false;
    this._timeout = null;
    this.onExpire = this.onExpire.bind(this);
  }

  /**
   * Get the current interval (seconds).
   */
  get interval() {
    return this._interval;
  }

  /**
   * Reset the timer.
   */
  reset() {
    this.clearTimeout();
    if (!Number.isFinite(this._interval) || this._interval <= 0) {
      this._timeout = null;
      return;
    }
    // Teaching note: with immediate, the very first tick fires right away
    // (e.g. so the ANT+ broadcaster sends data as soon as it starts instead
    // of waiting a full interval); subsequent repeats use the normal delay.
    const delay = this._immediate && !this._everStarted ? 0 : this._interval * 1000;
    this._everStarted = true;
    this._timeout = setTimeout(this.onExpire, delay);
  }

  /**
   * Cancel the timer.
   */
  cancel() {
    this.clearTimeout();
  }

  /**
   * Handle timer expiry.
   * @emits Timer#timeout
   * @private
   */
  onExpire() {
    /**
     * Timeout event.
     * @event Timer#timeout
     */
    try {
      this.emit('timeout', this._interval);
    } finally {
      // Teaching note: a throwing listener must not kill a repeating timer;
      // schedule the next tick regardless so the loop stays alive.
      if (this._repeats) {
        this.reset();
      }
    }
  }

  /**
   * Clear internal timer.
   * @private
   */
  clearTimeout() {
    if (this._timeout) {
      clearTimeout(this._timeout);
      this._timeout = null;
    }
  }
}
