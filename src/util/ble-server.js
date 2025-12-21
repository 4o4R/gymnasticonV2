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
      const [state] = await once(this.bleno, 'stateChange');
      if (state !== 'poweredOn') {
        this.state = 'stopped';
        throw new Error(`Bluetooth adapter failed to power on: ${state}`);
      }
    }

    await this.bleno.startAdvertisingAsync(this.name, this.uuids);
    await this.bleno.setServicesAsync(this.services);
    this.state = 'started';
  }

  /** Disconnect any active connections and stop advertising. */
  async stop() {
    if (this.state === 'stopped') return;

    await this.bleno.stopAdvertisingAsync();
    // Teaching note: avoid disconnect calls when no centrals are connected to
    // prevent "unknown handle" warnings on some BlueZ stacks.
    if (this.connectionCount > 0) {
      this.bleno.disconnect();
    }
    this.state = 'stopped';
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
