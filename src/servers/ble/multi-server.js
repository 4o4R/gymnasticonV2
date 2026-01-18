export class MultiBleServer {
  constructor(entries, logger) {
    this.entries = entries;
    this.logger = logger;
    this.activeEntries = null;
  }

  listAdapters() {
    const entries = this.activeEntries || this.entries;
    return entries.map(entry => entry.adapter);
  }

  async start() {
    const results = await Promise.allSettled(
      this.entries.map(({server}) => server.start())
    );

    const active = [];
    results.forEach((result, index) => {
      const entry = this.entries[index];
      if (result.status === 'fulfilled') {
        active.push(entry);
      } else {
        const reason = result.reason?.message || result.reason;
        this.logger?.error?.(`[ble] failed to start server on ${entry.adapter}: ${reason}`);
      }
    });

    if (!active.length) {
      throw new Error('No BLE adapters available for advertising');
    }

    this.activeEntries = active;
  }

  async stop() {
    const entries = this.activeEntries || this.entries;
    const results = await Promise.allSettled(
      entries.map(({server}) => server.stop())
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const adapter = entries[index]?.adapter;
        const reason = result.reason?.message || result.reason;
        this.logger?.log?.(`[ble] failed to stop server on ${adapter}: ${reason}`);
      }
    });
    this.activeEntries = null;
  }

  updateHeartRate(hr) {
    this.forEachServer(server => server.updateHeartRate(hr));
  }

  updatePower(payload) {
    this.forEachServer(server => server.updatePower(payload));
  }

  ensureCscCapabilities(capabilities) {
    this.forEachServer(server => server.ensureCscCapabilities(capabilities));
  }

  updateCsc(measurement) {
    this.forEachServer(server => server.updateCsc(measurement));
  }

  forEachServer(fn) {
    const entries = this.activeEntries || this.entries;
    entries.forEach(({server}) => fn(server));
  }
}
