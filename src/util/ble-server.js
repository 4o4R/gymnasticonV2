import { EventEmitter } from 'events';
import util from 'util';

import { resolveStartupTimeout, STARTUP_TIMEOUT_CODE, waitForPoweredOn } from './ble-startup.js';
import {stopBluetoothStack} from './bluetooth-shutdown.js';

/**
 * Bluetooth LE GATT server helper built on top of bleno.
 */
export class BleServer extends EventEmitter {
  constructor(bleno, name, services = [], options = {}) {
    super();
    this.bleno = bleno;
    this.name = name;
    this.services = services;
    this.uuids = services.map(s => s.uuid);
    this.state = 'stopped';
    // Teaching note: bound the wait for a usable radio. An adapter that never
    // reaches poweredOn used to hang start() forever for every caller.
    this.startupTimeoutMs = resolveStartupTimeout(options.startupTimeoutMs);
    this.adapterLabel = options.adapter ? String(options.adapter) : null;
    // Teaching note: track active connections so we only call bleno.disconnect()
    // when someone is actually connected (this reduces spurious HCI warnings).
    this.connectionCount = 0;
    this.startup = null;
    this.pendingStartOperation = null;
    this.retired = false;
    this.radioLost = false;
    this.onRadioState = state => {
      if (state !== 'poweredOn') this.radioLost = true;
    };

    this.bleno.on('accept', this.onAccept.bind(this));
    this.bleno.on('disconnect', this.onDisconnect.bind(this));

    // Promisify bleno methods for async/await usage
    this.bleno.startAdvertisingAsync = util.promisify(this.bleno.startAdvertising);
    this.bleno.stopAdvertisingAsync = util.promisify(this.bleno.stopAdvertising);
    this.bleno.setServicesAsync = util.promisify(this.bleno.setServices);
  }

  get adapterName() {
    return this.adapterLabel || 'default';
  }

  get needsRecovery() {
    const health = this.bleno.__gymnasticonAdvertising;
    return this.radioLost || Boolean(health?.error) ||
      (health?.restartAt != null && Date.now() - health.restartAt >= this.startupTimeoutMs);
  }

  get healthy() {
    return this.state === 'started' && !this.retired && !this.needsRecovery && this.bleno.state === 'poweredOn';
  }

  /** Start advertising and wait for a connection. */
  async start() {
    if (this.retired) throw new Error(`BLE adapter ${this.adapterName} binding was retired`);
    if (this.state !== 'stopped') {
      throw new Error('already started');
    }
    if (this.pendingStartOperation) {
      throw new Error(`BLE adapter ${this.adapterName} is still completing a cancelled startup`);
    }

    this.state = 'starting';
    this.connectionCount = 0;
    const attempt = new EventEmitter();
    attempt.aborted = false;
    this.startup = attempt;
    let onAbort;
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(attempt.error);
      attempt.once('abort', onAbort);
    });
    const timer = setTimeout(() => {
      const error = new Error(`BLE adapter ${this.adapterName} did not finish starting within ${this.startupTimeoutMs}ms (waiting for poweredOn or advertising; last state: ${this.bleno.state || 'unknown'})`);
      error.code = STARTUP_TIMEOUT_CODE;
      error.adapter = this.adapterName;
      error.state = this.bleno.state || 'unknown';
      this.cancelStartup(error);
    }, this.startupTimeoutMs);

    try {
      await Promise.race([this.startAttempt(attempt), cancelled]);
      if (attempt.aborted) throw attempt.error;
      if (this.bleno.state !== 'poweredOn') throw new Error(`BLE adapter ${this.adapterName} lost power during startup`);
      this.state = 'started';
      this.radioLost = false;
      this.bleno.on('stateChange', this.onRadioState);
    } catch (error) {
      if (!attempt.aborted) this.cancelStartup(error);
      this.stopAdvertisingBestEffort();
      if (this.state !== 'stopping') this.state = 'stopped';
      this.connectionCount = 0;
      throw error;
    } finally {
      clearTimeout(timer);
      attempt.removeListener('abort', onAbort);
      if (this.startup === attempt) this.startup = null;
    }
  }

  async startAttempt(attempt) {
    await waitForPoweredOn(this.bleno, {
      timeoutMs: this.startupTimeoutMs,
      adapterName: this.adapterName,
      cancellation: attempt,
    });
    await this.startStep(attempt, () => this.startAdvertising());
    await this.startStep(attempt, () => this.bleno.setServicesAsync(this.services));
  }

  async startStep(attempt, action) {
    if (attempt.aborted) throw attempt.error;
    const pending = Promise.resolve().then(() => {
      if (attempt.aborted || this.retired) throw attempt.error || new Error('BLE binding retired');
      return action();
    });
    this.pendingStartOperation = pending;
    try {
      await pending;
    } finally {
      if (this.pendingStartOperation === pending) this.pendingStartOperation = null;
      if (attempt.aborted) this.stopAdvertisingBestEffort();
    }
    // A controller may complete a command long after our deadline. Finish
    // stopping that attempt before allowing another start on the same binding.
    if (attempt.aborted) {
      throw attempt.error;
    }
  }

  startAdvertising() {
    return this.bleno.startAdvertisingAsync(this.name, this.uuids);
  }

  cancelStartup(error = new Error('BLE startup cancelled')) {
    const attempt = this.startup;
    if (!attempt || attempt.aborted) return;
    attempt.aborted = true;
    attempt.error = error;
    attempt.emit('abort');
  }

  stopAdvertisingBestEffort() {
    if (this.retired) return;
    try {
      Promise.resolve(this.bleno.stopAdvertisingAsync()).catch(() => {});
    } catch (_error) {
      // Closing an unavailable controller is best effort.
    }
  }

  retire() {
    if (this.retired) return;
    this.bleno.removeListener('stateChange', this.onRadioState);
    this.cancelStartup(new Error(`BLE adapter ${this.adapterName} binding was retired`));
    this.retired = true;
    // Issue the final stop before closing the old stack. Its late callbacks
    // must never send another command after a replacement owns this adapter.
    try { this.bleno.stopAdvertising(); } catch (_error) { /* unavailable controller */ }
    if (this.connectionCount > 0) {
      try { this.bleno.disconnect(); } catch (_error) { /* disconnected controller */ }
    }
    this.state = 'stopped';
    this.connectionCount = 0;
    stopBluetoothStack(this.bleno);
  }

  /** Disconnect any active connections and stop advertising. */
  async stop() {
    if (this.retired) return;
    this.bleno.removeListener('stateChange', this.onRadioState);
    this.cancelStartup();
    if (this.state === 'stopped' || this.state === 'stopping') return;

    this.state = 'stopping';
    try {
      await this.stopAdvertisingBounded();
      // Avoid disconnect calls when no centrals are connected to prevent
      // "unknown handle" warnings on some BlueZ stacks.
      if (this.connectionCount > 0) {
        this.bleno.disconnect();
      }
    } finally {
      this.connectionCount = 0;
      this.state = 'stopped';
    }
  }

  async stopAdvertisingBounded() {
    let timer;
    try {
      await Promise.race([
        this.bleno.stopAdvertisingAsync(),
        new Promise(resolve => { timer = setTimeout(resolve, 1000); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  onAccept(address) {
    if (this.retired) return;
    // Teaching note: increment connection tracking so stop() can decide whether
    // it is safe/necessary to call bleno.disconnect().
    this.connectionCount += 1;
    this.emit('connect', address);
  }

  onDisconnect(address) {
    if (this.retired) return;
    // Teaching note: decrement connection tracking but never let it go negative
    // in case of duplicate disconnect events.
    this.connectionCount = Math.max(0, this.connectionCount - 1);
    this.emit('disconnect', address);
  }
}
