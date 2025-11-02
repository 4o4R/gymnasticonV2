import {loadDependency} from '../../util/optional-deps.js'; // pull in the helper that swaps real modules for stubs when optional dependencies are missing

const BLENO_STUB_PATH = '../../../stubs/bleno.cjs'; // resolve the shared bleno stub by walking up from src/servers/ble to the project root
export const blenoModule = loadDependency('@abandonware/bleno', BLENO_STUB_PATH, import.meta); // request bleno with a fallback so development on systems without BLE still works
export const {Characteristic, Descriptor, PrimaryService} = blenoModule; // expose the common BLE classes so services can import them directly
