/**
 * Generic Speed Sensor Client
 * 
 * Connects to any Bluetooth LE device advertising the standard
 * Cycling Speed Service (UUID 0x181a) and emits speed data.
 * 
 * Works with: Wahoo Speed Sensor, Garmin Speed Sensors, any standard GATT speed device
 * 
 * Data flow:
 * Device broadcasts Cycling Speed Service (0x181a)
 *   → Speed Measurement characteristic (0x2a50)
 *   → Contains: wheel revolution count + event time
 *   → App calculates speed from: wheelRevolutions * wheelCircumference / timeInterval
 */

import {EventEmitter} from 'events';
import {scan} from '../util/ble-scan.js';
import {Timer} from '../util/timer.js';

export class SpeedSensorClient extends EventEmitter {
  constructor(noble, options = {}) {
    super();
    this.noble = noble;
    this.logger = options.logger || console;

    // Search parameters
    this.deviceName = options.deviceName;  // Optional: filter by name (e.g., "Wahoo Speed")
    this.serviceUuid = '181a';  // Standard Cycling Speed Service
    this.characteristicUuid = '2a50';  // Cycling Speed Measurement

    // Connection parameters
    this.connectTimeout = options.connectTimeout || 30;  // seconds
    this.statTimeout = options.statTimeout || 5000;  // milliseconds between expected updates
    this.maxConnectRetries = options.maxConnectRetries || 3;
    this.retryDelay = options.retryDelay || 1000;  // ms before retry

    // State tracking
    this.peripheral = null;
    this.characteristic = null;
    this.lastEventTime = null;
    this.wheelRevolutions = 0;
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
    this.logger.log('[SpeedSensorClient] Starting speed sensor discovery...');
    
    try {
      // Phase 1: Scan for speed sensor
      this.peripheral = await scan(
        this.noble,
        [this.serviceUuid],
        (peripheral) => this.matchesFilter(peripheral),
        this.connectTimeout
      );

      if (!this.peripheral) {
        this.emit('connect-failed', 'Speed sensor not found');
        return;
      }

      const name = this.peripheral.advertisement.localName || 'Unknown';
      this.logger.log(`[SpeedSensorClient] Found speed sensor: ${name}`);

      // Phase 2: Connect to device
      await this.peripheral.connectAsync();
      this.logger.log('[SpeedSensorClient] Connected to peripheral');

      // Phase 3: Discover services and characteristics
      const {characteristics} = await this.peripheral.discoverServicesAndCharacteristicsAsync();
      
      this.characteristic = characteristics.find(c => 
        c.uuid === this.characteristicUuid.toLowerCase()
      );

      if (!this.characteristic) {
        throw new Error(`Characteristic ${this.characteristicUuid} not found`);
      }

      this.logger.log(`[SpeedSensorClient] Discovered speed measurement characteristic`);

      // Phase 4: Subscribe to notifications
      this.characteristic.on('data', (data) => this.onSpeedData(data));
      await this.characteristic.subscribeAsync();
      
      this.isConnected = true;
      this.emit('connected');
      this.logger.log('[SpeedSensorClient] Subscribed to speed notifications');

      // Phase 5: Start watchdog timer for disconnect detection
      this.startStatTimer();

      // Handle disconnection
      this.peripheral.once('disconnect', () => {
        this.onDisconnect();
      });

    } catch (error) {
      this.logger.error(`[SpeedSensorClient] Connection failed: ${error.message}`);
      this.emit('connect-failed', error.message);
      this.scheduleReconnect();
    }
  }

  /**
   * Check if a peripheral matches our search criteria.
   * Matches if: device advertises speed service AND (no name filter OR name matches)
   */
  matchesFilter(peripheral) {
    const hasService = peripheral.advertisement.serviceUuids?.some(
      uuid => uuid.toLowerCase() === this.serviceUuid.toLowerCase()
    );

    if (!hasService) return false;

    if (!this.deviceName) return true;  // No name filter, accept any speed service device

    const localName = peripheral.advertisement.localName || '';
    return localName.toLowerCase().includes(this.deviceName.toLowerCase());
  }

  /**
   * Parse speed measurement data from characteristic notification.
   * Format (GATT standard):
   *   Byte 0: Flags
   *   Bytes 1-4: Cumulative Wheel Revolutions (uint32, LE)
   *   Bytes 5-6: Last Wheel Event Time (uint16, LE, in 1/2048 second units)
   */
  onSpeedData(data) {
    try {
      if (data.length < 7) {
        this.logger.warn(`[SpeedSensorClient] Ignoring short speed data: ${data.length} bytes`);
        return;
      }

      const flags = data[0];
      const hasWheelRevolutions = !!(flags & 0x01);

      if (!hasWheelRevolutions) {
        this.logger.warn('[SpeedSensorClient] Speed data has no wheel revolution count');
        return;
      }

      const newWheelRevolutions = data.readUInt32LE(1);
      const eventTime = data.readUInt16LE(5);  // In 1/2048 second units

      // Calculate time since last event (handle wraparound)
      const timeUnit = 1 / 2048;  // seconds per unit
      const timeSinceLastEvent = this.lastEventTime 
        ? (eventTime - this.lastEventTime) * timeUnit
        : 0;

      // Calculate revolutions since last event
      const revolutionsSinceLastEvent = newWheelRevolutions - this.wheelRevolutions;

      this.wheelRevolutions = newWheelRevolutions;
      this.lastEventTime = eventTime;

      // Restart watchdog timer (we're getting data)
      this.startStatTimer();

      // Emit stats for app to consume
      this.emit('stats', {
        wheelRevolutions: this.wheelRevolutions,
        revolutionsSinceLastEvent,
        timeSinceLastEvent,  // seconds
        timestamp: Date.now(),
      });

    } catch (error) {
      this.logger.error(`[SpeedSensorClient] Error parsing speed data: ${error.message}`);
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
        this.logger.warn('[SpeedSensorClient] No speed data received - assuming disconnect');
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
    this.logger.warn('[SpeedSensorClient] Speed sensor disconnected');
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
      this.logger.error(`[SpeedSensorClient] Max reconnection attempts (${this.maxConnectRetries}) reached`);
      this.emit('connection-failed');
      return;
    }

    const delay = this.retryDelay * Math.pow(2, this.retryCount);
    this.retryCount++;

    this.logger.log(`[SpeedSensorClient] Scheduling reconnect in ${delay}ms (attempt ${this.retryCount}/${this.maxConnectRetries})`);

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
      this.logger.error(`[SpeedSensorClient] Reconnection failed: ${error.message}`);
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
        this.logger.warn(`[SpeedSensorClient] Failed to unsubscribe: ${e.message}`);
      }
    }

    if (this.peripheral && this.isConnected) {
      try {
        await this.peripheral.disconnectAsync();
      } catch (e) {
        this.logger.warn(`[SpeedSensorClient] Failed to disconnect: ${e.message}`);
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
      wheelRevolutions: this.wheelRevolutions,
      deviceName: this.peripheral?.advertisement.localName || 'Unknown',
    };
  }
}
