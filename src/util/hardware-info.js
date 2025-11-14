import fs from 'fs';

const DEVICE_TREE_PATHS = [
  '/sys/firmware/devicetree/base/model',
  '/proc/device-tree/model'
];

const SINGLE_ADAPTER_ENV = 'GYMNASTICON_SINGLE_ADAPTER_HR';

// Boards whose built-in Bluetooth radios handle simultaneous scan + advertise
// reliably.  The original Pi Zero / Zero W remain excluded, and we now treat
// Pi Zero 2 W conservatively because older 5.10 kernels occasionally crash the
// Bluetooth stack when it tries to scan + advertise + connect at the same
// time.  Users can still force-enable single-adapter HR via the env override.
const SINGLE_ADAPTER_WHITELIST = [
  /raspberry pi 3/i,
  /raspberry pi 4/i,
  /raspberry pi 400/i,
  /raspberry pi compute module 4/i
];

let cachedBoardModel;

/**
 * Read the Raspberry Pi model string from the device tree (available on every
 * Pi OS build) so we can make hardware-specific decisions without asking the
 * user to pass extra CLI flags.  We cache the value because the string never
 * changes during the lifetime of the process.
 */
export function getBoardModel() {
  if (cachedBoardModel !== undefined) {
    return cachedBoardModel;
  }
  for (const path of DEVICE_TREE_PATHS) {
    try {
      const raw = fs.readFileSync(path, 'utf8');
      cachedBoardModel = raw.replace(/\0/g, '').trim();
      if (cachedBoardModel) {
        return cachedBoardModel;
      }
    } catch (error) {
      // Ignore ENOENT/EPERM/etc; we simply try the next candidate path.
    }
  }
  cachedBoardModel = null;
  return cachedBoardModel;
}

/**
 * Decide whether we trust a *single* adapter to handle combined scan +
 * advertise duties for the heart-rate bridge.  Returns a small descriptor so
 * callers can log the reasoning.
 */
export function isSingleAdapterMultiRoleCapable() {
  if (process.env[SINGLE_ADAPTER_ENV] === '1') {
    return {capable: true, reason: 'env-override', model: getBoardModel()};
  }
  const model = getBoardModel();
  if (!model) {
    return {capable: false, reason: 'unknown-board', model: null};
  }
  const capable = SINGLE_ADAPTER_WHITELIST.some(pattern => pattern.test(model));
  return {
    capable,
    reason: capable ? 'whitelist' : 'unsupported-board',
    model
  };
}
