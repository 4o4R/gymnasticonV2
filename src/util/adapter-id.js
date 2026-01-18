// Helper for converting "hci0" style adapter names into numeric IDs that
// noble/bleno expect in their environment variables.

/**
 * Normalize an adapter identifier into a numeric string.
 * @param {string|number|undefined|null} adapter - "hci0", "0", 0, etc.
 * @returns {string|undefined} numeric string ID or undefined if unparseable
 */
export function normalizeAdapterId(adapter) {
  // Teaching note: noble/bleno parse the env var with parseInt(), so we must
  // pass a numeric string (e.g., "0") instead of "hci0".
  if (adapter === undefined || adapter === null) {
    return undefined;
  }

  if (typeof adapter === 'number' && Number.isFinite(adapter)) {
    return String(adapter);
  }

  const text = String(adapter).trim();
  if (!text) {
    return undefined;
  }

  const match = text.match(/^(?:hci)?(\d+)$/i);
  if (!match) {
    return undefined;
  }

  return String(Number(match[1]));
}

/**
 * Normalize an adapter identifier into "hciX" form for comparisons/logging.
 * @param {string|number|undefined|null} adapter - "hci0", "0", 0, etc.
 * @returns {string|undefined} adapter name (e.g., "hci0") or undefined
 */
export function normalizeAdapterName(adapter) {
  if (adapter === undefined || adapter === null) {
    return undefined;
  }

  if (typeof adapter === 'number' && Number.isFinite(adapter)) {
    return `hci${adapter}`;
  }

  const text = String(adapter).trim();
  if (!text) {
    return undefined;
  }

  const match = text.match(/^(?:hci)?(\d+)$/i);
  if (match) {
    return `hci${Number(match[1])}`;
  }

  return text;
}
