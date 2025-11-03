import {Characteristic, Descriptor} from '../../../bleno-deps.js'; // Import the shared bleno helpers so stub loading stays centralized.

const FLAG_WHEEL = 1 << 0; // BLE Spec 2A5C bit indicating wheel revolution support.
const FLAG_CRANK = 1 << 1; // BLE Spec 2A5C bit indicating crank revolution support.

export class CscFeatureCharacteristic extends Characteristic { // Characteristic that reports which CSC features this server exposes.
  constructor(capabilities = { wheel: false, crank: true }) { // Allow the caller to specify wheel/crank support when constructing the characteristic.
    const value = buildValue(capabilities); // Generate the initial two-byte bitfield based on the requested capabilities.
    super({ // Initialize the bleno Characteristic with the metadata required by the BLE specification.
      uuid: '2a5c', // Standard UUID for Cycling Speed and Cadence Feature.
      properties: ['read'], // Feature characteristics are read-only.
      descriptors: [ // Provide a user descriptor so debugging tools show a helpful label.
        new Descriptor({ uuid: '2901', value: 'CSC Feature' }) // Short descriptor string describing the characteristic.
      ],
      value // Supply the feature bitfield as the default value.
    });
    this.capabilities = { ...capabilities }; // Store the current capabilities so we can detect changes later.
  }

  updateCapabilities(capabilities) { // Allow the server to refresh the advertised features on the fly.
    const nextValue = buildValue(capabilities); // Recompute the packed bitfield for the requested capabilities.
    if (this.value.equals(nextValue)) { // Skip updates when nothing changed to avoid redundant work.
      return;
    }
    this.capabilities = { ...capabilities }; // Persist the new capabilities for future comparisons.
    this.value = nextValue; // Update the characteristic's value so future reads reflect the new support flags.
  }
}

function buildValue({ wheel, crank }) { // Helper that packs boolean wheel/crank flags into the two-byte BLE feature field.
  const bits = (wheel ? FLAG_WHEEL : 0) | (crank ? FLAG_CRANK : 0); // Combine the requested feature bits using bitwise OR.
  return Buffer.from([bits & 0xff, (bits >> 8) & 0xff]); // Return a little-endian buffer as required by the BLE specification.
}
