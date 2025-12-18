export class BluetoothConnectionManager {
  constructor(noble, options = {}) {
    this.noble = noble;
    this.connectionTimeout = options.timeout || 10000;
    this.maxRetries = options.maxRetries || 3;
    this.connections = new Map();
  }

  async connect(peripheral) {
    const connection = {
      peripheral,
      connected: false,
      retryCount: 0
    };

    this.connections.set(peripheral.id, connection);

    while (connection.retryCount < this.maxRetries) {
      try {
        await this.attemptConnection(connection);
        return true;
      } catch (error) {
        connection.retryCount++;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    throw new Error('Max connection retries exceeded');
  }

  async attemptConnection(connection) {
    let timeoutId = null; // Keep a handle so we can cancel the timeout once the connection finishes.
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Connection timeout')), this.connectionTimeout);
    });

    try {
      // Race the connection against a timer; whichever resolves first wins.
      await Promise.race([
        connection.peripheral.connectAsync(),
        timeoutPromise
      ]);
      connection.connected = true;
    } catch (error) {
      // If the timeout fired, proactively disconnect so we do not leave a late, half-open connection behind.
      if (error?.message === 'Connection timeout' && connection.peripheral?.disconnectAsync) {
        await connection.peripheral.disconnectAsync().catch(() => {});
      }
      throw error;
    } finally {
      // Always clear the timer so it cannot reject later and cause an unhandled rejection.
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}
