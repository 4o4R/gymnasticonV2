import {once, EventEmitter} from 'events';
import util from 'util';

/**
 * Bluetooth LE GATT Server.
 */
export class BleServer extends EventEmitter {
  constructor(bleno, name, services) {
    super();
    this.bleno = bleno;
    this.name = name;
    this.services = services;
    
    // Define connection parameters optimized for both Power and CSC
    this.connectionParams = {
      minInterval: 16, // 20ms - optimal for power data
      maxInterval: 32, // 40ms - good for CSC updates
      latency: 0,     // No latency for real-time data
      supervisionTimeout: 6000 // 6s timeout for connection supervision
    };

    // Explicitly define both service UUIDs
    this.uuids = [
      '1818', // Cycling Power Service
      '1816'  // Cycling Speed and Cadence Service
    ];

    // Set up event handlers
    this.bleno.on('accept', this.onAccept.bind(this));
    this.bleno.on('disconnect', this.onDisconnect.bind(this));
    
    // Promisify bleno methods
    this.bleno.startAdvertisingAsync = util.promisify(this.bleno.startAdvertising);
    this.bleno.stopAdvertisingAsync = util.promisify(this.bleno.stopAdvertising);
    this.bleno.setServicesAsync = util.promisify(this.bleno.setServices);
  }
  export class BleServer extends EventEmitter {
    constructor(bleno, name, services) {
      super();
      this.bleno = bleno;
      this.connectionParams = {
        minInterval: 15,
        maxInterval: 30,
        latency: 0,
        supervisionTimeout: 6000
      };
      
      // Update services array to include both Power and CSC
      this.services = services;
      this.uuids = ['1818', '1816']; // Power and CSC service UUIDs
      
      // Rest of existing constructor code...
    }
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
