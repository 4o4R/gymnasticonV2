import {Ic4BikeClient} from './ic4.js'; // Reuse the established IC4 FTMS implementation for LifeFitness IC5 bikes.

const IC5_PATTERNS = [/ic5/i, /life ?fitness/i]; // Known advertisement name fragments observed on LifeFitness IC5 consoles.

function matchesPeripheral(peripheral) { // Helper that checks whether a discovered peripheral looks like an IC5.
  const name = peripheral?.advertisement?.localName ?? ''; // Pull the advertised local name (may be undefined).
  return IC5_PATTERNS.some(pattern => pattern.test(name)); // Treat the device as a match when any known fragment is present.
}

export class Ic5BikeClient extends Ic4BikeClient { // LifeFitness IC5 shares the FTMS Indoor Bike Data characteristic used by the Schwinn IC4.
  // Teaching note: the IC5 inherits the IC4 flag-driven FTMS parser, so it
  // decodes whatever fields the console actually sends (and reports undefined
  // cadence/power when a field is absent) instead of assuming the IC4 layout.
  // We deliberately do NOT synthesize power for frames that carry no
  // instantaneous power: the IC5 / Schwinn 290 firmware variants are not
  // documented well enough to guess, and a fabricated wattage would corrupt
  // recorded rides. Confirming power support needs real GATT captures from
  // those consoles.
  constructor(noble, options = {}) {
    super(noble, matchesPeripheral, options); // Reuse the IC4 flow but supply a broader filter that matches IC5 advertising names.
  }

  static get label() { // Provide a stable label so logs and UI can identify the bike profile.
    return 'life-fitness-ic5';
  }

  static matchesAdvertisement(peripheral) { // Allow autodetect to spot IC5 devices before attempting to connect.
    return matchesPeripheral(peripheral);
  }
}
