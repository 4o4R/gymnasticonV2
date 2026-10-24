/**
 * Shared bounded startup helpers for bleno-backed servers.
 *
 * Teaching note: every transport that waits for a radio to power on needs the
 * same two guarantees -- the wait cannot outlive a fixed bound, and terminal
 * adapter states fail fast. Keeping that logic in one module means the base
 * BleServer and the Gymnasticon server can never drift apart again.
 */

export const DEFAULT_STARTUP_TIMEOUT_MS = 10000; // Upper bound on how long startup may wait for an adapter.
export const STARTUP_TIMEOUT_CODE = 'BLE_STARTUP_TIMEOUT'; // Marker so callers and tests can recognise a bounded startup failure.

const FATAL_STATES = new Set(['unauthorized', 'unsupported']); // States a retry can never recover from.

export function resolveStartupTimeout(value) { // Accept only usable overrides so a bad option cannot disable the bound.
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  return DEFAULT_STARTUP_TIMEOUT_MS;
}

function resolveAdapterName(adapterName) { // Always name an adapter in errors, even for the default one.
  if (adapterName === undefined || adapterName === null || adapterName === '') {
    return 'default';
  }
  return String(adapterName);
}

function createFatalStateError(adapterName, state) {
  const error = new Error(`Bluetooth adapter ${adapterName} failed to power on: ${state}`);
  error.adapter = adapterName;
  error.state = state;
  return error;
}

function createTimeoutError(adapterName, timeoutMs, state) {
  const error = new Error(
    `BLE adapter ${adapterName} did not report poweredOn within ${timeoutMs}ms (last state: ${state})`
  );
  error.code = STARTUP_TIMEOUT_CODE;
  error.adapter = adapterName;
  error.state = state;
  return error;
}

/**
 * Resolve once bleno reports `poweredOn`.
 *
 * Rejects immediately on a terminal state, and rejects with
 * `code === STARTUP_TIMEOUT_CODE` once `timeoutMs` elapses, so a wedged radio
 * can never leave a caller waiting forever.
 */
export function waitForPoweredOn(bleno, options = {}) {
  const bound = resolveStartupTimeout(options.timeoutMs);
  const label = resolveAdapterName(options.adapterName);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // Exactly one removal, in every code path, keeps the emitter leak-free.
      bleno.removeListener('stateChange', onStateChange);
    };

    const settle = error => { // Single settle gate prevents double-resolve on racy events.
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const inspect = state => {
      if (settled) return;
      if (state === 'poweredOn') {
        settle(null);
      } else if (state && FATAL_STATES.has(state)) {
        settle(createFatalStateError(label, state));
      }
    };

    function onStateChange(state) {
      inspect(state);
    }

    bleno.on('stateChange', onStateChange);
    timer = setTimeout(() => {
      settle(createTimeoutError(label, bound, bleno.state || 'unknown'));
    }, bound);
    inspect(bleno.state); // Cover adapters that are already usable or already fatal.
  });
}
