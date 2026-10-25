import {loadDependency} from '../../util/optional-deps.js';

const BLENO_STUB_PATH = '../../../stubs/bleno.cjs';

function loadConstructor(file, name) {
  // The package entry point opens an HCI socket even before advertising starts.
  // These pinned constructor modules need no radio and are safe during startup.
  const loaded = loadDependency(`@abandonware/bleno/lib/${file}`, BLENO_STUB_PATH, import.meta);
  return loaded[name] || loaded;
}

export const Characteristic = loadConstructor('characteristic', 'Characteristic');
export const Descriptor = loadConstructor('descriptor', 'Descriptor');
export const PrimaryService = loadConstructor('primary-service', 'PrimaryService');
