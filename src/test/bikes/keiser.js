import test from 'tape';
import {parse} from '../../bikes/keiser.js';
import {bikeVersion} from '../../bikes/keiser.js';

/**
 * See https://dev.keiser.com/mseries/direct/#data-parse-example for a
 * data parse example of the below test case
 */
test('parse() parses Keiser indoor bike data values', t => {
  t.plan(3);
  const buf = Buffer.from('0201063000383803460573000D00042701000A', 'hex');
  const {type, payload: {power, cadence}} = parse(buf);
  t.equal(type, 'stats', 'message type');
  t.equal(power, 115, 'power (watts)');
  t.equal(cadence, 82, 'cadence (rpm)');
});

test('bikeVersion() Tests Keiser bike version (6.40)', t => {
  t.plan(2);
  const bufver = Buffer.from('0201064000383803460573000D00042701000A', 'hex');
  const {version, timeout} = bikeVersion(bufver);
  t.equal(version, '6.40', 'Version: 6.40');
  t.equal(timeout, 1, 'Timeout: 1 second');
});

test('bikeVersion() Tests Keiser bike version (6.30)', t => {
  t.plan(2);
  const bufver = Buffer.from('0201063000383803460573000D00042701000A', 'hex');
  const {version, timeout} = bikeVersion(bufver);
  t.equal(version, '6.30', 'Version: 6.30');
  t.equal(timeout, 1, 'Timeout: 1 second');
});

test('bikeVersion() Tests Keiser bike version (6.22)', t => {
  t.plan(2);
  const bufver = Buffer.from('0201062200383803460573000D00042701000A', 'hex');
  const {version, timeout} = bikeVersion(bufver);
  t.equal(version, '6.22', 'Version: 6.22');
  t.equal(timeout, 7, 'Timeout: 7 second');
});

test('bikeVersion() Tests Keiser bike version (5.12)', t => {
  t.plan(2);
  const bufver = Buffer.from('0201051200383803460573000D00042701000A', 'hex');
  const {version, timeout} = bikeVersion(bufver);
  t.equal(version, '5.12', 'Version: 5.12');
  t.equal(timeout, 7, 'Timeout: 7 second');
});
