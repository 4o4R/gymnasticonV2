import {PrimaryService} from '../../bleno-deps.js'; // Import shared bleno helpers so service creation works with stubs.
import {CscMeasurementCharacteristic} from './characteristics/csc-measurement.js'; // Measurement characteristic that sends wheel/crank data.
import {CscFeatureCharacteristic} from './characteristics/csc-feature.js'; // Feature characteristic that advertises wheel/crank support.
import {ScControlPointCharacteristic} from './characteristics/sc-control-point.js'; // Mandatory control point for cumulative value + calibration requests.

export class CyclingSpeedAndCadenceService extends PrimaryService { // BLE CSC service wrapper that keeps measurement + feature in sync.
  constructor(capabilities = { supportWheel: false, supportCrank: true }) { // Accept capability flags describing which optional fields are supported.
    const measurement = new CscMeasurementCharacteristic(); // Instantiate measurement characteristic once so we can reuse it.
    const feature = new CscFeatureCharacteristic({ // Build the feature characteristic using the initial capability map.
      wheel: !!capabilities.supportWheel, // Normalize to booleans so the characteristic sees a clean value.
      crank: !!capabilities.supportCrank
    });
    const controlPoint = new ScControlPointCharacteristic(); // CSC v1.0 requires 2A55 whenever wheel support is advertised.
    super({ // Initialize the primary service using bleno.
      uuid: '1816', // UUID for Cycling Speed and Cadence Service.
      characteristics: [measurement, feature, controlPoint] // Keep measurement at index 0, feature at index 1 for quick access.
    });
    this.measurement = measurement; // Store a reference so updateMeasurement can call into the characteristic directly.
    this.feature = feature; // Store feature reference so ensureCapabilities can update the advertised bits.
    this.controlPoint = controlPoint; // Expose the control point so callers can inspect calibration/cumulative state.
  }

  ensureCapabilities(capabilities) { // Update the feature bitfield when the supported wheel/crank modes change.
    if (!capabilities) { // Skip when no capabilities were provided.
      return;
    }
    const wheel = !!capabilities.supportWheel; // Normalize incoming booleans.
    const crank = !!capabilities.supportCrank;
    const next = { wheel, crank }; // Build the new capability object.
    this.feature.updateCapabilities(next); // Ask the feature descriptor to refresh its stored value.
  }

  updateMeasurement(measurement) { // Push measurement payloads down to the characteristic.
    // Honour a cumulative wheel baseline set through the control point before encoding.
    this.measurement.updateMeasurement(this.controlPoint.applyCumulativeOffset(measurement));
  }
}
