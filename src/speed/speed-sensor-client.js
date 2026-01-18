/**
 * Generic Speed Sensor Client
 * 
 * Connects to any Bluetooth LE device advertising the legacy
 * Gymnasticon speed service (UUID 0x181a) and emits speed data.
 * 
 * Works with: devices exposing the legacy Gymnasticon speed profile (0x181a/0x2a50)
 * 
 * Data flow:
 * Device broadcasts legacy Gymnasticon speed service (0x181a)
 *   → Speed Measurement characteristic (0x2a50)
 *   → Contains: wheel revolution count + event time
 *   → App calculates speed from: wheelRevolutions * wheelCircumference / timeInterval
 */

import {EventEmitter} from 'events';
import {scan} from '../util/ble-scan.js';

const EVENT_TIME_MAX = 0x10000;
const WHEEL_REV_MAX = 0x100000000;

function counterDelta(current, previous, maxValue) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) {
    return 0;
  }
  if (current >= previous) {
    return current - previous;
  }
  return (maxValue - previous) + current;
}

export class SpeedSensorClient extends EventEmitter {
  constructor(noble, options = {}) {
    super();
    this.noble = noble;
    this.logger = options.logger || console;
    this.connectionManager = options.connectionManager;

    // Search parameters
    this.deviceName = options.deviceName;  // Optional: filter by name (e.g., "Wahoo Speed")
    this.serviceUuid = '181a';  // Legacy Gymnasticon speed service
    this.characteristicUuid = '2a50';  // Legacy speed measurement

    // Connection parameters
    this.connectTimeout = options.connectTimeout || 30;  // seconds
    this.statTimeout = options.statTimeout || 5000;  // milliseconds between expected updates
    this.maxConnectRetries = Number.isFinite(options.maxConnectRetries) ? options.maxConnectRetries : Infinity;
    this.retryDelay = Number.isFinite(options.retryDelay) ? options.retryDelay : 1000;  // ms before retry
    this.maxRetryDelay = Number.isFinite(options.maxRetryDelay) ? options.maxRetryDelay : 30000;

    // State tracking
    this.peripheral = null;
    this.characteristic = null;
    this.lastEventTime = null;
    this.wheelRevolutions = 0;
    this.isConnected = false;
    this.connecting = false;
    this.shouldReconnect = true;

    // Timers
    this.connectTimer = null;
    this.statTimer = null;
    this.retryTimer = null;
    this.retryCount = 0;

    this.onSpeedDataBound = (data) => this.onSpeedData(data);
    this.onDisconnectBound = () => this.onDisconnect();
  }

  /**
   * Start discovery and connection process.
   * Emits 'connected' on success, 'connect-failed' on failure.
   */
  async connect() {
    if (this.isConnected || this.connecting) {
      return;
    }
    this.connecting = true;
    this.shouldReconnect = true;
    this.logger.log('[SpeedSensorClient] Starting speed sensor discovery...');
    
    try {
      // Phase 1: Scan for speed sensor
      const timeoutMs = Number.isFinite(this.connectTimeout) && this.connectTimeout > 0
        ? Math.round(this.connectTimeout * 1000)
        : 0;
      this.peripheral = await scan(
        this.noble,
        [this.serviceUuid],
        (peripheral) => this.matchesFilter(peripheral),
        {
          timeoutMs,
          stopScanOnMatch: false,
          stopScanOnTimeout: false,
        }
      );

      if (!this.peripheral) {
        this.emit('connect-failed', 'Speed sensor not found');
        this.connecting = false;
        this.scheduleReconnect();
        return;
      }

      if (typeof this.peripheral.connectAsync !== 'function') {
        throw new Error('Speed sensor discovery returned a non-connectable peripheral');
      }

      const name = this.peripheral?.advertisement?.localName || 'Unknown';
      this.logger.log(`[SpeedSensorClient] Found speed sensor: ${name}`);

      // Phase 2: Connect to device
      if (this.connectionManager) {
        await this.connectionManager.connect(this.peripheral);
      } else {
        await this.peripheral.connectAsync();
      }
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
      this.characteristic.on('data', this.onSpeedDataBound);
      await this.characteristic.subscribeAsync();
      
      this.isConnected = true;
      this.connecting = false;
      this.retryCount = 0;
      this.emit('connected');
      this.logger.log('[SpeedSensorClient] Subscribed to speed notifications');

      // Handle disconnection
      this.peripheral.once('disconnect', this.onDisconnectBound);

    } catch (error) {
      this.logger.error(`[SpeedSensorClient] Connection failed: ${error.message}`);
      this.connecting = false;
      this.cleanupConnection();
      this.emit('connect-failed', error.message);
      this.scheduleReconnect();
    }
  }

  /**
   * Check if a peripheral matches our search criteria.
   * Matches if: device advertises speed service AND (no name filter OR name matches).
   * If service UUIDs are missing (hcitool fallback), name matching is used when provided.
   */
  matchesFilter(peripheral) {
    const localName = peripheral?.advertisement?.localName || '';
    const nameMatches = this.deviceName
      ? localName.toLowerCase().includes(this.deviceName.toLowerCase())
      : false;
    const serviceUuids = peripheral?.advertisement?.serviceUuids;
    const hasService = Array.isArray(serviceUuids) && serviceUuids.some(
      uuid => uuid?.toLowerCase() === this.serviceUuid.toLowerCase()
    );

    if (this.deviceName) {
      return Array.isArray(serviceUuids) ? nameMatches && hasService : nameMatches;
    }
    return Boolean(hasService);
  }

  /**
   * Parse speed measurement data from characteristic notification.
   * Format (legacy Gymnasticon):
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
      const hasPrevious = this.lastEventTime !== null;
      const timeDelta = hasPrevious
        ? counterDelta(eventTime, this.lastEventTime, EVENT_TIME_MAX)
        : 0;
      const timeSinceLastEvent = timeDelta * timeUnit;

      // Calculate revolutions since last event
      const revolutionsSinceLastEvent = hasPrevious
        ? counterDelta(newWheelRevolutions, this.wheelRevolutions, WHEEL_REV_MAX)
        : 0;

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
    if (!Number.isFinite(this.statTimeout) || this.statTimeout <= 0) {
      return;
    }
    if (this.statTimer) {
      clearTimeout(this.statTimer);
    }
    this.statTimer = setTimeout(() => {
      this.logger.warn('[SpeedSensorClient] No speed data received - assuming disconnect');
      this.onDisconnect();
    }, this.statTimeout);
  }

  /**
   * Handle unexpected disconnection.
   * Attempt to reconnect with exponential backoff.
   */
  onDisconnect() {
    if (!this.isConnected && !this.connecting) return;  // Already handled
    if (!this.shouldReconnect) {
      this.cleanupConnection();
      return;
    }

    this.isConnected = false;
    this.connecting = false;
    this.logger.warn('[SpeedSensorClient] Speed sensor disconnected');
    this.emit('disconnect-detected');

    this.clearStatTimer();
    this.cleanupConnection();

    this.scheduleReconnect();
  }

  /**
   * Schedule reconnection attempt with exponential backoff.
   */
  scheduleReconnect() {
    if (!this.shouldReconnect) return;
    if (Number.isFinite(this.maxConnectRetries) && this.retryCount >= this.maxConnectRetries) {
      this.logger.error(`[SpeedSensorClient] Max reconnection attempts (${this.maxConnectRetries}) reached`);
      this.emit('connection-failed');
      return;
    }

    const delay = Math.min(this.retryDelay * Math.pow(2, this.retryCount), this.maxRetryDelay);
    this.retryCount++;

    const attemptLabel = Number.isFinite(this.maxConnectRetries)
      ? `${this.retryCount}/${this.maxConnectRetries}`
      : `${this.retryCount}`;
    this.logger.log(`[SpeedSensorClient] Scheduling reconnect in ${delay}ms (attempt ${attemptLabel})`);

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    this.retryTimer = setTimeout(() => this.reconnect(), Math.round(delay));
  }

  /**
   * Attempt to reconnect after disconnect.
   */
  async reconnect() {
    if (!this.shouldReconnect) return;
    try {
      await this.disconnect({reconnect: true});  // Clean up old connection
      await this.connect();
    } catch (error) {
      this.logger.error(`[SpeedSensorClient] Reconnection failed: ${error.message}`);
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnect and clean up.
   */
  async disconnect({reconnect = false} = {}) {
    if (!reconnect) {
      this.shouldReconnect = false;
    }
    this.clearStatTimer();
    this.clearRetryTimer();

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

    this.cleanupConnection();
  }

  /**
   * Get current connection status.
   */
  getStatus() {
    return {
      connected: this.isConnected,
      wheelRevolutions: this.wheelRevolutions,
      deviceName: this.peripheral?.advertisement?.localName || 'Unknown',
    };
  }

  clearStatTimer() {
    if (this.statTimer) {
      clearTimeout(this.statTimer);
      this.statTimer = null;
    }
  }

  clearRetryTimer() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  cleanupConnection() {
    this.isConnected = false;
    this.connecting = false;
    this.lastEventTime = null;
    this.wheelRevolutions = 0;
    if (this.characteristic) {
      this.characteristic.removeListener('data', this.onSpeedDataBound);
      this.characteristic = null;
    }
    if (this.peripheral) {
      this.peripheral.removeListener('disconnect', this.onDisconnectBound);
      this.peripheral = null;
    }
  }
}
