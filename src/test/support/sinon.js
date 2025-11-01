import {createRequire} from 'module';

const require = createRequire(import.meta.url);

let fakeTimers;
try {
  fakeTimers = require('@sinonjs/fake-timers');
  if (fakeTimers && typeof fakeTimers === 'object' && 'default' in fakeTimers) {
    fakeTimers = fakeTimers.default;
  }
} catch (error) {
  throw new Error(
    "Cannot load the '@sinonjs/fake-timers' package. Install development dependencies first: npm install --include=dev"
  );
}

const SINON_COMPAT_METHODS = {
  setTimeout: true,
  clearTimeout: true,
  setInterval: true,
  clearInterval: true,
  setImmediate: true,
  clearImmediate: true,
  Date: true
};

const sinonShim = {
  useFakeTimers(options = {}) {
    const clock = fakeTimers.install({
      target: globalThis,
      toFake: Object.keys(SINON_COMPAT_METHODS),
      ...options
    });
    if (typeof clock.restore !== 'function') {
      clock.restore = clock.uninstall.bind(clock);
    }
    return clock;
  }
};

export default sinonShim;
