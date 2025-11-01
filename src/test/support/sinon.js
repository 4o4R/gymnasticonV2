import {createRequire} from 'module';

/**
 * We keep our codebase in ECMAScript Module mode (“type”: “module” in
 * package.json). The test helpers, however, still need to consume some CommonJS
 * packages. `createRequire` gives us a scoped `require()` that works from
 * an ESM context, making the interop painless.
 */
const require = createRequire(import.meta.url);

let fakeTimersLib;
try {
  fakeTimersLib = require('@sinonjs/fake-timers');
  // When the package exposes an ESM default export we pick it up here.
  if (fakeTimersLib && typeof fakeTimersLib === 'object' && 'default' in fakeTimersLib) {
    fakeTimersLib = fakeTimersLib.default;
  }
} catch (error) {
  throw new Error(
    "Cannot load the '@sinonjs/fake-timers' package. Install development dependencies first: npm install --include=dev"
  );
}

/**
 * Sinon historically faked this set of global timer APIs. Listing them explicitly
 * makes it obvious to learners what “fake timers” actually means.
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
   * Drop-in replacement for Sinon’s classic `useFakeTimers()`.
   *
   * Modern versions of @sinonjs/fake-timers expect you to call `install()` with
   * the options you care about. The global object defaults to `globalThis`,
   * so we simply pass the list of APIs we want to fake along with any user
   * overrides.
   */
  useFakeTimers(options = {}) {
    // Copy the options so we can safely delete unsupported properties.
    const sanitizedOptions = {...options};
    delete sanitizedOptions.target; // removed in fake-timers v11

    // If the caller did not request a custom set of APIs, fall back to the
    // list of globals Sinon historically faked.
    if (!Object.prototype.hasOwnProperty.call(sanitizedOptions, 'toFake')) {
      sanitizedOptions.toFake = SINON_COMPAT_METHODS;
    }

    const clock = fakeTimersLib.install(sanitizedOptions);

    /**
     * Older Sinon versions returned a clock with `restore()`. The modern library
     * renamed that to `uninstall()`. We alias the old name so existing tests
     * (and readers following historic tutorials) continue to work.
     */
    if (typeof clock.restore !== 'function') {
      clock.restore = clock.uninstall.bind(clock);
    }

    /**
     * Newer fake-timer APIs expose async helpers (`tickAsync`, `runAllAsync`).
     * When running on older releases we polyfill these methods so the rest of
     * the test suite can `await` them without worrying about version details.
     */
    if (typeof clock.tickAsync !== 'function') {
      clock.tickAsync = async (ms = 0) => clock.tick(ms);
    }
    if (typeof clock.runAllAsync !== 'function') {
      clock.runAllAsync = async () => clock.runAll();
    }

    return clock;
  }
};

export default sinonShim;
