import {loadDependency, toDefaultExport} from './optional-deps.js';

const antModule = loadDependency('gd-ant-plus', '../stubs/gd-ant-plus.cjs', import.meta);
const Ant = toDefaultExport(antModule);

/**
 * Create ANT+ stick.
 */
export function createAntStick() {
  let stick = new Ant.GarminStick3; // 0fcf:1009
  if (!stick.is_present()) {
    stick = new Ant.GarminStick2; // 0fcf:1008
  }
  return stick;
}
