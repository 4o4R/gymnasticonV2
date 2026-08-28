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

    try {
      while (connection.retryCount < this.maxRetries) {
        try {
          await this.attemptConnection(connection);
          connection.connected = true;
          return true;
        } catch (error) {
          connection.retryCount++;
          if (error.retryable === false) {
            throw new Error(`Connection aborted because cleanup failed: ${error.message}`);
          }
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
    } finally {
      // Drop completed attempts so a long-running process does not accumulate
      // one dead record per peripheral.
      this.connections.delete(peripheral.id);
    }
  }

  async attemptConnection(connection) {
    let timeoutId = null;
    const peripheral = connection.peripheral;
    let onDisconnect;

    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Connection timeout')), this.connectionTimeout);
    });
    const disconnectPromise = new Promise((_, reject) => {
      onDisconnect = () => reject(new Error('Peripheral disconnected during connection attempt'));
      peripheral.once?.('disconnect', onDisconnect);
    });

    try {
      const connectionWork = (async () => {
        await peripheral.connectAsync();

        if (typeof peripheral.requestMTUAsync === 'function') {
          try {
            await new Promise(resolve => setTimeout(resolve, 100));
            await peripheral.requestMTUAsync(247);
          } catch (mtuError) {
            console.log(`[connection-manager] ℹ MTU update skipped: ${mtuError.message}`);
          }
        }
      })();

      await Promise.race([connectionWork, timeoutPromise, disconnectPromise]);

      connection.connected = true;
    } catch (error) {
      connection.connected = false;
      const disconnected = await this.cancelConnectionAttempt(peripheral);
      if (!disconnected) {
        error.retryable = false;
        error.message = `${error.message}; unable to confirm connection cancellation`;
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      peripheral.removeListener?.('disconnect', onDisconnect);
    }
  }

  async cancelConnectionAttempt(peripheral) {
    if (!peripheral || peripheral.state === 'disconnected' || peripheral.state === 'error') {
      return true;
    }
    if (typeof peripheral.disconnectAsync !== 'function') {
      return false;
    }

    let cleanupTimer;
    try {
      const disconnected = await Promise.race([
        peripheral.disconnectAsync().then(() => true, () => false),
        new Promise(resolve => {
          cleanupTimer = setTimeout(() => resolve(false), 1000);
        }),
      ]);
      return disconnected || peripheral.state === 'disconnected';
    } finally {
      if (cleanupTimer) {
        clearTimeout(cleanupTimer);
      }
    }
  }
}
