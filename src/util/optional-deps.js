import {createRequire} from 'module'; // allow CommonJS-style requires inside ES modules
import path from 'path'; // use path helpers to assemble an absolute fallback path when relative resolution fails

const STUB_MARKER = '__isStub'; // property every bundled stub sets so callers can tell a stub from the real module
const stubLoads = []; // record of module requests answered by a stub, for diagnostics and tests

/**
 * Decide whether swapping a real native module for a development stub is
 * acceptable on this host.
 *
 * Teaching note: substituting a stub is only safe when it is deliberate. A
 * production host that fails to load its native module must surface the error
 * instead of advertising a healthy service that quietly does nothing.
 *
 * @param {{env?: object, platform?: string}} [options] - Overrides used by tests.
 * @returns {boolean}
 */
export function stubsPermitted(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  if (env.GYMNASTICON_ALLOW_STUBS === '1') {
    return true; // explicit opt-in always wins
  }
  if (env.NODE_ENV === 'test') {
    return true; // the automated test suite intentionally runs against stubs
  }
  return platform === 'win32'; // the pinned native stack cannot be built on Windows development hosts
}

/**
 * List the module requests that were answered with a stub.
 *
 * @returns {Array<{request: string, stub: string}>}
 */
export function listStubLoads() {
  return stubLoads.slice();
}

/**
 * Try to resolve a module from the current file. If it is not available and
 * stubs are permitted on this host, fall back to the provided relative stub
 * path. Otherwise the original load failure is rethrown with an actionable
 * message so a missing native dependency is never hidden behind a stub.
 *
 * @param {string} request - The module specifier to require.
 * @param {string|undefined} fallbackRelative - Relative path to fallback stub.
 * @param {ImportMeta} meta - Caller import.meta for resolution context.
 * @param {{env?: object, platform?: string, logger?: Function|{warn?: Function}}} [options] - Overrides used by tests.
 * @returns {*}
 */
export function loadDependency(request, fallbackRelative, meta, options = {}) {
  const requireFromCaller = createRequire(meta.url); // create a require function scoped to the caller's location
  try {
    return requireFromCaller(request); // prefer the real dependency when it is installed
  } catch (error) {
    if (!fallbackRelative) {
      throw error; // rethrow immediately when no stub fallback is provided
    }
    if (!stubsPermitted(options)) {
      throw describeNativeLoadFailure(error, request); // production hosts must never receive a fake module
    }
    const stub = loadStub(requireFromCaller, fallbackRelative);
    markStub(stub);
    stubLoads.push({request, stub: path.basename(fallbackRelative)});
    warnStubInUse(fallbackRelative, request, options);
    return stub;
  }
}

function loadStub(requireFromCaller, fallbackRelative) {
  try {
    return requireFromCaller(fallbackRelative); // first attempt to load the caller-specified fallback relative path
  } catch (_fallbackError) {
    const fallbackFile = path.basename(fallbackRelative); // extract just the file name so we can search the shared stubs directory
    const stubCandidate = path.join(process.cwd(), 'stubs', fallbackFile); // build an absolute path to the common stubs folder at the project root
    return requireFromCaller(stubCandidate); // try to require the stub using the absolute path; bubble up any failure to keep the original stack trace
  }
}

function markStub(stub) {
  if (!stub || (typeof stub !== 'object' && typeof stub !== 'function')) {
    return;
  }
  if (stub[STUB_MARKER]) {
    return;
  }
  try {
    stub[STUB_MARKER] = true; // make replaced dependencies detectable by callers and health checks
  } catch (_error) {
    // Frozen module exports cannot be marked; the warning below still names what happened.
  }
}

function warnStubInUse(fallbackRelative, request, options) {
  const message = `[gymnasticon] NATIVE DEPENDENCY FALLBACK: could not load "${request}"; using the development stub ${path.basename(fallbackRelative)}. ` +
    'The affected feature will report success while doing nothing - do not run this in production.';
  const logger = options.logger;
  if (typeof logger === 'function') {
    logger(message);
    return;
  }
  if (logger && typeof logger.warn === 'function') {
    logger.warn(message);
    return;
  }
  console.warn(message); // eslint-disable-line no-console
}

function describeNativeLoadFailure(error, request) {
  const originalMessage = error && error.message ? error.message : String(error);
  const message = `Failed to load native dependency "${request}": ${originalMessage}. ` +
    'The native module is required in production but could not be loaded (usually a Node ABI/version mismatch or missing system libraries). ' +
    'Rebuild it (npm rebuild) and retry. To deliberately run against the bundled stubs, set GYMNASTICON_ALLOW_STUBS=1.';
  if (error && typeof error === 'object') {
    try {
      if (error.originalMessage === undefined) {
        error.originalMessage = originalMessage; // keep the raw failure visible for diagnostics
      }
      error.message = message;
      return error; // surface the original error object with an actionable message
    } catch (_error) {
      // Some errors expose read-only properties; fall back to a wrapper below.
    }
  }
  const wrapped = new Error(message);
  wrapped.cause = error;
  return wrapped;
}

/**
 * Normalize CommonJS and ESM default exports.
 *
 * @param {*} moduleExports
 * @returns {*}
 */
export function toDefaultExport(moduleExports) {
  if (moduleExports && typeof moduleExports === 'object' && 'default' in moduleExports) {
    return moduleExports.default;
  }
  return moduleExports;
}
