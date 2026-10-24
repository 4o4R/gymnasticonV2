import {DEFAULT_STARTUP_TIMEOUT_MS, STARTUP_TIMEOUT_CODE} from '../../util/ble-startup.js'; // Shared bound so multi-output startup cannot hang either.

const STARTUP_GRACE_MS = 100; // Let a server's own bound fire first so its more precise error is the one reported.

export class MultiBleServer {
  constructor(entries, logger, options = {}) {
    this.entries = entries;
    this.logger = logger;
    this.activeEntries = null;
    this.degraded = false; // True when at least one adapter could not advertise.
    this.failedAdapters = [];
    this.startupTimeoutMs = Number.isFinite(options.startupTimeoutMs) && options.startupTimeoutMs > 0
      ? options.startupTimeoutMs
      : DEFAULT_STARTUP_TIMEOUT_MS;
  }

  listAdapters() {
    const entries = this.activeEntries || this.entries;
    return entries.map(entry => entry.adapter);
  }

  async start() {
    const results = await Promise.allSettled(
      this.entries.map(entry => this.startEntry(entry))
    );

    const active = [];
    const failed = [];
    results.forEach((result, index) => {
      const entry = this.entries[index];
      if (result.status === 'fulfilled') {
        active.push(entry);
      } else {
        failed.push(entry);
        const reason = result.reason?.message || result.reason;
        this.logger?.error?.(`[ble] failed to start server on ${entry.adapter}: ${reason}`);
      }
    });

    if (!active.length) {
      const unreachable = failed.map(entry => entry.adapter).join(', ') || 'none';
      throw new Error(`No BLE adapters available for advertising (failed adapters: ${unreachable})`);
    }

    this.activeEntries = active;
    // Teaching note: a single unavailable adapter must not take advertising
    // down with it. Keep the reachable adapters live in degraded mode and say
    // loudly which ones are missing instead of throwing.
    this.failedAdapters = failed.map(entry => entry.adapter);
    this.degraded = failed.length > 0;
    if (this.degraded) {
      const message = `[ble] DEGRADED: advertising on ${active.map(entry => entry.adapter).join(', ')}; ` +
        `failed adapters: ${this.failedAdapters.join(', ')}`;
      if (typeof this.logger?.warn === 'function') {
        this.logger.warn(message);
      } else {
        this.logger?.error?.(message); // Fall back to the error channel when the logger has no warn().
      }
    }
  }

  startEntry(entry) { // Start one adapter under a hard bound so a wedged radio cannot stall the others.
    const server = entry.server;
    if (server && !server.adapterLabel) {
      server.adapterLabel = entry.adapter; // Let startup errors name the adapter that failed.
    }
    if (server && typeof server.startupTimeoutMs === 'number' && server.startupTimeoutMs > this.startupTimeoutMs) {
      server.startupTimeoutMs = this.startupTimeoutMs; // Never wait longer than the multi-server bound itself.
    }

    const boundMs = this.startupTimeoutMs + STARTUP_GRACE_MS; // Backstop for servers without their own timeout.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`BLE adapter ${entry.adapter} did not finish starting within ${boundMs}ms`);
        error.code = STARTUP_TIMEOUT_CODE;
        error.adapter = entry.adapter;
        reject(error);
      }, boundMs);
      server.start().then(
        value => {
          clearTimeout(timer);
          resolve(value);
        },
        error => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
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
    this.degraded = false;
    this.failedAdapters = [];
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
