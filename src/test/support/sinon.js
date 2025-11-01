import {createRequire} from 'module';

/**
 * We load @sinonjs/fake-timers from CommonJS land while keeping the rest of
 * the project in ESM. The createRequire helper gives us a genuine `require`
 * that resolves relative to this helper module – exactly what we need for
 * tests to run under Node’s native ESM loader.
 */
const require = createRequire(import.meta.url);

let fakeTimersLib;
try {
  fakeTimersLib = require('@sinonjs/fake-timers');
  // The library exposes a default export when bundled for ESM consumers.
  if (fakeTimersLib && typeof fakeTimersLib === 'object' && 'default' in fakeTimersLib) {
    fakeTimersLib = fakeTimersLib.default;
  }
} catch (error) {
  throw new Error(
    "Cannot load the '@sinonjs/fake-timers' package. Install development dependencies first: npm install --include=dev"
  );
}

/**
 * This is the set of global timer APIs the old Sinon shim faked for us.
 * Using an explicit array lets readers see exactly what is being replaced,
 * and makes future adjustments predictable.
 */
const SINON_COMPAT_METHODS = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'Date'
];

const sinonShim = {
  /**
   * Drop-in replacement for Sinon’s historic `useFakeTimers`.
   * We build a configured installer with `withGlobal(globalThis)` to avoid the
   * deprecated `target` option, then expose the familiar clock object.
   */
  useFakeTimers(options = {}) {
    const builder = fakeTimersLib
      .withGlobal(globalThis)
      .withFakedTimers({
        toFake: SINON_COMPAT_METHODS,
        ...options
      });

    const clock = builder.install();

    // Legacy Sinon returned a `clock.restore()` helper. Modern fake-timers
    // calls this `uninstall()`, so we polyfill the old name for our tests.
    if (typeof clock.restore !== 'function') {
      clock.restore = clock.uninstall.bind(clock);
    }

    return clock;
  }
};

export default sinonShim;
