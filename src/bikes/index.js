import {FlywheelBikeClient, FLYWHEEL_LOCALNAME} from './flywheel';
import {PelotonBikeClient} from './peloton';
import {Ic4BikeClient, IC4_LOCALNAME} from './ic4';
import {KeiserBikeClient, KEISER_LOCALNAME} from './keiser';
import {BotBikeClient} from './bot';
import {macAddress} from '../util/mac-address';
import {scan, createFilter, createNameFilter} from '../util/ble-scan';
import fs from 'fs';

// Autodetection on advertisement.localName seems to be enough and
// keeps it simple. Any peripheral property can be tested though,
// e.g. serviceUuids, manufacturerData, rssi, etc.
const autodetectFilters = {
  'flywheel': createNameFilter(FLYWHEEL_LOCALNAME),
  'ic4': createNameFilter(IC4_LOCALNAME),
  'keiser': createNameFilter(KEISER_LOCALNAME),
};

const factories = {
  'flywheel': createFlywheelBikeClient,
  'peloton': createPelotonBikeClient,
  'ic4': createIc4BikeClient,
  'keiser': createKeiserBikeClient,
  'bot': createBotBikeClient,
  'autodetect': autodetectBikeClient,
};

/**
 * Supported bike types.
 * @returns {string[]} - supported bike types
 */
export function getBikeTypes() {
  return Object.keys(factories);
}












































  export const createBikeClient = (type, options) => {
    switch (type) {
      case 'flywheel':
        return new FlywheelBikeClient(options);
      case 'ic4':
        return new Ic4BikeClient(options);
      case 'keiser':
        return new KeiserBikeClient(options);
      case 'peloton':
        return new PelotonBikeClient(options);
      default:
        throw new Error(`Unknown bike type: ${type}`);
    }
  };
/**
 * Create a BikeClient instance for the first matching autodetected bike.
 * @param {object} options - yargs CLI/config options
 * @param {Noble} noble - a Noble instance.
 * @returns {BikeClient} - a BikeClient instance.
 */
async function autodetectBikeClient(options, noble) {
  if (fs.existsSync(options.pelotonPath)) {
    return createPelotonBikeClient(options, noble);
  }
  const types = Object.keys(autodetectFilters);
  const funcs = Object.values(autodetectFilters);
  const filter = peripheral => funcs.some(f => f(peripheral));
  const peripheral = await scan(noble, null, filter);
  const bike = types.find(f => autodetectFilters[f](peripheral));
  const factory = factories[bike];
  return await factory(options, noble, peripheral);
}
