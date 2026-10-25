/**
 * Refcounted BLE scan ownership for a single noble instance.
 *
 * Teaching note: one noble instance owns exactly one native scan per adapter,
 * but the app runs several optional sensor clients (heart rate, speed, cadence)
 * that each want to discover their own device and each give up after their own
 * timeout. Without a shared owner, whichever client finishes first stops the
 * radio and the others keep waiting on a dead scan - so a bridge app started
 * later is never discovered.
 */

import {startScanningBounded, stopScanningSafely} from './ble-scan.js';

let nextScanTag = 0;

/**
 * Build a unique tag so a replaced client cannot release its successor's claim.
 * @param {string} prefix - short owner name, e.g. "heart-rate".
 * @returns {string} a tag unique within this process.
 */
export function createScanTag(prefix) {
  nextScanTag += 1;
  return `${prefix}-${nextScanTag}`;
}

/**
 * Wait for the next peripheral matching a filter without touching scan state.
 *
 * The coordinator owns starting/stopping the native scan, so this helper only
 * attaches a `discover` listener plus its own timeout: expiring here never stops
 * scanning for the other holders.
 *
 * @param {Noble} noble - the noble instance to listen on.
 * @param {FilterFunction} filter - predicate selecting the wanted peripheral.
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - resolve null after this long (0 = wait forever).
 * @param {Function} [options.onDiscovery] - called for every advertisement seen.
 * @param {EventEmitter} [options.cancellation] - emits cancel and latches cancelled on shutdown.
 * @returns {Promise<Peripheral|null>} the matching peripheral, or null on timeout.
 */
export function waitForPeripheral(noble, filter, options = {}) {
  const timeoutMs = Number.isFinite(options?.timeoutMs) ? options.timeoutMs : 0;
  const onDiscovery = typeof options?.onDiscovery === 'function' ? options.onDiscovery : null;

  return new Promise((resolve) => {
    if (!noble || typeof noble.on !== 'function') {
      resolve(null);
      return;
    }

    let settled = false;
    let timeoutId = null;

    const finish = (peripheral) => {
      if (settled) {
        return;
      }
      settled = true;
      noble.removeListener('discover', onDiscover);
      options.cancellation?.removeListener('cancel', onCancel);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      resolve(peripheral);
    };

    const onDiscover = (peripheral) => {
      if (settled) {
        return;
      }
      if (onDiscovery) {
        onDiscovery(peripheral);
      }
      if (filter(peripheral)) {
        finish(peripheral);
      }
    };

    const onCancel = () => finish(null);
    if (options.cancellation?.cancelled) {
      finish(null);
      return;
    }
    options.cancellation?.once('cancel', onCancel);
    noble.on('discover', onDiscover);
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => finish(null), timeoutMs);
    }
  });
}

export class ScanCoordinator {
  /**
   * @param {Noble} noble - the noble instance whose radio is shared.
   * @param {object} [options]
   * @param {object} [options.logger] - logger used for warning output.
   */
  constructor(noble, options = {}) {
    this.noble = noble;
    this.logger = options.logger || console;
    this.holders = new Set();
    this.scanning = false;
    this.startPromise = null;
    this.scanRequest = null;
    this.startTimeoutMs = options.startTimeoutMs;
  }

  /**
   * Number of current scan holders.
   */
  get holderCount() {
    return this.holders.size;
  }

  /**
   * True while the coordinator believes the native scan is running.
   */
  get isScanning() {
    return this.scanning;
  }

  /**
   * Check whether a tag currently holds the scan.
   * @param {string} tag - owner tag.
   * @returns {boolean} true when the tag is registered.
   */
  has(tag) {
    return this.holders.has(normalizeTag(tag));
  }

  /**
   * Register a scan holder and start the native scan for the first one.
   * @param {string} tag - owner tag (must be unique per client instance).
   * @returns {Promise<boolean>} true when the native scan is running.
   */
  async acquire(tag) {
    const key = normalizeTag(tag);
    const isNewHolder = !this.holders.has(key);
    this.holders.add(key);
    try {
      await this.startScanning();
    } catch (error) {
      if (isNewHolder) {
        // Roll back: the caller never got a working scan, so it must not keep
        // holding the radio alive for everybody else.
        this.holders.delete(key);
      }
      throw error;
    }
    return this.scanning;
  }

  /**
   * Drop a scan holder, stopping the native scan only when none remain.
   * @param {string} tag - owner tag.
   * @returns {Promise<boolean>} true when this release stopped the scan.
   */
  async release(tag) {
    const key = normalizeTag(tag);
    if (!this.holders.delete(key)) {
      return false;
    }
    if (this.holders.size > 0) {
      return false;
    }
    return this.stopScanning();
  }

  /**
   * Drop every holder and stop the native scan.
   * @returns {Promise<boolean>} true when this call stopped the scan.
   */
  async releaseAll() {
    this.holders.clear();
    return this.stopScanning();
  }

  /**
   * Start the native scan once, no matter how many holders ask concurrently.
   * @returns {Promise<boolean>} true when the scan is running.
   * @private
   */
  async startScanning() {
    if (this.scanning) {
      return true;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    const pending = this.startNativeScan().then(
      (started) => {
        if (this.startPromise === pending) this.startPromise = null;
        return started;
      },
      (error) => {
        if (this.startPromise === pending) this.startPromise = null;
        throw error;
      }
    );
    this.startPromise = pending;
    return pending;
  }

  /**
   * @private
   */
  async startNativeScan() {
    const noble = this.noble;
    if (!noble || typeof noble.startScanningAsync !== 'function') {
      throw new Error('noble instance cannot start scanning');
    }
    const request = startScanningBounded(noble, [], true, {timeoutMs: this.startTimeoutMs, adoptExisting: true});
    this.scanRequest = request;
    try {
      await request.promise;
      if (this.scanRequest !== request || !this.holders.size) {
        return false;
      }
      this.scanning = true;
      return true;
    } catch (error) {
      if (this.scanRequest === request) {
        this.scanRequest = null;
        request.cancel();
      }
      if (error.code === 'BLE_SCAN_CANCELLED') return false;
      throw error;
    }
  }

  /**
   * @private
   */
  async stopScanning() {
    const request = this.scanRequest;
    if (!this.scanning && !request) {
      return false;
    }
    this.scanRequest = null;
    this.startPromise = null;
    this.scanning = false;
    try {
      if (request) request.cancel();
      else await stopScanningSafely(this.noble);
    } catch (error) {
      // Teaching note: a stop failure must never block shutdown or the next
      // connect cycle; noble's scan can already be gone by the time we ask.
      if (this.logger && typeof this.logger.warn === 'function') {
        this.logger.warn(`[scan-coordinator] failed to stop scan: ${error?.message || error}`);
      }
    }
    return true;
  }
}

function normalizeTag(tag) {
  return String(tag);
}
