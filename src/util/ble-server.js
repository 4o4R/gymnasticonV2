import {once, EventEmitter} from 'events';
import util from 'util';

/**
 * Bluetooth LE GATT Server.
 */
export class BleServer extends EventEmitter {
  /**
   * Create a BleServer instance.
   * @param {Bleno} bleno - a Bleno instance.
   * @param {string} name - the name used in advertisement.
   * @param {PrimaryService[]} - the GATT service instances.
   */
  constructor(bleno, name, services) {
    super();
    this.bleno = bleno;
    // Add modern connection parameters
    this.connectionParams = {
      minInterval: 7.5,
      maxInterval: 15,
      latency: 0,
      supervisionTimeout: 4000
    };
    this.state = 'stopped'; // stopped | starting | started | connected
    this.name = name;
    this.services = services;
    this.uuids = services.map(s => s.uuid);
    this.bleno.on('accept', this.onAccept.bind(this));
    this.bleno.on('disconnect', this.onDisconnect.bind(this));
    this.bleno.startAdvertisingAsync = util.promisify(this.bleno.startAdvertising);
    this.bleno.stopAdvertisingAsync = util.promisify(this.bleno.stopAdvertising);
    this.bleno.setServicesAsync = util.promisify(this.bleno.setServices);
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
  }

  async connect() {
    while (this.reconnectAttempts < this.maxReconnectAttempts) {
      try {
        await this.establishConnection();
        this.reconnectAttempts = 0;
        return;
      } catch (error) {
        this.reconnectAttempts++;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    throw new Error('Failed to establish Bluetooth connection');
  }
}
    /**
     * Advertise and wait for connection.
     */
    async start() {
      if (this.state !== 'stopped') {
        throw new Error('already started');
      }

      this.state = 'starting';
      const stateChange = await once(this.bleno, 'stateChange', {timeout: 5000});
    
      if (stateChange[0] !== 'poweredOn') {
        throw new Error(`Bluetooth adapter failed to power on: ${stateChange[0]}`);
      }

      await this.bleno.startAdvertisingAsync(this.name, this.uuids);
      await this.bleno.setServicesAsync(this.services);
      this.state = 'started';
    }
  /**
   * Disconnect any active connection and stop advertising.
   */
  async stop() {
    if (this.state === 'stopped') return;

    await this.bleno.stopAdvertisingAsync();
    this.bleno.disconnect();
  }

  /**
   * Handle connection from a Bluetooth LE Central device (client).
   * @param {string} address - MAC address of device.
   * @emits BleServer#connect
   * @private
   */
  onAccept(address) {
    /**
     * Connect event.
     * @event BleServer#connect
     * @type {string} address - MAC address of device.
     */
    this.emit('connect', address);
  }

  /**
   * Handle disconnection of a Bluetooth LE Central device.
   * @param {string} address - MAC address of device.
   * @emits BleServer#disconnect
   * @private
   */
  onDisconnect(address) {
    /**
     * Disconnect event.
     * @event BleServer#disconnect
     * @type {string} address - MAC address of device.
     */
    this.emit('disconnect', address);
  }
}
