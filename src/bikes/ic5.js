import {Ic4BikeClient} from './ic4.js'; // Reuse the established IC4 FTMS implementation for LifeFitness IC5 bikes.

const IC5_PATTERNS = [/ic5/i, /life ?fitness/i]; // Known advertisement name fragments observed on LifeFitness IC5 consoles.

function matchesPeripheral(peripheral) { // Helper that checks whether a discovered peripheral looks like an IC5.
  const name = peripheral?.advertisement?.localName ?? ''; // Pull the advertised local name (may be undefined).
  return IC5_PATTERNS.some(pattern => pattern.test(name)); // Treat the device as a match when any known fragment is present.
}

export class Ic5BikeClient extends Ic4BikeClient { // LifeFitness IC5 shares the FTMS payload layout used by the Schwinn IC4.
  constructor(noble) {
    super(noble, matchesPeripheral); // Reuse the IC4 flow but supply a broader filter that matches IC5 advertising names.
  }

  static get label() { // Provide a stable label so logs and UI can identify the bike profile.
    return 'life-fitness-ic5';
  }

  static matchesAdvertisement(peripheral) { // Allow autodetect to spot IC5 devices before attempting to connect.
    return matchesPeripheral(peripheral);
  }
}
