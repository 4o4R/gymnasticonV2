/**
 * Lightweight fake-timer implementation used solely by the test suite.
 *
 * The original project depended on Sinon’s `useFakeTimers()` helper. Rather
 * than pulling in the entire Sinon bundle (which requires downloading from
 * npm during every install), this module re-implements the tiny subset of
 * behaviour our tests rely on:
 *
 *   - Faking `setTimeout` / `clearTimeout`
 *   - Faking `setInterval` / `clearInterval`
 *   - Faking `setImmediate` / `clearImmediate`
 *   - Overriding `Date` so that `Date.now()` reflects the simulated clock
 *
 * It provides the same public surface area that the tests expect: `tick`,
 * `tickAsync`, `runAll`, `runAllAsync`, and `restore` (with `uninstall` as an
 * alias).  The implementation is intentionally straightforward and heavily
 * commented to help readers understand the mechanics.
 */

const DEFAULT_METHODS = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'Date'
];

class SimpleFakeTimers {
  constructor(options = {}) {
    this.currentTime = Number.isFinite(options.now) ? Number(options.now) : 0;
    this.toFake = new Set(options.toFake ?? DEFAULT_METHODS);

    this.originals = {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      setImmediate: globalThis.setImmediate,
      clearImmediate: globalThis.clearImmediate,
      Date: globalThis.Date
    };

    this.nextId = 1;
    this.timers = new Map(); // id -> timer descriptor
    this.queue = [];         // timers sorted by firing time
    this.active = true;

    this.overrideTimers();
  }

  shouldFake(name) {
    return this.toFake.has(name);
  }

  overrideTimers() {
    const self = this;

    if (this.shouldFake('setTimeout')) {
      globalThis.setTimeout = function(callback, delay = 0, ...args) {
        return self.scheduleTimer('timeout', callback, delay, args);
      };
    }

    if (this.shouldFake('clearTimeout')) {
      globalThis.clearTimeout = function(id) {
        self.cancelTimer(id);
      };
    }

    if (this.shouldFake('setInterval')) {
      globalThis.setInterval = function(callback, interval = 0, ...args) {
        return self.scheduleTimer('interval', callback, interval, args);
      };
    }

    if (this.shouldFake('clearInterval')) {
      globalThis.clearInterval = function(id) {
        self.cancelTimer(id);
      };
    }

    if (this.shouldFake('setImmediate')) {
      globalThis.setImmediate = function(callback, ...args) {
        return self.scheduleTimer('timeout', callback, 0, args);
      };
    }

    if (this.shouldFake('clearImmediate')) {
      globalThis.clearImmediate = function(id) {
        self.cancelTimer(id);
      };
    }

    if (this.shouldFake('Date')) {
      const OriginalDate = this.originals.Date;
      const fakeTimersInstance = this;

      class FakeDate extends OriginalDate {
        // eslint-disable-next-line constructor-super
        constructor(...args) {
          if (args.length === 0) {
            super(fakeTimersInstance.currentTime);
          } else {
            super(...args);
          }
        }

        static now() {
          return fakeTimersInstance.currentTime;
        }
      }

      // Preserve static helpers such as Date.parse / Date.UTC.
      Object.getOwnPropertyNames(OriginalDate).forEach((name) => {
        if (typeof OriginalDate[name] === 'function' && !(name in FakeDate)) {
          FakeDate[name] = OriginalDate[name].bind(OriginalDate);
        }
      });

      globalThis.Date = FakeDate;
    }
  }

  scheduleTimer(kind, callback, delay, args) {
    const timer = {
      id: this.nextId++,
      type: kind, // 'timeout' or 'interval'
      callback,
      args,
      interval: kind === 'interval' ? Math.max(0, Number(delay) || 0) : null,
      time: this.currentTime + Math.max(0, Number(delay) || 0),
      active: true
    };

    this.timers.set(timer.id, timer);
    this.queue.push(timer);
    return timer.id;
  }

  cancelTimer(id) {
    const timer = this.timers.get(id);
    if (!timer) return;
    timer.active = false;
    this.timers.delete(id);
  }

  sortQueue() {
    // Drop inactive timers so the queue does not grow without bounds.
    this.queue = this.queue.filter(timer => timer.active);
    this.queue.sort((a, b) => {
      if (a.time === b.time) return a.id - b.id;
      return a.time - b.time;
    });
  }

  advanceTo(targetTime) {
    if (!this.active) return;

    if (targetTime < this.currentTime) {
      this.currentTime = targetTime;
      return;
    }

    while (true) {
      this.sortQueue();
      const next = this.queue[0];
      if (!next || next.time > targetTime) break;

      this.queue.shift(); // remove from queue
      if (!next.active) continue;

      this.currentTime = next.time;
      try {
        next.callback(...next.args);
      } finally {
        if (next.interval !== null && next.active) {
          // Reschedule intervals by pushing them back onto the queue.
          next.time += next.interval;
          this.queue.push(next);
        } else {
          next.active = false;
          this.timers.delete(next.id);
        }
      }
    }

    this.currentTime = targetTime;
  }

  tick(ms = 0) {
    const delta = Math.max(0, Number(ms) || 0);
    this.advanceTo(this.currentTime + delta);
  }

  async tickAsync(ms = 0) {
    this.tick(ms);
  }

  runAll() {
    if (!this.active) return;
    this.sortQueue();
    while (true) {
      const next = this.queue.find(timer => timer.active);
      if (!next) break;
      this.advanceTo(next.time);
    }
  }

  async runAllAsync() {
    this.runAll();
  }

  restore() {
    if (!this.active) return;
    this.active = false;

    if (this.shouldFake('setTimeout')) globalThis.setTimeout = this.originals.setTimeout;
    if (this.shouldFake('clearTimeout')) globalThis.clearTimeout = this.originals.clearTimeout;
    if (this.shouldFake('setInterval')) globalThis.setInterval = this.originals.setInterval;
    if (this.shouldFake('clearInterval')) globalThis.clearInterval = this.originals.clearInterval;
    if (this.shouldFake('setImmediate')) globalThis.setImmediate = this.originals.setImmediate;
    if (this.shouldFake('clearImmediate')) globalThis.clearImmediate = this.originals.clearImmediate;
    if (this.shouldFake('Date')) globalThis.Date = this.originals.Date;

    this.queue = [];
    this.timers.clear();
  }

  uninstall() {
    this.restore();
  }
}

const sinonShim = {
  useFakeTimers(options = {}) {
    return new SimpleFakeTimers(options);
  }
};

export default sinonShim;
