/**
 * Generic Cadence Sensor Client
 * 
 * Connects to any Bluetooth LE device advertising the standard
 * Cycling Cadence Service (UUID 0x181b) and emits cadence data.
 * 
 * Works with: Wahoo Cadence Sensor, Garmin Cadence Sensors, any standard GATT cadence device
 * 
 * Data flow:
 * Device broadcasts Cycling Cadence Service (0x181b)
 *   → Cycling Cadence Measurement characteristic (0x2a51)
 *   → Contains: crank revolution count + event time
 *   → App calculates cadence from: crankRevolutions / timeInterval
 */

import {EventEmitter} from 'events';
import {scan} from '../util/ble-scan.js';
import {Timer} from '../util/timer.js';

export class CadenceSensorClient extends EventEmitter {
  constructor(noble, options = {}) {
    super();
    this.noble = noble;
    this.logger = options.logger || console;

    // Search parameters
    this.deviceName = options.deviceName;  // Optional: filter by name (e.g., "Wahoo Cadence")
    this.serviceUuid = '181b';  // Standard Cycling Cadence Service
    this.characteristicUuid = '2a51';  // Cycling Cadence Measurement

    // Connection parameters
    this.connectTimeout = options.connectTimeout || 30;  // seconds
    this.statTimeout = options.statTimeout || 5000;  // milliseconds between expected updates
    this.maxConnectRetries = options.maxConnectRetries || 3;
    this.retryDelay = options.retryDelay || 1000;  // ms before retry

    // State tracking
    this.peripheral = null;
    this.characteristic = null;
    this.lastEventTime = null;
    this.crankRevolutions = 0;
    this.isConnected = false;

    // Timers
    this.connectTimer = null;
    this.statTimer = null;
    this.retryTimer = null;
    this.retryCount = 0;
  }

  /**
   * Start discovery and connection process.
   * Emits 'connected' on success, 'connect-failed' on failure.
   */
  async connect() {
    this.logger.log('[CadenceSensorClient] Starting cadence sensor discovery...');
    
    try {
      // Phase 1: Scan for cadence sensor
      this.peripheral = await scan(
        this.noble,
        [this.serviceUuid],
        (peripheral) => this.matchesFilter(peripheral),
        this.connectTimeout
      );

      if (!this.peripheral) {
        this.emit('connect-failed', 'Cadence sensor not found');
        return;
      }

      const name = this.peripheral.advertisement.localName || 'Unknown';
      this.logger.log(`[CadenceSensorClient] Found cadence sensor: ${name}`);

      // Phase 2: Connect to device
      await this.peripheral.connectAsync();
      this.logger.log('[CadenceSensorClient] Connected to peripheral');

      // Phase 3: Discover services and characteristics
      const {characteristics} = await this.peripheral.discoverServicesAndCharacteristicsAsync();
      
      this.characteristic = characteristics.find(c => 
        c.uuid === this.characteristicUuid.toLowerCase()
      );

      if (!this.characteristic) {
        throw new Error(`Characteristic ${this.characteristicUuid} not found`);
      }

      this.logger.log(`[CadenceSensorClient] Discovered cadence measurement characteristic`);

      // Phase 4: Subscribe to notifications
      this.characteristic.on('data', (data) => this.onCadenceData(data));
      await this.characteristic.subscribeAsync();
      
      this.isConnected = true;
      this.emit('connected');
      this.logger.log('[CadenceSensorClient] Subscribed to cadence notifications');

      // Phase 5: Start watchdog timer for disconnect detection
      this.startStatTimer();

      // Handle disconnection
      this.peripheral.once('disconnect', () => {
        this.onDisconnect();
      });

    } catch (error) {
      this.logger.error(`[CadenceSensorClient] Connection failed: ${error.message}`);
      this.emit('connect-failed', error.message);
      this.scheduleReconnect();
    }
  }

  /**
   * Check if a peripheral matches our search criteria.
   * Matches if: device advertises cadence service AND (no name filter OR name matches)
   */
  matchesFilter(peripheral) {
    const hasService = peripheral.advertisement.serviceUuids?.some(
      uuid => uuid.toLowerCase() === this.serviceUuid.toLowerCase()
    );

    if (!hasService) return false;

    if (!this.deviceName) return true;  // No name filter, accept any cadence service device

    const localName = peripheral.advertisement.localName || '';
    return localName.toLowerCase().includes(this.deviceName.toLowerCase());
  }

  /**
   * Parse cadence measurement data from characteristic notification.
   * Format (GATT standard):
   *   Byte 0: Flags
   *   Bytes 1-2: Cumulative Crank Revolutions (uint16, LE)
   *   Bytes 3-4: Last Crank Event Time (uint16, LE, in 1/1024 second units)
   */
  onCadenceData(data) {
    try {
      if (data.length < 5) {
        this.logger.warn(`[CadenceSensorClient] Ignoring short cadence data: ${data.length} bytes`);
        return;
      }

      const flags = data[0];
      const hasCrankRevolutions = !!(flags & 0x01);

      if (!hasCrankRevolutions) {
        this.logger.warn('[CadenceSensorClient] Cadence data has no crank revolution count');
        return;
      }

      const newCrankRevolutions = data.readUInt16LE(1);
      const eventTime = data.readUInt16LE(3);  // In 1/1024 second units

      // Calculate time since last event (handle wraparound)
      const timeUnit = 1 / 1024;  // seconds per unit
      const timeSinceLastEvent = this.lastEventTime 
        ? (eventTime - this.lastEventTime) * timeUnit
        : 0;

      // Calculate revolutions since last event
      const revolutionsSinceLastEvent = newCrankRevolutions - this.crankRevolutions;

      this.crankRevolutions = newCrankRevolutions;
      this.lastEventTime = eventTime;

      // Calculate cadence: RPM = (revolutions / time) * 60
      let cadenceRpm = 0;
      if (timeSinceLastEvent > 0) {
        cadenceRpm = (revolutionsSinceLastEvent / timeSinceLastEvent) * 60;
      }

      // Restart watchdog timer (we're getting data)
      this.startStatTimer();

      // Emit stats for app to consume
      this.emit('stats', {
        crankRevolutions: this.crankRevolutions,
        revolutionsSinceLastEvent,
        timeSinceLastEvent,  // seconds
        cadenceRpm: Math.round(cadenceRpm),  // RPM
        timestamp: Date.now(),
      });

    } catch (error) {
      this.logger.error(`[CadenceSensorClient] Error parsing cadence data: ${error.message}`);
    }
  }

  /**
   * Start or restart the watchdog timer.
   * If we don't receive data within statTimeout, assume device disconnected.
   */
  startStatTimer() {
    if (this.statTimer) this.statTimer.clear();

    this.statTimer = new Timer(
      () => {
        this.logger.warn('[CadenceSensorClient] No cadence data received - assuming disconnect');
        this.onDisconnect();
      },
      this.statTimeout,
      false  // one-shot, not repeating
    );
  }

  /**
   * Handle unexpected disconnection.
   * Attempt to reconnect with exponential backoff.
   */
  onDisconnect() {
    if (!this.isConnected) return;  // Already handled

    this.isConnected = false;
    this.logger.warn('[CadenceSensorClient] Cadence sensor disconnected');
    this.emit('disconnect-detected');

    if (this.statTimer) {
      this.statTimer.clear();
      this.statTimer = null;
    }

    this.scheduleReconnect();
  }

  /**
   * Schedule reconnection attempt with exponential backoff.
   */
  scheduleReconnect() {
    if (this.retryCount >= this.maxConnectRetries) {
      this.logger.error(`[CadenceSensorClient] Max reconnection attempts (${this.maxConnectRetries}) reached`);
      this.emit('connection-failed');
      return;
    }

    const delay = this.retryDelay * Math.pow(2, this.retryCount);
    this.retryCount++;

    this.logger.log(`[CadenceSensorClient] Scheduling reconnect in ${delay}ms (attempt ${this.retryCount}/${this.maxConnectRetries})`);

    this.retryTimer = new Timer(
      () => this.reconnect(),
      Math.round(delay),
      false  // one-shot
    );
  }

  /**
   * Attempt to reconnect after disconnect.
   */
  async reconnect() {
    try {
      await this.disconnect();  // Clean up old connection
      this.retryCount = 0;  // Reset retry counter on reconnect attempt
      await this.connect();
    } catch (error) {
      this.logger.error(`[CadenceSensorClient] Reconnection failed: ${error.message}`);
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnect and clean up.
   */
  async disconnect() {
    if (this.statTimer) this.statTimer.clear();
    if (this.retryTimer) this.retryTimer.clear();

    if (this.characteristic) {
      try {
        await this.characteristic.unsubscribeAsync();
      } catch (e) {
        this.logger.warn(`[CadenceSensorClient] Failed to unsubscribe: ${e.message}`);
      }
    }

    if (this.peripheral && this.isConnected) {
      try {
        await this.peripheral.disconnectAsync();
      } catch (e) {
        this.logger.warn(`[CadenceSensorClient] Failed to disconnect: ${e.message}`);
      }
    }

    this.isConnected = false;
    this.peripheral = null;
    this.characteristic = null;
  }

  /**
   * Get current connection status.
   */
  getStatus() {
    return {
      connected: this.isConnected,
      crankRevolutions: this.crankRevolutions,
      deviceName: this.peripheral?.advertisement.localName || 'Unknown',
    };
  }
}
