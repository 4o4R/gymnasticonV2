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
    // Merge caller-provided settings while ensuring our defaults stay in place.
    const clock = fakeTimersLib.install({
      toFake: options.toFake ?? SINON_COMPAT_METHODS,
      ...options,
      // The “target” property was removed in v11, so we avoid passing it even if
      // callers accidentally provide one.
    });

    /**
     * Older Sinon versions returned a clock with `restore()`. The modern library
     * renamed that to `uninstall()`. We alias the old name so existing tests
     * (and readers following historic tutorials) continue to work.
     */
    if (typeof clock.restore !== 'function') {
      clock.restore = clock.uninstall.bind(clock);
    }

    return clock;
  }
};

export default sinonShim;
