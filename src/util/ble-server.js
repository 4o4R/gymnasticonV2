import { EventEmitter, once } from 'events';
import util from 'util';

/**
 * Bluetooth LE GATT server helper built on top of bleno.
 */
export class BleServer extends EventEmitter {
  constructor(bleno, name, services = []) {
    super();
    this.bleno = bleno;
    this.name = name;
    this.services = services;
    this.uuids = services.map(s => s.uuid);
    this.state = 'stopped';
    // Teaching note: track active connections so we only call bleno.disconnect()
    // when someone is actually connected (this reduces spurious HCI warnings).
    this.connectionCount = 0;

    this.bleno.on('accept', this.onAccept.bind(this));
    this.bleno.on('disconnect', this.onDisconnect.bind(this));

    // Promisify bleno methods for async/await usage
    this.bleno.startAdvertisingAsync = util.promisify(this.bleno.startAdvertising);
    this.bleno.stopAdvertisingAsync = util.promisify(this.bleno.stopAdvertising);
    this.bleno.setServicesAsync = util.promisify(this.bleno.setServices);
  }

  /** Start advertising and wait for a connection. */
  async start() {
    if (this.state !== 'stopped') {
      throw new Error('already started');
    }

    this.state = 'starting';
    this.connectionCount = 0; // Teaching note: reset connection tracking on each start.

    if (this.bleno.state !== 'poweredOn') {
      // Teaching note: keep waiting across intermediate states (poweredOff,
      // resetting) until the adapter reaches poweredOn; giving up after the
      // first stateChange event aborts startup prematurely.
      const fatalStates = new Set(['unauthorized', 'unsupported']);
      while (this.bleno.state !== 'poweredOn') {
        const [state] = await once(this.bleno, 'stateChange');
        if (state && fatalStates.has(state)) {
          this.state = 'stopped';
          throw new Error(`Bluetooth adapter failed to power on: ${state}`);
        }
      }
    }

    try {
      await this.bleno.startAdvertisingAsync(this.name, this.uuids);
      await this.bleno.setServicesAsync(this.services);
    } catch (err) {
      await this.cleanupFailedStart();
      throw err;
    }
    this.state = 'started';
  }

  async cleanupFailedStart() {
    // setServices can fail after the controller has begun advertising. Stop it
    // explicitly before allowing another start attempt, otherwise the next
    // attempt races a live advertiser that our state no longer represents.
    try {
      await this.bleno.stopAdvertisingAsync();
    } catch (_error) {
      // Preserve the original startup error; stopping an inactive advertiser
      // is allowed to fail on some bleno backends.
    } finally {
      this.state = 'stopped';
      this.connectionCount = 0;
    }
  }

  /** Disconnect any active connections and stop advertising. */
  async stop() {
    if (this.state === 'stopped' || this.state === 'stopping') return;

    this.state = 'stopping';
    try {
      await this.bleno.stopAdvertisingAsync();
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

  onAccept(address) {
    // Teaching note: increment connection tracking so stop() can decide whether
    // it is safe/necessary to call bleno.disconnect().
    this.connectionCount += 1;
    this.emit('connect', address);
  }

  onDisconnect(address) {
    // Teaching note: decrement connection tracking but never let it go negative
    // in case of duplicate disconnect events.
    this.connectionCount = Math.max(0, this.connectionCount - 1);
    this.emit('disconnect', address);
  }
}
