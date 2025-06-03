export class Messages {
  static assignChannel() {}
  static setDevice() {}
  static setFrequency() {}
  static setPeriod() {}
  static openChannel() {}
}

export class GarminStick {
  is_present() {return false;}
  open() {return false;}
  write() {}
  close() {}
}

export class GarminStick3 extends GarminStick {}
export class GarminStick2 extends GarminStick {}

const Ant = {
  Messages,
  GarminStick3,
  GarminStick2
};
export default Ant;
