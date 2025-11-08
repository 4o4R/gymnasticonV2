import {Characteristic, Descriptor} from '../../../bleno-deps.js'; // Import shared bleno helpers so stub resolution is centralized.

const FLAG_WHEEL = 1 << 0; // BLE Spec 2A5B flag indicating wheel revolution data follows.
const FLAG_CRANK = 1 << 1; // BLE Spec 2A5B flag indicating crank revolution data follows.

const CRANK_TS_SCALE = 1024; // convert seconds -> 1/1024s to match the CSC spec (since integrateKinematics stores seconds)
const WHEEL_TS_SCALE = 1024; // same conversion for wheel timestamps so both characteristics wrap correctly every 64 seconds

export class CscMeasurementCharacteristic extends Characteristic { // Measurement characteristic that emits instantaneous wheel/crank data.
  constructor() {
    super({
      uuid: '2a5b', // UUID for Cycling Speed and Cadence Measurement.
      properties: ['notify'], // Measurements are notifications, not reads.
      descriptors: [ // Provide a descriptor so tools describe the characteristic clearly.
        new Descriptor({ uuid: '2903', value: Buffer.alloc(2) }) // CCC descriptor placeholder required by many stacks.
      ]
    });
  }

  updateMeasurement({ wheel, crank }) { // Push an updated wheel/crank measurement to subscribed clients.
    const buffer = Buffer.alloc(11); // Allocate the maximum payload: flags + wheel (6 bytes) + crank (4 bytes).
    let offset = 1; // Start after the flags byte.
    let flags = 0; // Track which optional fields were populated.

    if (wheel) { // Include wheel revolution data when provided.
      flags |= FLAG_WHEEL; // Mark the wheel-present bit.
      const revolutions = wheel.revolutions >>> 0; // Ensure the cumulative wheel revolutions are treated as an unsigned 32-bit value.
      // Teaching note: we measure wheel timestamps in seconds for readability and only down-convert
      // to 1/1024s here so the BLE characteristic stays spec-compliant without losing precision earlier.
      const timestamp = Math.round(wheel.timestamp * WHEEL_TS_SCALE) & 0xffff; // Convert seconds to 1/1024s and clamp to 16 bits.
      buffer.writeUInt32LE(revolutions, offset); offset += 4; // Write the 32-bit cumulative wheel revolution count.
      buffer.writeUInt16LE(timestamp, offset); offset += 2; // Write the 16-bit last wheel event timestamp.
    }

    if (crank) { // Include crank revolution data when present.
      flags |= FLAG_CRANK; // Mark the crank-present bit.
      const revolutions = crank.revolutions & 0xffff; // Crank revolutions are 16-bit cumulative values that wrap.
      const timestamp = Math.round(crank.timestamp * CRANK_TS_SCALE) & 0xffff; // Convert seconds to 1/1024s with wrap handling.
      buffer.writeUInt16LE(revolutions, offset); offset += 2; // Write cumulative crank revolutions.
      buffer.writeUInt16LE(timestamp, offset); offset += 2; // Write last crank event timestamp.
    }

    buffer.writeUInt8(flags, 0); // Store the populated flag bits at the first byte.

    if (this.updateValueCallback) { // Only emit when a subscriber is active.
      this.updateValueCallback(buffer.slice(0, offset)); // Send a trimmed buffer containing just the populated fields.
    }
  }
}
