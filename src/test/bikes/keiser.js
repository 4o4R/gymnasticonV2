import {EventEmitter} from 'events';
import test from '../support/tape.js';
import {parse} from '../../bikes/keiser.js';
import {bikeVersion} from '../../bikes/keiser.js';
import {ScanCoordinator} from '../../util/scan-coordinator.js';
import {
  KeiserBikeClient,
  createKeiserPeripheralFilter,
  equipmentIdFromAdvertisement,
  normalizeEquipmentId,
} from '../../bikes/keiser.js';

// A real realtime frame as documented at
// https://dev.keiser.com/mseries/direct/#data-parse-example
const KEISER_DATA_HEX = '0201063000383803460573000D00042701000A';
const DOCUMENTED_EQUIPMENT_ID = 0x38; // Byte 5 of the documented frame ("38" => 56).

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
 * name and manufacturer magic, so only the address or the documented equipment
 * ID can tell them apart.
 */
function fakeConsole({address, id = `id-${address}`, name = 'M3i', equipmentId = DOCUMENTED_EQUIPMENT_ID} = {}) {
  const manufacturerData = Buffer.from(KEISER_DATA_HEX, 'hex');
  if (equipmentId !== null) {
    manufacturerData.writeUInt8(equipmentId, 5); // Byte 5 is the documented equipment ID.
  }
  return {
    id,
    address,
    advertisement: {
      localName: name,
      manufacturerData,
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

test('equipmentIdFromAdvertisement() reads the documented equipment ID byte', t => {
  t.plan(3);
  t.equal(
    equipmentIdFromAdvertisement({manufacturerData: Buffer.from(KEISER_DATA_HEX, 'hex')}),
    DOCUMENTED_EQUIPMENT_ID,
    'byte 5 of the documented frame is the equipment ID'
  );
  t.equal(
    equipmentIdFromAdvertisement({manufacturerData: Buffer.from('02010630', 'hex')}),
    null,
    'a short frame reports no equipment ID'
  );
  t.equal(equipmentIdFromAdvertisement(undefined), null, 'a missing advertisement is tolerated');
});

test('normalizeEquipmentId() accepts only the documented 0..200 range', t => {
  t.plan(7);
  t.equal(normalizeEquipmentId(0), 0, '0 is valid');
  t.equal(normalizeEquipmentId('200'), 200, '200 (upper bound) is valid');
  t.equal(normalizeEquipmentId(201), null, '201 is out of range');
  t.equal(normalizeEquipmentId(-1), null, 'negative values are rejected');
  t.equal(normalizeEquipmentId('abc'), null, 'non-numeric values are rejected');
  t.equal(normalizeEquipmentId(''), null, 'an empty string means unset');
  t.equal(normalizeEquipmentId(undefined), null, 'undefined means unset');
});

test('parse() exposes the equipment ID alongside power and cadence', t => {
  t.plan(2);
  const {payload} = parse(Buffer.from(KEISER_DATA_HEX, 'hex'));
  t.equal(payload.equipmentId, DOCUMENTED_EQUIPMENT_ID, 'equipment ID is carried through');
  t.equal(payload.power, 115, 'power still decodes');
});

test('createKeiserPeripheralFilter() can select a console by equipment ID when the address is unknown', t => {
  t.plan(3);
  const filter = createKeiserPeripheralFilter(undefined, DOCUMENTED_EQUIPMENT_ID);
  t.ok(filter(fakeConsole({address: 'unknown'})), 'accepts the console by equipment ID despite the unknown address');
  t.notOk(
    filter(fakeConsole({address: 'unknown', equipmentId: 7})),
    'rejects a neighbouring console whose equipment ID differs'
  );
  t.ok(filter(fakeConsole({address: 'C0:FF:EE:00:00:09'})), 'still accepts the console after a MAC rotation');
});

test('createKeiserPeripheralFilter() keeps the pinned MAC working alongside an equipment ID', t => {
  t.plan(2);
  const filter = createKeiserPeripheralFilter('c0:ff:ee:00:00:01', DOCUMENTED_EQUIPMENT_ID);
  t.ok(
    filter(fakeConsole({address: 'C0:FF:EE:00:00:01', equipmentId: 9})),
    'the pinned MAC still matches even when the console omits its configured ID'
  );
  t.notOk(
    filter(fakeConsole({address: 'C0:FF:EE:00:00:02', equipmentId: 9})),
    'a different console matches neither selector'
  );
});

test('KeiserBikeClient keeps the ride when the pinned console reports an unknown address', t => {
  t.plan(4);
  const client = new KeiserBikeClient(undefined, {address: 'c0:ff:ee:00:00:01'});
  client.peripheral = fakeConsole({address: 'c0:ff:ee:00:00:01'});
  client.peripheralAddress = 'c0:ff:ee:00:00:01';
  client.peripheralEquipmentId = DOCUMENTED_EQUIPMENT_ID;

  t.ok(
    client.isMatchingPeripheral(fakeConsole({address: 'unknown'})),
    'accepts the same console when the adapter reports "unknown" (equipment ID matches)'
  );
  t.notOk(
    client.isMatchingPeripheral(fakeConsole({address: 'unknown', equipmentId: 7})),
    'rejects a neighbouring console whose equipment ID differs'
  );
  t.notOk(
    client.isMatchingPeripheral(fakeConsole({address: 'C0:FF:EE:00:00:02'})),
    'a different usable MAC still loses, even with a matching equipment ID'
  );
  t.ok(
    client.isMatchingPeripheral(fakeConsole({address: 'c0:ff:ee:00:00:01'})),
    'accepts the pinned console by MAC'
  );
});

test('Keiser reception agrees with discovery for a configured equipment ID after MAC rotation', async t => {
  const address = 'c0:ff:ee:00:00:01';
  const first = fakeConsole({address});
  const noble = new EventEmitter();
  noble.state = 'poweredOn';
  let scanCount = 0;
  noble.startScanningAsync = async () => {
    if (++scanCount === 1) setImmediate(() => noble.emit('discover', first));
  };
  noble.stopScanning = () => {};
  const client = new KeiserBikeClient(noble, {address, equipmentId: DOCUMENTED_EQUIPMENT_ID});
  await client.connect();
  const rotated = fakeConsole({address: 'c0:ff:ee:00:00:02'});
  t.ok(createKeiserPeripheralFilter(address, DOCUMENTED_EQUIPMENT_ID)(rotated), 'discovery accepts the configured equipment after rotation');
  t.ok(client.isMatchingPeripheral(rotated), 'live reception uses the same selector');
  t.notOk(client.isMatchingPeripheral(fakeConsole({address: 'c0:ff:ee:00:00:03', equipmentId: 7})), 'a different equipment ID remains excluded');
  let received = 0;
  client.on('stats', () => received++);
  client.onReceive(rotated);
  t.equal(received, 1, 'the rotated console contributes ride telemetry');
  await client.disconnect();
  t.end();
});

test('KeiserBikeClient falls back to the captured payload signature when no equipment ID is available', t => {
  t.plan(2);
  const client = new KeiserBikeClient(undefined, {address: 'c0:ff:ee:00:00:01'});
  client.peripheralAddress = 'c0:ff:ee:00:00:01';
  client.peripheralSignature = '02010630'; // magic + version captured at connect.
  client.peripheralEquipmentId = null;

  t.ok(
    client.isMatchingPeripheral({
      address: 'unknown',
      advertisement: {localName: 'M3i', manufacturerData: Buffer.from('02010630', 'hex')},
    }),
    'accepts the same console when the frame omits the equipment ID'
  );
  t.notOk(
    client.isMatchingPeripheral({
      address: 'unknown',
      advertisement: {localName: 'M3i', manufacturerData: Buffer.from('0201064000', 'hex')},
    }),
    'rejects a console with a different payload signature'
  );
});


test('Keiser holds the shared scan so accessory cleanup cannot stop reception', async t => {
  const address = 'c0:ff:ee:00:00:01';
  const consoleAd = fakeConsole({address});
  const noble = new EventEmitter();
  noble.state = 'poweredOn';
  let scans = 0;
  let stops = 0;
  noble.startScanningAsync = async () => {
    scans += 1;
    if (scans === 1) setImmediate(() => noble.emit('discover', consoleAd));
  };
  noble.stopScanning = () => { stops += 1; };

  const coordinator = new ScanCoordinator(noble, {logger: {warn() {}}});
  const client = new KeiserBikeClient(noble, {address, scanCoordinator: coordinator});
  await client.connect();
  t.ok(coordinator.has(client.scanTag), 'the ride holds a shared scan claim');

  await coordinator.acquire('speed-sensor-1');
  t.equal(await coordinator.release('speed-sensor-1'), false, 'an accessory timeout does not stop the shared scan');
  t.equal(stops, 0, 'the radio was never stopped behind the rider');

  let received = 0;
  client.on('stats', () => received++);
  client.onReceive(consoleAd);
  t.equal(received, 1, 'beacon reception still works after the accessory released');

  await client.disconnect();
  t.equal(coordinator.has(client.scanTag), false, 'disconnect drops the scan claim');
  t.equal(stops, 1, 'the last owner stops the shared scan once');
  t.end();
});
