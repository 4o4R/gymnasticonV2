class Messages {
  static assignChannel() {}
  static setDevice() {}
  static setFrequency() {}
  static setPeriod() {}
  static openChannel() {}
  static closeChannel() {}
  static unassignChannel() {}
  static broadcastData() {
    return Buffer.alloc(0);
  }
  static intToLEHexArray() {
    return [0, 0];
  }
}

class GarminStick {
  is_present() {
    return false;
  }
  open() {
    return false;
  }
  write() {}
  close() {}
}

class GarminStick3 extends GarminStick {}
class GarminStick2 extends GarminStick {}

module.exports = {
  Messages,
  GarminStick3,
  GarminStick2,
  __isStub: true
};
