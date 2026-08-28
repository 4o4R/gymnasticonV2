const stoppedSockets = new WeakSet();

/**
 * Release the native HCI poll handle owned by a noble or bleno instance.
 * Their public stop methods leave this handle active, which prevents Node from
 * exiting after a graceful shutdown.
 */
export function stopBluetoothStack(stack) {
  const socket = stack?._bindings?._hci?._socket;
  if (!socket || typeof socket.stop !== 'function' || stoppedSockets.has(socket)) {
    return false;
  }

  socket.stop();
  stoppedSockets.add(socket);
  return true;
}
