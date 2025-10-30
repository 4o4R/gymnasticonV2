import {createRequire} from 'module';

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
  const requireFromCaller = createRequire(meta.url);
  try {
    return requireFromCaller(request);
  } catch (error) {
    if (!fallbackRelative) {
      throw error;
    }
    return requireFromCaller(fallbackRelative);
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
