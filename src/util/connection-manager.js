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
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Connection timeout')), 
        this.connectionTimeout);
    });

    await Promise.race([
      connection.peripheral.connectAsync(),
      timeoutPromise
    ]);
    
    connection.connected = true;
  }
}
