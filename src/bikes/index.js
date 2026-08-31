import fs from 'fs'; // Check for Peloton USB serial presence during autodetect.
import {BikeAutoDetector} from './auto-detect.js'; // Helper that centralizes BLE scan + classification logic.
import {FlywheelBikeClient, FLYWHEEL_LOCALNAME} from './flywheel.js'; // Flywheel BLE profile.
import {PelotonBikeClient} from './peloton.js'; // Peloton USB profile.
import {Ic4BikeClient, matchesIc4OrSchwinn290} from './ic4.js'; // Schwinn IC4 profile.
import {Ic5BikeClient} from './ic5.js'; // LifeFitness IC5 profile built atop the IC4 implementation.
import {KeiserBikeClient, matchesKeiserName} from './keiser.js'; // Keiser broadcast profile.
import {BotBikeClient} from './bot.js'; // Simulation/bot mode profile.
import {macAddress} from '../util/mac-address.js'; // MAC normalization helper used when targeting specific peripherals.
import {createNameFilter, createAddressFilter} from '../util/ble-scan.js'; // BLE scanning utilities.
import {Ic8BikeClient} from './ic8.js'; // Schwinn IC8 / Bowflex C6 profile.

const FTMS_SERVICE_UUID = '1826'; // Fitness Machine Service exposed by IC8 / Bowflex C6 bikes.
const CSC_SERVICE_UUID = '1816'; // Cycling Speed and Cadence service exposed by IC8 / Bowflex C6 bikes.

function advertisesFitnessService(peripheral) { // Match C6/IC8 bikes even when the local name is missing from the advertisement.
  const uuids = peripheral?.advertisement?.serviceUuids || [];
  return uuids.some((uuid) => {
    const normalized = String(uuid).toLowerCase();
    return normalized === FTMS_SERVICE_UUID || normalized === CSC_SERVICE_UUID;
  });
}

const NAME_MATCHERS = { // Heuristics used during autodetect to match advertising names.
  flywheel: createNameFilter(FLYWHEEL_LOCALNAME), // Flywheel bikes advertise a fixed prefix.
  ic4: matchesIc4OrSchwinn290, // Schwinn IC4 advertises "IC Bike" but Schwinn 290 variants reuse the same FTMS payloads.
  ic5: peripheral => /ic5|life ?fitness/i.test(peripheral?.advertisement?.localName ?? ''), // LifeFitness IC5 patterns.
  ic8: peripheral => /ic8|c6|schwinn|bowflex/i.test(peripheral?.advertisement?.localName ?? '') || advertisesFitnessService(peripheral), // Schwinn IC8 / Bowflex C6 patterns (name or FTMS/CSC service).
  keiser: matchesKeiserName, // Keiser M series broadcasts names that start with "M3".
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
  return new Ic4BikeClient(noble, matchesIc4OrSchwinn290); // Match original IC Bike plus Schwinn 290 advert variations.
}

function createIc5BikeClient(_options, noble) { // Factory for LifeFitness IC5 bikes (inherits FTMS logic from IC4).
  return new Ic5BikeClient(noble); // The subclass provides its own advertisement matcher.
}

function createIc8BikeClient(_options, noble) { // Factory for Schwinn IC8 / Bowflex C6 bikes.
  return new Ic8BikeClient({ noble }); // Construct the dedicated IC8 client with the shared noble instance.
}

function createKeiserBikeClient(options, noble) { // Factory for Keiser bikes that broadcast as beacons.
  return new KeiserBikeClient(noble, {
    address: options.keiserAddress,
  });
}

function createBotBikeClient(options) { // Factory for the simulation/bot profile.
  return new BotBikeClient(options.botPower, options.botCadence, options.botHost, options.botPort);
}

function isAntUsbStick(devicePath) { // Heuristic to avoid misclassifying ANT+ sticks as Peloton consoles.
  try {
    const real = fs.realpathSync(devicePath); // Resolve /dev/serial/by-id links when present.
    const tty = real.replace('/dev/', '');
    const devDir = `/sys/class/tty/${tty}/device`;
    const vendorPath = `${devDir}/../idVendor`;
    const productPath = `${devDir}/../idProduct`;
    if (!fs.existsSync(vendorPath) || !fs.existsSync(productPath)) {
      return false;
    }
    const vendor = fs.readFileSync(vendorPath, 'utf8').trim().toLowerCase();
    const product = fs.readFileSync(productPath, 'utf8').trim().toLowerCase();
    const antPairs = new Set([
      '0fcf:1008', // Garmin/ANT USB-m (common)
      '0fcf:1009',
      '0fcf:1019',
      '0fcf:101f',
      '0fcf:1021',
      '0fcf:1025',
      '0fcf:1031',
    ]);
    return antPairs.has(`${vendor}:${product}`);
  } catch (_err) {
    return false;
  }
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
  console.log('[gym-cli] createBikeClient called with bike:', type);
  const factory = factories[type];
  if (!factory) { // Guard against typos or unsupported bike types.
    throw new Error(`Unknown bike type: ${type}`);
  }
  if (type !== 'autodetect') {
    console.log('[gym-cli] Fixed bike mode selected:', type);
  }
  return factory(options, noble);
}

async function autodetectBikeClient(options, noble) { // Attempt to identify the connected bike automatically.
  console.log('[gym-cli] Autodetect mode selected; scanning for supported bikes...');
  if (options.pelotonPath && fs.existsSync(options.pelotonPath) && !isAntUsbStick(options.pelotonPath)) { // If the Peloton USB serial device is present, prefer that profile immediately unless it's an ANT+ stick.
    console.log('[gym-cli] Peloton USB detected at', options.pelotonPath);
    return createPelotonBikeClient(options, noble);
  }

  const detector = new BikeAutoDetector(noble, NAME_MATCHERS); // Reuse the shared detector so matcher updates live in one place.
  const configuredTimeout = Number(options.bikeConnectTimeout);
  const scanTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout * 1000
    : 30000;

  // Teaching note: count *every* advertisement the radio sees (not just the
  // ones our matchers like) so a failed autodetect can tell users whether the
  // scan saw nothing at all (radio/advertising problem) or saw devices that
  // simply do not match a supported profile (matcher problem).
  let seenCount = 0;
  const seenNames = [];
  const onDiscovery = (peripheral) => {
    seenCount += 1;
    const name = peripheral?.advertisement?.localName || '(unnamed)';
    if (!seenNames.includes(name)) {
      seenNames.push(name);
    }
  };

  const match = await detector.detectBike(null, {
    allowDuplicates: true,
    active: true,
    timeoutMs: scanTimeoutMs,
    stopScanOnTimeout: true,
    onDiscovery,
  });

  if (match && match.type) { // When a peripheral was discovered, map it to the matching profile factory.
    const factory = factories[match.type];
    if (factory) {
      const advertName = match.peripheral?.advertisement?.localName;
      const addr = match.peripheral?.address;
      console.log(`[gym-cli] Autodetect matched ${match.type} (name=${advertName ?? 'unknown'} address=${addr ?? 'unknown'})`);
      return factory(options, noble, match.peripheral);
    }
  }

  const fallback = options.defaultBike || 'keiser'; // Nothing matched—fall back to the configured default (Keiser by default).
  const fallbackFactory = factories[fallback];
  if (!fallbackFactory) {
    throw new Error(`Unknown default bike type: ${fallback}`);
  }

  // Teaching note: a silent timeout is why users think "nothing is happening"
  // when the bike is turned off or already paired to a phone/watch/tablet.
  // Spell out what the scan actually saw and what to check before the retry.
  const seenNamesLabel = seenNames.slice(0, 8).join(', ') || 'none';
  console.log(`[gym-cli] ⚠ No supported bike found after ${scanTimeoutMs / 1000}s of scanning (${seenCount} BLE device(s) seen: ${seenNamesLabel})`);
  if (seenCount === 0) {
    console.log('[gym-cli]   • The radio saw no advertisements at all. This is a radio/scan issue, not a detection issue — a fixed bike type would see the same. Verify the radio works: run "sudo timeout 10 hcitool lescan"; if it lists nothing, restart Bluetooth (sudo systemctl restart bluetooth) or reset the adapter (sudo hciconfig hci0 down && sudo hciconfig hci0 up). Also confirm the bike is powered on, pedaled once, and not connected to a phone/watch/tablet.');
  } else {
    console.log('[gym-cli]   • Devices were seen, but none matched a supported bike profile. If your bike advertises under an unexpected name, set "bike" to its type in /etc/gymnasticon.json.');
  }
  console.log(`[gym-cli] Autodetect falling back to default bike: ${fallback}`);
  return fallbackFactory(options, noble);
}
