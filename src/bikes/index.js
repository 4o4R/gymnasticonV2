import {FlywheelBikeClient, FLYWHEEL_LOCALNAME} from './flywheel.js';
import {PelotonBikeClient} from './peloton.js';
import {Ic4BikeClient, IC4_LOCALNAME} from './ic4.js';
import {KeiserBikeClient, KEISER_LOCALNAME} from './keiser.js';
import {BotBikeClient} from './bot.js';
import {macAddress} from '../util/mac-address.js';
import {scan, createNameFilter, createAddressFilter} from '../util/ble-scan.js';
import fs from 'fs';

const autodetectFilters = {
  flywheel: createNameFilter(FLYWHEEL_LOCALNAME),
  ic4: createNameFilter(IC4_LOCALNAME),
  keiser: createNameFilter(KEISER_LOCALNAME),
};

function createFlywheelBikeClient(options, noble) {
  const filter = options.flywheelAddress
    ? createAddressFilter(macAddress(options.flywheelAddress))
    : createNameFilter(options.flywheelName);
  return new FlywheelBikeClient(noble, filter);
}

function createPelotonBikeClient(options) {
  return new PelotonBikeClient(options.pelotonPath);
}

function createIc4BikeClient(options, noble) {
  const filter = createNameFilter(IC4_LOCALNAME);
  return new Ic4BikeClient(noble, filter);
}

function createKeiserBikeClient(options, noble) {
  return new KeiserBikeClient(noble);
}

function createBotBikeClient(options) {
  return new BotBikeClient(options.botPower, options.botCadence, options.botHost, options.botPort);
}

const factories = {
  flywheel: createFlywheelBikeClient,
  peloton: createPelotonBikeClient,
  ic4: createIc4BikeClient,
  keiser: createKeiserBikeClient,
  bot: createBotBikeClient,
  autodetect: autodetectBikeClient,
};

export function getBikeTypes() {
  return Object.keys(factories);
}

export function createBikeClient(options, noble) {
  const factory = factories[options.bike];
  if (!factory) throw new Error(`Unknown bike type: ${options.bike}`);
  return factory(options, noble);
}

async function autodetectBikeClient(options, noble) {
  if (fs.existsSync(options.pelotonPath)) {
    return createPelotonBikeClient(options, noble);
  }
  const types = Object.keys(autodetectFilters);
  const filters = Object.values(autodetectFilters);
  const filter = peripheral => filters.some(f => f(peripheral));
  const peripheral = await scan(noble, null, filter);
  const type = types.find(t => autodetectFilters[t](peripheral));
  return factories[type](options, noble, peripheral);
}
