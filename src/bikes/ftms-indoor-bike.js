// Shared decoding for the Bluetooth LE FTMS Indoor Bike Data characteristic (0x2AD2).
// The IC4/IC5 family and the IC8/C6 consoles publish the same characteristic, so
// the flag-driven walk lives here instead of being duplicated in each client.

export const FTMS_SERVICE_UUID = '1826'; // Fitness Machine Service.
export const INDOOR_BIKE_DATA_UUID = '2ad2'; // Indoor Bike Data characteristic.

// Indoor Bike Data field flags (FTMS 1.0, 4.9.1). Fields appear in bit order
// after the 16-bit flag word; bit 0 ("more data") set means instantaneous speed
// is ABSENT, which is why that one flag is inverted compared to the others.
const IBD_FLAG_MORE_DATA = 0x0001;
const IBD_FLAG_AVERAGE_SPEED = 0x0002;
const IBD_FLAG_INSTANTANEOUS_CADENCE = 0x0004;
const IBD_FLAG_AVERAGE_CADENCE = 0x0008;
const IBD_FLAG_TOTAL_DISTANCE = 0x0010;
const IBD_FLAG_RESISTANCE_LEVEL = 0x0020;
const IBD_FLAG_INSTANTANEOUS_POWER = 0x0040;
const IBD_FLAG_AVERAGE_POWER = 0x0080;

const PARSE_ERROR = 'unable to parse message';

/**
 * Parse an Indoor Bike Data characteristic value.
 * @param {buffer} data - raw characteristic value.
 * @returns {object} message - parsed message; a field is only present when its flag says so
 * @returns {number} [message.power] - instantaneous power (watts)
 * @returns {number} [message.cadence] - instantaneous cadence (rpm)
 * @returns {number} [message.speed] - instantaneous speed (m/s)
 */
export function parseIndoorBikeData(data) {
  // Teaching note: this characteristic is variable-length. The 16-bit flag word
  // lists which fields follow, and they are laid out in bit order, so every
  // offset depends on the flags. Reading fixed offsets turned a cadence-only
  // frame into garbage power/cadence values.
  //
  // Teaching note: the IC4 family sends the bare flag word with no vendor magic
  // prefix (the old fixed-offset decoder checked only that the payload started
  // with the speed+cadence+power flags byte 0x44). Validating that the declared
  // layout is actually walkable is therefore the compatibility check these
  // consoles need: the first two bytes must exist, and every field the flags
  // declare up to the last one we report must have arrived in full.
  //
  // We only walk as far as average power (bit 7). Fields after it (energy,
  // heart rate, elapsed time, ...) never shift the offsets above, so a frame
  // that stops early there is still usable.
  if (!Buffer.isBuffer(data) || data.length < 2) {
    throw new Error(PARSE_ERROR);
  }

  const flags = data.readUInt16LE(0);
  const parsed = {};
  let offset = 2;

  if (!(flags & IBD_FLAG_MORE_DATA)) {
    const rawSpeed = readField(data, offset, 2);
    offset += 2;
    // 0.01 km/h units; 0 means "not reported right now".
    if (rawSpeed > 0) {
      parsed.speed = (rawSpeed / 100) * (1000 / 3600);
    }
  }
  if (flags & IBD_FLAG_AVERAGE_SPEED) {
    readField(data, offset, 2);
    offset += 2;
  }
  if (flags & IBD_FLAG_INSTANTANEOUS_CADENCE) {
    // Cadence is expressed in half RPM increments.
    parsed.cadence = Math.round(readField(data, offset, 2) / 2);
    offset += 2;
  }
  if (flags & IBD_FLAG_AVERAGE_CADENCE) {
    readField(data, offset, 2);
    offset += 2;
  }
  if (flags & IBD_FLAG_TOTAL_DISTANCE) {
    readField(data, offset, 3);
    offset += 3;
  }
  if (flags & IBD_FLAG_RESISTANCE_LEVEL) {
    readField(data, offset, 2);
    offset += 2;
  }
  if (flags & IBD_FLAG_INSTANTANEOUS_POWER) {
    parsed.power = readField(data, offset, 2, true); // Power is a signed 16-bit integer (watts).
    offset += 2;
  }
  if (flags & IBD_FLAG_AVERAGE_POWER) {
    readField(data, offset, 2, true);
    offset += 2;
  }

  return parsed;
}

/**
 * Read a numeric field, failing gracefully when the frame is truncated.
 * @private
 */
function readField(data, offset, size, signed = false) {
  // Teaching note: a short/fragmented frame must be rejected gracefully.
  // Reading past the end would throw RangeError, which callers do not swallow
  // (they only filter "unable to parse message"), crashing the app.
  if (offset + size > data.length) {
    throw new Error(PARSE_ERROR);
  }
  if (size === 3) {
    return data.readUIntLE(offset, 3);
  }
  return signed ? data.readInt16LE(offset) : data.readUInt16LE(offset);
}
