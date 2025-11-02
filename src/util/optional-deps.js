import {createRequire} from 'module'; // allow CommonJS-style requires inside ES modules
import path from 'path'; // use path helpers to assemble an absolute fallback path when relative resolution fails

/**
 * Try to resolve a module from the current file. If it is not available,
 * fall back to the provided relative stub path.
 *
 * @param {string} request - The module specifier to require.
 * @param {string|undefined} fallbackRelative - Relative path to fallback stub.
 * @param {ImportMeta} meta - Caller import.meta for resolution context.
 * @returns {*}
 */
export function loadDependency(request, fallbackRelative, meta) {
  const requireFromCaller = createRequire(meta.url); // create a require function scoped to the caller's location
  try {
    return requireFromCaller(request); // prefer the real dependency when it is installed
  } catch (error) {
    if (!fallbackRelative) {
      throw error; // rethrow immediately when no stub fallback is provided
    }
    try {
      return requireFromCaller(fallbackRelative); // first attempt to load the caller-specified fallback relative path
    } catch (fallbackError) {
      const fallbackFile = path.basename(fallbackRelative); // extract just the file name so we can search the shared stubs directory
      const stubCandidate = path.join(process.cwd(), 'stubs', fallbackFile); // build an absolute path to the common stubs folder at the project root
      return requireFromCaller(stubCandidate); // try to require the stub using the absolute path; bubble up any failure to keep the original stack trace
    }
  }
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
