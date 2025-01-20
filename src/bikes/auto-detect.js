export class BikeAutoDetector {
  constructor(noble) {
    this.noble = noble;
    this.knownBikes = {
      'Flywheel': /^Flywheel/,
      'IC4': /^IC Bike/,
      'Keiser': /^M3/,
      'Peloton': /^Peloton/
    };
  }

  async detectBike() {
    return new Promise((resolve) => {
      this.noble.on('discover', (peripheral) => {
        const name = peripheral.advertisement.localName;
        for (const [bikeType, pattern] of Object.entries(this.knownBikes)) {
          if (pattern.test(name)) {
            resolve({ type: bikeType, peripheral });
          }
        }
      });
      
      this.noble.startScanning([], true);
    });
  }
}
