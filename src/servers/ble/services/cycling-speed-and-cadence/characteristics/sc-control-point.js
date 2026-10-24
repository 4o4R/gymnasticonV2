import {Characteristic, Descriptor} from '../../../bleno-deps.js'; // Import the shared bleno helpers so stub loading stays centralized.

// Op codes defined by the Cycling Speed and Cadence Service (CSC) v1.0 specification, section 3.5.
export const OP_SET_CUMULATIVE_VALUE = 0x01; // Set Cumulative Value: client supplies a wheel revolution baseline.
export const OP_START_SENSOR_CALIBRATION = 0x02; // Start Sensor Calibration: client asks for a calibration cycle.
export const OP_RESPONSE_CODE = 0x05; // Response Code: the only op code the server sends back to the client.

// Response codes carried inside the 0x05 Response Code indication.
export const RESPONSE_SUCCESS = 0x01;
export const RESPONSE_OP_CODE_NOT_SUPPORTED = 0x02;
export const RESPONSE_INVALID_PARAMETER = 0x03;

// ATT result codes used when answering the write itself.
export const RESULT_SUCCESS = 0x00;
export const RESULT_INVALID_OFFSET = 0x07;
export const RESULT_INVALID_ATTRIBUTE_LENGTH = 0x0d;

/**
 * Op codes this server supports, advertised as a bitfield where bit N-1 marks
 * op code N as supported (so 0x01 -> bit 0 and 0x02 -> bit 1).
 */
export const SC_CONTROL_POINT_OPERATIONS = [OP_SET_CUMULATIVE_VALUE, OP_START_SENSOR_CALIBRATION];

/** Supported-features bitfield reported by the control point. */
export const SC_CONTROL_POINT_SUPPORTED_FEATURES = SC_CONTROL_POINT_OPERATIONS
  .reduce((bits, opCode) => bits | (1 << (opCode - 1)), 0);

/**
 * Bluetooth LE GATT SC Control Point characteristic (UUID 2A55).
 *
 * Teaching note: the CSC specification makes this characteristic mandatory
 * whenever the service advertises wheel revolution support, so clients can set
 * the cumulative wheel value and request a calibration. Requests arrive as
 * writes and every request is answered with a Response Code indication.
 */
export class ScControlPointCharacteristic extends Characteristic {
  constructor() {
    super({
      uuid: '2a55', // UUID for SC Control Point.
      properties: ['write', 'indicate'], // Clients write requests and receive Response Code indications.
      descriptors: [
        new Descriptor({ uuid: '2901', value: 'SC Control Point' }) // Short descriptor string describing the characteristic.
      ]
    });
    this.supportedFeatures = SC_CONTROL_POINT_SUPPORTED_FEATURES; // Bitfield of accepted op codes.
    this.supportedOperations = SC_CONTROL_POINT_OPERATIONS.slice(); // Same information in list form for readability.
    this.cumulativeWheelRevolutions = null; // Last baseline a client asked us to report.
    this.wheelRevolutionsOffset = 0; // Shift applied to upstream wheel counters to honour the baseline.
    this.pendingCumulativeValue = null; // Baseline waiting for the next measurement to compute an offset.
    this.calibrationRequested = false; // Records that a client asked for calibration.
    this.lastResponse = null; // Last Response Code indication, kept observable for diagnostics.
  }

  /** Whether the given op code is advertised as supported. */
  supportsOperation(opCode) {
    if (!Number.isInteger(opCode) || opCode < 1) {
      return false;
    }
    return (this.supportedFeatures & (1 << (opCode - 1))) !== 0;
  }

  onWriteRequest(data, offset, withoutResponse, callback) {
    const request = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
    if (offset > 0) {
      callback(RESULT_INVALID_OFFSET); // Requests are short writes; a non-zero offset cannot be honoured.
      return;
    }
    if (!request.length) {
      callback(RESULT_INVALID_ATTRIBUTE_LENGTH);
      return;
    }

    const opCode = request.readUInt8(0);
    let responseCode = RESPONSE_OP_CODE_NOT_SUPPORTED;
    if (opCode === OP_SET_CUMULATIVE_VALUE) {
      responseCode = this.setCumulativeValue(request);
    } else if (opCode === OP_START_SENSOR_CALIBRATION) {
      // Teaching note: the bike owns its own sensors, so calibration is only
      // acknowledged here; the request is recorded so callers can react to it.
      this.calibrationRequested = true;
      responseCode = RESPONSE_SUCCESS;
    }

    callback(RESULT_SUCCESS); // The write itself is always well formed; the response code carries the outcome.
    this.sendResponse(opCode, responseCode);
  }

  setCumulativeValue(request) {
    if (request.length !== 5) {
      return RESPONSE_INVALID_PARAMETER; // Op code + 4-byte little-endian cumulative wheel revolutions.
    }
    this.cumulativeWheelRevolutions = request.readUInt32LE(1);
    // Teaching note: measurements come from the bike, so we cannot overwrite its
    // counter. Remember the requested baseline and shift the next measurement
    // onto it, which is what a client expects from Set Cumulative Value.
    this.pendingCumulativeValue = this.cumulativeWheelRevolutions;
    return RESPONSE_SUCCESS;
  }

  /**
   * Shift a measurement onto the cumulative baseline a client requested.
   * Returns the measurement unchanged when no baseline was ever set.
   */
  applyCumulativeOffset(measurement) {
    if (!measurement || !measurement.wheel || !Number.isFinite(measurement.wheel.revolutions)) {
      return measurement;
    }
    const revolutions = measurement.wheel.revolutions;
    if (this.pendingCumulativeValue !== null) {
      this.wheelRevolutionsOffset = (this.pendingCumulativeValue - revolutions) >>> 0;
      this.pendingCumulativeValue = null;
    }
    if (this.wheelRevolutionsOffset === 0) {
      return measurement; // Common case: leave the payload untouched.
    }
    return {
      ...measurement,
      wheel: {...measurement.wheel, revolutions: (revolutions + this.wheelRevolutionsOffset) >>> 0}
    };
  }

  sendResponse(opCode, responseCode) {
    const value = Buffer.from([OP_RESPONSE_CODE, opCode, responseCode]);
    this.lastResponse = {opCode, responseCode, value};
    if (this.updateValueCallback) { // Indications are only delivered to subscribed clients.
      this.updateValueCallback(value);
    }
  }
}
