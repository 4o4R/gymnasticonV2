import fs from 'fs';

/**
 * Teaching note:
 *   Pi images often need to reason about hardware capability.  Instead of
 *   sprinkling `/proc` reads everywhere we centralize that probing logic here
 *   so other modules can ask high-level questions like “am I on a Pi Zero?”
 */

const MODEL_PATHS = [
  '/proc/device-tree/model',
  '/sys/firmware/devicetree/base/model',
];

/**
 * Attempt to read the board model string reported by the Linux device tree.
 * Returns `undefined` when the information is unavailable (e.g., macOS builds).
 */
export function detectBoardModel() {
  for (const path of MODEL_PATHS) {
    try {
      const buf = fs.readFileSync(path);
      if (buf?.length) {
        return buf.toString('utf8').replace(/\0/g, '').trim();
      }
    } catch (_) {
      // Ignore missing paths; move on to the next probe location.
    }
  }
  return undefined;
}

/**
 * Lightweight helper that uses a simple string match to determine whether the
 * board is *likely* a Raspberry Pi Zero/Zero W.  We purposefully keep the
 * heuristic simple so false positives are rare: other Pi families do not
 * include “Zero” in their model strings.
 */
export function isLikelyPiZero(modelString = '') {
  return /raspberry\s+pi\s+zero/i.test(modelString);
}
