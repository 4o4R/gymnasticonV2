import test from '../support/tape.js';
import {parse} from '../../bikes/keiser.js';
import {bikeVersion} from '../../bikes/keiser.js';
import {KeiserBikeClient, createKeiserPeripheralFilter} from '../../bikes/keiser.js';

// A real realtime frame as documented at
// https://dev.keiser.com/mseries/direct/#data-parse-example
const KEISER_DATA_HEX = '0201063000383803460573000D00042701000A';

/**
 * Clone the documented frame with a different realtime data-type byte.
 * @param {number} realtime - value for the data-type byte.
 */
function frameWithDataType(realtime) {
  const buf = Buffer.from(KEISER_DATA_HEX, 'hex');
  buf.writeUInt8(realtime, 4);
  return buf;
}

/**
 * Fake Keiser console advertisement. Every console in range advertises the same
 * name and manufacturer magic, so only the address can tell them apart.
 */
function fakeConsole({address, id = `id-${address}`, name = 'M3i'} = {}) {
  return {
    id,
    address,
    advertisement: {
      localName: name,
      manufacturerData: Buffer.from(KEISER_DATA_HEX, 'hex'),
    },
  };
}

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

test('parse() accepts the documented realtime data-type range 128..227', t => {
  t.plan(4);
  const lower = parse(frameWithDataType(128));
  t.equal(lower.type, 'stats', 'data-type 128 (lower bound) is realtime');
  t.equal(lower.payload.power, 115, 'power still decodes');
  const upper = parse(frameWithDataType(227));
  t.equal(upper.type, 'stats', 'data-type 227 (upper bound) is realtime');
  t.equal(upper.payload.cadence, 82, 'cadence still decodes');
});

test('parse() rejects data-types outside the realtime range', t => {
  t.plan(2);
  t.throws(() => parse(frameWithDataType(228)), /unable to parse message/, '228 is not realtime data');
  t.throws(() => parse(frameWithDataType(254)), /unable to parse message/, '254 is not realtime data');
});

test('createKeiserPeripheralFilter() accepts only the configured console address', t => {
  t.plan(2);
  const filter = createKeiserPeripheralFilter('c0:ff:ee:00:00:01');
  t.ok(filter(fakeConsole({address: 'C0:FF:EE:00:00:01'})), 'accepts the configured console');
  t.notOk(
    filter(fakeConsole({address: 'C0:FF:EE:00:00:02'})),
    'rejects a neighbouring console despite the matching name and Keiser magic payload'
  );
});

test('createKeiserPeripheralFilter() keeps the name heuristics when no address is configured', t => {
  t.plan(3);
  const filter = createKeiserPeripheralFilter();
  t.ok(filter(fakeConsole({address: 'C0:FF:EE:00:00:02'})), 'matches the advertised Keiser name');
  t.ok(filter({address: 'C0:FF:EE:00:00:03', advertisement: {localName: '', manufacturerData: Buffer.from(KEISER_DATA_HEX, 'hex')}}),
    'matches the Keiser magic payload when the name is missing');
  t.notOk(filter({address: 'C0:FF:EE:00:00:04', advertisement: {localName: 'Other', manufacturerData: Buffer.from('ffff', 'hex')}}),
    'still rejects unrelated devices');
});

test('KeiserBikeClient.isMatchingPeripheral() ignores other consoles when an address is configured', t => {
  t.plan(2);
  const client = new KeiserBikeClient(undefined, {address: 'c0:ff:ee:00:00:01'});
  // Simulate a live session on the configured console, with the cached
  // identifiers that the old code used as fallbacks.
  client.peripheral = fakeConsole({address: 'c0:ff:ee:00:00:01'});
  client.peripheralId = 'id-c0:ff:ee:00:00:01';
  client.peripheralAddress = 'c0:ff:ee:00:00:01';
  client.peripheralName = 'M3i';
  client.peripheralSignature = '02010630';

  const otherConsole = fakeConsole({address: 'C0:FF:EE:00:00:02'});
  t.notOk(
    client.isMatchingPeripheral(otherConsole),
    'rejects another console that shares the name and payload signature'
  );
  t.ok(
    client.isMatchingPeripheral(fakeConsole({address: 'c0:ff:ee:00:00:01'})),
    'still accepts the configured console'
  );
});

test('KeiserBikeClient.isMatchingPeripheral() keeps the heuristics when no address is configured', t => {
  t.plan(2);
  const client = new KeiserBikeClient(undefined);
  client.peripheral = fakeConsole({address: 'c0:ff:ee:00:00:01'});
  client.peripheralId = 'id-c0:ff:ee:00:00:01';
  client.peripheralAddress = 'c0:ff:ee:00:00:01';
  client.peripheralName = 'M3i';

  t.ok(client.isMatchingPeripheral({
    address: 'unknown',
    advertisement: {localName: 'M3i', manufacturerData: Buffer.from(KEISER_DATA_HEX, 'hex')},
  }), 'accepts a console that reports an unknown address but the cached name');
  t.notOk(client.isMatchingPeripheral({
    address: 'unknown',
    advertisement: {localName: 'Other', manufacturerData: Buffer.from(KEISER_DATA_HEX, 'hex')},
  }), 'rejects a device whose name does not match');
});

