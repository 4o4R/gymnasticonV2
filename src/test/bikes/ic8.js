import test from '../support/tape.js';
import {Ic8BikeClient} from '../../bikes/ic8.js';

/**
 * Create an IC8 client with a stub noble so no BLE stack is touched.
 */
function createClient() {
  return new Ic8BikeClient({noble: {}});
}

/**
 * Combined wheel + crank CSC packet (flags 0x03): six wheel bytes come first,
 * then the crank revolution count and crank event time.
 */
function combinedPacket({wheelRevolutions, wheelTime, crankRevolutions, crankTimestamp}) {
  const buf = Buffer.alloc(11);
  buf.writeUInt8(0x03, 0);
  buf.writeUInt32LE(wheelRevolutions, 1);
  buf.writeUInt16LE(wheelTime, 5);
  buf.writeUInt16LE(crankRevolutions, 7);
  buf.writeUInt16LE(crankTimestamp, 9);
  return buf;
}

/**
 * Crank-only CSC packet (flags 0x02).
 */
function crankPacket({crankRevolutions, crankTimestamp}) {
  const buf = Buffer.alloc(5);
  buf.writeUInt8(0x02, 0);
  buf.writeUInt16LE(crankRevolutions, 1);
  buf.writeUInt16LE(crankTimestamp, 3);
  return buf;
}

test('onCscData() skips the wheel fields of a combined CSC packet (60 rpm)', t => {
  const client = createClient();
  const stats = [];
  client.on('stats', (value) => stats.push(value));

  // Wheel data is cumulative and irrelevant to cadence, but it shifts the crank
  // offsets by six bytes. One crank revolution per second is 60 rpm.
  client.onCscData(combinedPacket({wheelRevolutions: 10, wheelTime: 2048, crankRevolutions: 100, crankTimestamp: 1024}));
  client.onCscData(combinedPacket({wheelRevolutions: 12, wheelTime: 4096, crankRevolutions: 101, crankTimestamp: 2048}));

  const latest = stats[stats.length - 1];
  t.equal(latest.cadence, 60, 'decodes 60 rpm from the crank half of the packet');
  t.ok(latest.power > 0, 'emits an estimated power for a pedalling rider');
  t.end();
});

test('onCscData() decodes a crank-only CSC packet', t => {
  const client = createClient();
  const stats = [];
  client.on('stats', (value) => stats.push(value));

  client.onCscData(crankPacket({crankRevolutions: 100, crankTimestamp: 1024}));
  client.onCscData(crankPacket({crankRevolutions: 102, crankTimestamp: 2048}));

  t.equal(stats[stats.length - 1].cadence, 120, 'two revolutions in one second is 120 rpm');
  t.end();
});

test('onCscData() ignores malformed CSC frames instead of throwing', t => {
  const client = createClient();
  const stats = [];
  client.on('stats', (value) => stats.push(value));

  t.doesNotThrow(() => client.onCscData(Buffer.from([0x02, 0x64])), 'crank-only frame shorter than 5 bytes is ignored');
  t.doesNotThrow(() => client.onCscData(Buffer.from([0x03, 0, 0, 0, 0, 0, 0, 0x64])), 'combined frame truncated before the crank time is ignored');
  t.doesNotThrow(() => client.onCscData(Buffer.alloc(0)), 'empty frame is ignored');
  t.equal(stats.length, 0, 'no stats emitted for malformed frames');
  t.equal(client.state.rpm, 0, 'no cadence decoded from garbage');
  t.end();
});

test('onCscData() reports 0 rpm and 0 W when the cranks stop advancing', t => {
  const client = createClient();
  const stats = [];
  client.on('stats', (value) => stats.push(value));

  client.onCscData(crankPacket({crankRevolutions: 100, crankTimestamp: 1024}));
  client.onCscData(crankPacket({crankRevolutions: 101, crankTimestamp: 2048}));
  const pedalling = stats[stats.length - 1];
  t.equal(pedalling.cadence, 60, 'pedalling cadence is 60 rpm');
  t.ok(pedalling.power > 0, 'power estimate is non-zero while pedalling');

  // Same crank revolutions and timestamp: the bike keeps notifying while the
  // cranks are stationary.
  client.onCscData(crankPacket({crankRevolutions: 101, crankTimestamp: 2048}));
  const stationary = stats[stats.length - 1];
  t.equal(stationary.cadence, 0, 'cadence drops to 0 instead of holding the previous value');
  t.equal(stationary.power, 0, 'power does not keep the stale estimate');
  t.end();
});
