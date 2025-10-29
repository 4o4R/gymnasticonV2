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
    this.bleno.disconnect();
    this.state = 'stopped';
  }

  onAccept(address) {
    this.emit('connect', address);
  }

  onDisconnect(address) {
    this.emit('disconnect', address);
  }
}
