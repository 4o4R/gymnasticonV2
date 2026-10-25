const stoppedSockets = new WeakSet();
const neutralizedHci = new WeakSet();

const noop = () => {};

/** Remember the process hooks installed by one synchronous native initialization. */
export function captureBluetoothInitialization(stack, initialize) {
  const events = ['exit', 'SIGINT'];
  const before = new Map(events.map(event => [event, new Set(process.listeners(event))]));
  try {
    return initialize();
  } finally {
    const owned = stack.__gymnasticonProcessListeners || [];
    for (const event of events) {
      for (const listener of process.listeners(event)) {
        if (!before.get(event).has(listener)) owned.push({event, listener});
      }
    }
    stack.__gymnasticonProcessListeners = owned;
  }
}

/**
 * Collect the HCI helper objects reachable from a noble or bleno instance.
 *
 * noble keeps its HCI object in `_bindings._hci`, while some bleno builds
 * expose it directly as `_hci`. Both shapes are checked so either stack can be
 * released.
 * @param {object} stack - a noble or bleno instance.
 * @returns {object[]} the HCI helper objects that were found.
 */
function hciInstances(stack) {
  const found = [];
  const add = (candidate) => {
    if (candidate && typeof candidate === 'object' && !found.includes(candidate)) {
      found.push(candidate);
    }
  };
  add(stack?._bindings?._hci);
  add(stack?._hci);
  // Bleno's SMP helper owns an additional control-channel socket.
  add(stack?.__gymnasticonManagement);
  return found;
}

/**
 * Stop the self-rescheduling device-up poller owned by an HCI helper.
 *
 * Teaching note: both @abandonware/noble and @abandonware/bleno run
 * `Hci.prototype.pollIsDevUp`, which ends with
 * `setTimeout(this.pollIsDevUp.bind(this), 1000)` and therefore keeps the event
 * loop alive forever. The already-queued callback re-reads `this.pollIsDevUp`
 * when it schedules the next tick, so replacing the property with a no-op lets
 * the chain die on the next tick.
 * @param {object} hci - an HCI helper object.
 * @returns {boolean} true when the poller was neutralized by this call.
 */
function neutralizePoller(hci) {
  if (neutralizedHci.has(hci)) {
    return false;
  }
  neutralizedHci.add(hci);
  try {
    hci.pollIsDevUp = noop;
  } catch (_error) {
    try {
      Object.defineProperty(hci, 'pollIsDevUp', {
        value: noop,
        configurable: true,
        writable: true,
      });
    } catch (_ignored) {
      // A frozen or proxied object cannot be neutralized; the socket stop below
      // is still worth attempting.
    }
  }
  return true;
}

/**
 * Detach a socket's listeners and close its native handle once.
 * @param {object} socket - the native HCI socket.
 * @returns {boolean} true when this call changed the socket.
 */
function releaseSocket(socket) {
  if (!socket || typeof socket !== 'object' || stoppedSockets.has(socket)) {
    return false;
  }
  stoppedSockets.add(socket);
  let acted = false;
  if (typeof socket.removeAllListeners === 'function') {
    try {
      socket.removeAllListeners();
      acted = true;
    } catch (_error) {
      // Ignore: some socket shims do not implement listener removal.
    }
  }
  if (typeof socket.stop === 'function') {
    try {
      socket.stop();
      acted = true;
    } catch (_error) {
      // Stop failures leave the handle to the OS; do not abort the other radios.
    }
  }
  return acted;
}

/**
 * Release the native HCI handle owned by a noble or bleno instance.
 * Their public stop methods leave this handle active, which prevents Node from
 * exiting after a graceful shutdown.
 * @param {object} stack - a noble or bleno instance.
 * @returns {boolean} true when this call released or neutralized anything.
 */
export function stopBluetoothStack(stack) {
  let acted = false;
  if (stack && typeof stack === 'object') {
    try { stack.__gymnasticonStopped = true; } catch (_error) { /* frozen shim */ }
  }
  for (const {event, listener} of stack?.__gymnasticonProcessListeners || []) {
    process.removeListener(event, listener);
    acted = true;
  }
  if (stack?.__gymnasticonProcessListeners) stack.__gymnasticonProcessListeners = [];
  for (const hci of hciInstances(stack)) {
    try {
      if (neutralizePoller(hci)) {
        acted = true;
      }
      if (releaseSocket(hci._socket)) {
        acted = true;
      }
    } catch (_error) {
      // One damaged HCI object must not prevent the remaining radios from being
      // released; shutdown has to stay best-effort.
    }
  }
  return acted;
}
