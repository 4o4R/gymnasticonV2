// Tiny helper for working with wall-clock timestamps in seconds.

export function nowSeconds() { // Export a single function so consumers can mock it in tests.
  return Date.now() / 1000; // Convert JavaScript's millisecond resolution to seconds as used by BLE specs.
}
