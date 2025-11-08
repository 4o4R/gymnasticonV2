import {scan} from '../util/ble-scan.js';

/**
 * BikeAutoDetector centralizes the “scan + classify” logic used whenever we do
 * an automatic bike search.  The earlier ad‑hoc implementation inside
 * src/bikes/index.js duplicated name matching and made it hard to add new bike
 * profiles in one place.  This tiny helper keeps the responsibilities separate:
 *   1. Perform a BLE scan using noble.
 *   2. Identify which bike profile should claim the discovered peripheral.
 * The class is intentionally generic so future contributors can inject new
 * matcher maps or alternative scan options without rewriting the control flow.
 */
export class BikeAutoDetector {
  /**
   * @param {Noble} noble - shared noble instance used for scanning.
   * @param {Object<string,function>} matchers - map of bike type => predicate.
   */
  constructor(noble, matchers = {}) {
    this.noble = noble;
    // Store the matcher table so the detector can stay in sync with the bike
    // factories defined in src/bikes/index.js.
    this.matchers = {...matchers};
    // Pre-build a composite filter so `scan()` can short-circuit as soon as we
    // see any advertisement that belongs to a known bike profile.
    this.filter = this.createFilter();
  }

  /**
   * Build a filter function that returns true when *any* matcher claims the
   * peripheral.  Think of this as an OR across the individual predicates.
   */
  createFilter() {
    const predicates = Object.values(this.matchers);
    return (peripheral) => predicates.some(predicate => predicate?.(peripheral));
  }

  /**
   * Identify which matcher claimed the peripheral so we can select the right
   * bike factory later.  Returns `{type, peripheral}` or `null` if nobody
   * matched (which should be rare because we filter before calling this).
   */
  identify(peripheral) {
    const entry = Object.entries(this.matchers).find(([, predicate]) => predicate(peripheral));
    if (!entry) {
      return null;
    }
    const [type] = entry;
    return {type, peripheral};
  }

  /**
   * Scan for a bike advertisement and classify it using the matcher map.
   * @param {string[]|null} serviceUuids - pass-through to noble.scan for FTMS/NUS filters.
   * @param {object} options - scan() options such as {allowDuplicates, active}.
   * @returns {Promise<{type: string, peripheral: Peripheral}|null>}
   */
  async detectBike(serviceUuids = null, options = {allowDuplicates: true, active: true}) {
    const peripheral = await scan(this.noble, serviceUuids, this.filter, options);
    if (!peripheral) {
      return null;
    }
    return this.identify(peripheral);
  }
}
