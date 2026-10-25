import {DEFAULT_STARTUP_TIMEOUT_MS, STARTUP_TIMEOUT_CODE} from '../../util/ble-startup.js'; // Shared bound so multi-output startup cannot hang either.

const STARTUP_GRACE_MS = 100; // Let a server's own bound fire first so its more precise error is the one reported.

export class MultiBleServer {
  constructor(entries, logger, options = {}) {
    this.entries = entries;
    this.logger = logger;
    this.activeEntries = null;
    this.degraded = false; // True when at least one adapter could not advertise.
    this.failedAdapters = [];
    this.generation = 0;
    this.running = false;
    this.startPromise = null;
    this.startCancellations = new Set();
    this.startupTimeoutMs = Number.isFinite(options.startupTimeoutMs) && options.startupTimeoutMs > 0
      ? options.startupTimeoutMs
      : DEFAULT_STARTUP_TIMEOUT_MS;
  }

  listAdapters() {
    const entries = this.activeEntries || this.entries;
    return entries.map(entry => entry.adapter);
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    this.running = true;
    const generation = ++this.generation;
    const pending = this.startServers(generation);
    this.startPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.startPromise === pending) this.startPromise = null;
    }
  }

  /** Repair failed outputs without restarting an already connected mirror. */
  async recover() {
    if (!this.running) return false;
    const pending = this.start();
    const generation = this.generation;
    try {
      await pending;
      return this.running && generation === this.generation &&
        this.activeEntries.some(({server}) => server.healthy ?? server.state === 'started');
    } catch (_error) {
      // Individual failures were logged by startServers; the next scheduled
      // health check can retry even when every adapter is currently absent.
      if (this.running && generation === this.generation) {
        this.activeEntries = [];
        this.failedAdapters = this.entries.map(entry => entry.adapter);
        this.degraded = true;
      }
      return false;
    }
  }

  async startServers(generation) {
    const results = await Promise.allSettled(
      this.entries.map(entry => this.startEntry(entry, generation))
    );
    if (generation !== this.generation) {
      throw new Error('BLE startup cancelled');
    }

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

  startEntry(entry, generation = this.generation) { // Bound replacement and startup together.
    const boundMs = this.startupTimeoutMs + STARTUP_GRACE_MS; // Backstop for servers without their own timeout.
    return new Promise((resolve, reject) => {
      let expired = false;
      let server = entry.server;
      const cancel = () => {
        expired = true;
        clearTimeout(timer);
        this.startCancellations.delete(cancel);
        server.cancelStartup?.(new Error('BLE startup cancelled'));
        reject(new Error('BLE startup cancelled'));
      };
      const timer = setTimeout(() => {
        expired = true;
        this.startCancellations.delete(cancel);
        const error = new Error(`BLE adapter ${entry.adapter} did not finish starting within ${boundMs}ms`);
        error.code = STARTUP_TIMEOUT_CODE;
        error.adapter = entry.adapter;
        server.cancelStartup?.(error);
        Promise.resolve().then(() => server.stop()).catch(() => {});
        reject(error);
      }, boundMs);
      this.startCancellations.add(cancel);
      const start = async () => {
        if (server.retired || server.pendingStartOperation || server.needsRecovery) {
          if (typeof entry.createServer !== 'function') throw new Error(`BLE adapter ${entry.adapter} needs a fresh binding`);
          server.retire();
          const replacement = await entry.createServer(); // The factory must reopen bleno, even for the first adapter.
          if (expired || generation !== this.generation) {
            replacement.retire();
            throw new Error('BLE startup cancelled');
          }
          server = replacement;
          entry.server = server;
        }
        if (expired || generation !== this.generation) throw new Error('BLE startup cancelled');
        if (server.state === 'started') return; // Keep healthy mirrors live while retrying a failed adapter.
        if (!server.adapterLabel) server.adapterLabel = entry.adapter;
        if (typeof server.startupTimeoutMs === 'number' && server.startupTimeoutMs > this.startupTimeoutMs) {
          server.startupTimeoutMs = this.startupTimeoutMs;
        }
        return server.start();
      };
      start().then(
        value => {
          clearTimeout(timer);
          this.startCancellations.delete(cancel);
          if (expired || generation !== this.generation) {
            Promise.resolve().then(() => server.stop()).catch(() => {});
            if (!expired) reject(new Error('BLE startup cancelled'));
            return;
          }
          resolve(value);
        },
        error => {
          clearTimeout(timer);
          this.startCancellations.delete(cancel);
          reject(error);
        }
      );
    });
  }

  async stop() {
    this.running = false;
    this.generation += 1;
    this.startPromise = null;
    for (const cancel of this.startCancellations) cancel();
    // Failed entries may still have controller callbacks in flight.
    const entries = this.entries;
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
    entries.forEach(({server}) => {
      if (!server.retired && !server.needsRecovery) fn(server);
    });
  }
}
