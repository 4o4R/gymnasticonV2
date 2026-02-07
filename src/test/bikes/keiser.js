import test from '../support/tape.js';
import {parse} from '../../bikes/keiser.js';
import {bikeVersion} from '../../bikes/keiser.js';
import {KeiserBikeClient} from '../../bikes/keiser.js';

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
  t.equal(timeout, 20, 'Timeout: 20 seconds');
});

test('bikeVersion() Tests Keiser bike version (6.30)', t => {
  t.plan(2);
  const bufver = Buffer.from('0201063000383803460573000D00042701000A', 'hex');
  const {version, timeout} = bikeVersion(bufver);
  t.equal(version, '6.30', 'Version: 6.30');
  t.equal(timeout, 20, 'Timeout: 20 seconds');
});

test('bikeVersion() Tests Keiser bike version (6.22)', t => {
  t.plan(2);
  const bufver = Buffer.from('0201062200383803460573000D00042701000A', 'hex');
  const {version, timeout} = bikeVersion(bufver);
  t.equal(version, '6.22', 'Version: 6.22');
  t.equal(timeout, 30, 'Timeout: 30 seconds');
});

test('bikeVersion() Tests Keiser bike version (5.12)', t => {
  t.plan(2);
  const bufver = Buffer.from('0201051200383803460573000D00042701000A', 'hex');
  const {version, timeout} = bikeVersion(bufver);
  t.equal(version, '5.12', 'Version: 5.12');
  t.equal(timeout, 30, 'Timeout: 30 seconds');
});

test('KeiserBikeClient.startScanWithFallback() uses normal noble scan when available', async t => {
  t.plan(1);
  const noble = {
    startScanningAsync: async () => {},
    _bindings: {
      startScanning: () => {
        throw new Error('bindings path should not run');
      }
    }
  };
  const client = new KeiserBikeClient(noble);
  await client.startScanWithFallback(null, true);
  t.pass('scan started via noble');
});

test('KeiserBikeClient.startScanWithFallback() falls back on unknown state', async t => {
  t.plan(3);
  let called = false;
  const noble = {
    _discoveredPeripheralUUids: ['old'],
    _allowDuplicates: false,
    startScanningAsync: async () => {
      throw new Error('Could not start scanning, state is unknown (not poweredOn)');
    },
    _bindings: {
      startScanning: (serviceUuids, allowDuplicates) => {
        called = true;
        t.equal(serviceUuids, null, 'passes service UUIDs through');
        t.equal(allowDuplicates, true, 'passes duplicate setting through');
      }
    }
  };
  const client = new KeiserBikeClient(noble);
  await client.startScanWithFallback(null, true);
  t.equal(called, true, 'bindings fallback started scan');
});

test('KeiserBikeClient.startScanWithFallback() rethrows non-state errors', async t => {
  t.plan(1);
  const noble = {
    startScanningAsync: async () => {
      throw new Error('Permission denied');
    },
    _bindings: {
      startScanning: () => {}
    }
  };
  const client = new KeiserBikeClient(noble);
  try {
    await client.startScanWithFallback(null, true);
    t.fail('expected error');
  } catch (error) {
    t.equal(String(error.message), 'Permission denied', 'non-state scan errors are preserved');
  }
});
