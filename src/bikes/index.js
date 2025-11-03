import fs from 'fs'; // Check for Peloton USB serial presence during autodetect.
import {FlywheelBikeClient, FLYWHEEL_LOCALNAME} from './flywheel.js'; // Flywheel BLE profile.
import {PelotonBikeClient} from './peloton.js'; // Peloton USB profile.
import {Ic4BikeClient, IC4_LOCALNAME} from './ic4.js'; // Schwinn IC4 profile.
import {Ic5BikeClient} from './ic5.js'; // LifeFitness IC5 profile built atop the IC4 implementation.
import {KeiserBikeClient, KEISER_LOCALNAME} from './keiser.js'; // Keiser broadcast profile.
import {BotBikeClient} from './bot.js'; // Simulation/bot mode profile.
import {macAddress} from '../util/mac-address.js'; // MAC normalization helper used when targeting specific peripherals.
import {scan, createNameFilter, createAddressFilter} from '../util/ble-scan.js'; // BLE scanning utilities.
import {Ic8BikeClient} from './ic8.js'; // Schwinn IC8 / Bowflex C6 profile.

const NAME_MATCHERS = { // Heuristics used during autodetect to match advertising names.
  flywheel: createNameFilter(FLYWHEEL_LOCALNAME), // Flywheel bikes advertise a fixed prefix.
  ic4: createNameFilter(IC4_LOCALNAME), // Schwinn IC4 advertises "IC Bike".
  ic5: peripheral => /ic5|life ?fitness/i.test(peripheral?.advertisement?.localName ?? ''), // LifeFitness IC5 patterns.
  ic8: peripheral => /ic8|c6|schwinn|bowflex/i.test(peripheral?.advertisement?.localName ?? ''), // Schwinn IC8 / Bowflex C6 patterns.
  keiser: createNameFilter(KEISER_LOCALNAME), // Keiser M series broadcasts "M3".
};

function createFlywheelBikeClient(options, noble) { // Factory for Flywheel bikes using optional MAC filter override.
  const filter = options.flywheelAddress
    ? createAddressFilter(macAddress(options.flywheelAddress)) // When caller specifies a MAC, narrow the scan accordingly.
    : createNameFilter(options.flywheelName); // Otherwise match on the advertised name.
  return new FlywheelBikeClient(noble, filter);
}

function createPelotonBikeClient(options) { // Factory for Peloton bikes using USB serial connection.
  return new PelotonBikeClient(options.pelotonPath);
}

function createIc4BikeClient(_options, noble) { // Factory for Schwinn IC4 bikes.
  const filter = createNameFilter(IC4_LOCALNAME); // Match the standard IC4 advertising name.
  return new Ic4BikeClient(noble, filter);
}

function createIc5BikeClient(_options, noble) { // Factory for LifeFitness IC5 bikes (inherits FTMS logic from IC4).
  return new Ic5BikeClient(noble); // The subclass provides its own advertisement matcher.
}

function createIc8BikeClient(_options, noble) { // Factory for Schwinn IC8 / Bowflex C6 bikes.
  return new Ic8BikeClient({ noble }); // Construct the dedicated IC8 client with the shared noble instance.
}

function createKeiserBikeClient(_options, noble) { // Factory for Keiser bikes that broadcast as beacons.
  return new KeiserBikeClient(noble);
}

function createBotBikeClient(options) { // Factory for the simulation/bot profile.
  return new BotBikeClient(options.botPower, options.botCadence, options.botHost, options.botPort);
}

const factories = { // Map CLI bike types to factory functions.
  flywheel: createFlywheelBikeClient,
  peloton: createPelotonBikeClient,
  ic4: createIc4BikeClient,
  ic5: createIc5BikeClient,
  ic8: createIc8BikeClient,
  keiser: createKeiserBikeClient,
  bot: createBotBikeClient,
  autodetect: autodetectBikeClient,
};

export function getBikeTypes() { // Expose the supported bike type keys so the CLI can present valid choices.
  return Object.keys(factories);
}

export function createBikeClient(options, noble) { // Main factory selector used by the App.
  const type = options.bike;
  const factory = factories[type];
  if (!factory) { // Guard against typos or unsupported bike types.
    throw new Error(`Unknown bike type: ${type}`);
  }
  return factory(options, noble);
}

async function autodetectBikeClient(options, noble) { // Attempt to identify the connected bike automatically.
  if (fs.existsSync(options.pelotonPath)) { // If the Peloton USB serial device is present, prefer that profile immediately.
    return createPelotonBikeClient(options, noble);
  }

  const matchers = Object.entries(NAME_MATCHERS); // Collect the name matchers so we can scan once and classify.
  const filter = peripheral => matchers.some(([, predicate]) => predicate(peripheral)); // Filter that accepts any known bike advertisement.
  const peripheral = await scan(noble, null, filter); // Perform an active BLE scan until a matching advertisement appears.

  if (peripheral) { // When a peripheral was discovered, map it to the first matching profile.
    const entry = matchers.find(([, predicate]) => predicate(peripheral));
    if (entry) {
      const [type] = entry;
      const factory = factories[type];
      if (factory) {
        return factory(options, noble, peripheral);
      }
    }
  }

  const fallback = options.defaultBike || 'keiser'; // Nothing matched—fall back to the configured default (Keiser by default).
  const fallbackFactory = factories[fallback];
  if (!fallbackFactory) {
    throw new Error(`Unknown default bike type: ${fallback}`);
  }
  return fallbackFactory(options, noble);
}
