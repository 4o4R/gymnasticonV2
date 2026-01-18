export class BluetoothConnectionManager {
  constructor(noble, options = {}) {
    this.noble = noble;
    this.connectionTimeout = options.timeout || 10000;
    this.maxRetries = options.maxRetries || 3;
    this.connections = new Map();
    this.backoffStrategy = options.backoffStrategy || 'exponential';  // exponential or linear
    this.maxBackoff = options.maxBackoff || 5000;  // Cap backoff at 5s
  }

  /**
   * FIX #95: Calculate backoff with jitter to avoid thundering herd.
   * Issue: IC4 cheap adapters drop connections immediately.
   * Solution: Exponential backoff with random jitter helps avoid flooding the adapter.
   */
  calculateBackoff(retryCount) {
    let backoff;
    if (this.backoffStrategy === 'exponential') {
      backoff = Math.min(100 * Math.pow(2, retryCount), this.maxBackoff);
    } else {
      backoff = Math.min(500 * retryCount, this.maxBackoff);
    }
    // Add jitter: ±20% random variation
    const jitter = backoff * (0.8 + Math.random() * 0.4);
    return Math.floor(jitter);
  }

  async connect(peripheral) {
    // Track connection state so we can retry consistently across attempts.
    const connection = {
      peripheral,
      connected: false,
      retryCount: 0
    };

    this.connections.set(peripheral.id, connection);

    while (connection.retryCount < this.maxRetries) {
      try {
        await this.attemptConnection(connection);
        connection.connected = true;
        return true;
      } catch (error) {
        connection.retryCount++;
        if (connection.retryCount >= this.maxRetries) {
          throw new Error(`Connection failed after ${this.maxRetries} retries: ${error.message}`);
        }
        
        // FIX #95: Use intelligent backoff instead of fixed delay
        const backoffMs = this.calculateBackoff(connection.retryCount);
        console.log(`[connection-manager] Retry ${connection.retryCount}/${this.maxRetries} after ${backoffMs}ms backoff`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
    throw new Error('Max connection retries exceeded');
  }

  async attemptConnection(connection) {
    // FIX #55: Handle noble crash on disconnect during MTU/feature exchange
    // Issue: Race condition when peripheral disconnects while updating MTU
    // Solution: Wrap in try/catch and clean up properly
    
    let timeoutId = null;
    const peripheral = connection.peripheral;
    let isConnected = false;

    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Connection timeout')), this.connectionTimeout);
    });

    try {
      // FIX #55: Add disconnect listener BEFORE connecting to catch race conditions
      const onDisconnect = () => {
        console.log(`[connection-manager] ⚠ Peripheral disconnected during connection attempt`);
        if (timeoutId) clearTimeout(timeoutId);
      };

      if (peripheral.once) {
        peripheral.once('disconnect', onDisconnect);
      }

      try {
        // Race the connection against a timer; whichever resolves first wins.
        await Promise.race([
          peripheral.connectAsync(),
          timeoutPromise
        ]);
        isConnected = true;
        
        // FIX #55: Safe MTU update with error handling
        // Only attempt MTU update if connected and supported
        if (isConnected && typeof peripheral.requestMTUAsync === 'function') {
          try {
            // Delay MTU request slightly to allow connection to stabilize
            await new Promise(resolve => setTimeout(resolve, 100));
            await peripheral.requestMTUAsync(247);  // Request max BLE MTU
          } catch (mtuError) {
            // MTU request failures are non-fatal (some devices don't support it)
            console.log(`[connection-manager] ℹ MTU update skipped: ${mtuError.message}`);
          }
        }
      } catch (connectError) {
        // FIX #55: If connection fails, ensure we're not left in half-connected state
        if (connectError?.message === 'Connection timeout' && isConnected === false) {
          // Try to disconnect cleanly
          if (peripheral?.disconnectAsync) {
            try {
              await peripheral.disconnectAsync();
            } catch (e) {
              // Ignore disconnect errors if connect already failed
            }
          }
        }
        throw connectError;
      } finally {
        // Remove disconnect listener
        if (peripheral.removeListener) {
          peripheral.removeListener('disconnect', onDisconnect);
        }
      }

      connection.connected = true;
    } catch (error) {
      connection.connected = false;
      throw error;
    } finally {
      // Always clear the timer so it cannot reject later
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}
