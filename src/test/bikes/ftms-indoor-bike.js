import test from '../support/tape.js';
import {
  FTMS_SERVICE_UUID,
  INDOOR_BIKE_DATA_UUID,
  parseIndoorBikeData
} from '../../bikes/ftms-indoor-bike.js';

/**
 * Encode an Indoor Bike Data frame: the 16-bit flag word followed by the
 * payload bytes the caller lists (already in flag order).
 */
function frame(flags, ...fields) {
  const header = Buffer.alloc(2);
  header.writeUInt16LE(flags, 0);
  return Buffer.concat([header, ...fields].map(part => Buffer.isBuffer(part) ? part : Buffer.from(part)));
}

function u16(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value, 0);
  return buf;
}

function u24(value) {
  const buf = Buffer.alloc(3);
  buf.writeUIntLE(value, 0, 3);
  return buf;
}

function s16(value) {
  const buf = Buffer.alloc(2);
  buf.writeInt16LE(value, 0);
  return buf;
}

test('ftms-indoor-bike exports the service and characteristic UUIDs used by these consoles', t => {
  t.equal(FTMS_SERVICE_UUID, '1826', 'Fitness Machine Service');
  t.equal(INDOOR_BIKE_DATA_UUID, '2ad2', 'Indoor Bike Data characteristic');
  t.end();
});

test('parseIndoorBikeData() decodes the IC4 console frame', t => {
  const parsed = parseIndoorBikeData(Buffer.from('4402da020201220100', 'hex'));
  t.equal(parsed.power, 290, 'power (watts)');
  t.equal(parsed.cadence, 129, 'cadence (rpm)');
  t.ok(Math.abs(parsed.speed - (730 / 100) * (1000 / 3600)) < 1e-9, 'speed converted from 0.01 km/h to m/s');
  t.end();
});

test('parseIndoorBikeData() walks the optional fields that precede cadence and power', t => {
  // flags 0x004e = average speed (bit1), instantaneous cadence (bit2),
  // average cadence (bit3) and instantaneous power (bit6); bit 0 is clear so
  // instantaneous speed is present first.
  const data = frame(0x004e, u16(300), u16(400), u16(150), u16(200), u16(500));
  const parsed = parseIndoorBikeData(data);
  t.equal(parsed.cadence, 75, 'cadence read after the two speed fields');
  t.equal(parsed.power, 500, 'power read after the average cadence field');
  t.ok(Math.abs(parsed.speed - (300 / 100) * (1000 / 3600)) < 1e-9, 'instantaneous speed is the first field');
  t.end();
});

test('parseIndoorBikeData() walks the 3-byte total distance and the resistance level', t => {
  // flags 0x0075 = no speed (bit0 set), cadence (bit2), distance (bit4),
  // resistance level (bit5), power (bit6).
  const data = frame(0x0075, u16(100), u24(1000), u16(20), u16(400));
  const parsed = parseIndoorBikeData(data);
  t.equal(parsed.cadence, 50, 'cadence read after nothing but the flag word');
  t.equal(parsed.power, 400, 'power read after distance + resistance');
  t.equal(parsed.speed, undefined, 'bit0 set means speed is absent');
  t.end();
});

test('parseIndoorBikeData() omits speed when flag bit 0 reports it absent', t => {
  // flags 0x0045 = no instantaneous speed (bit0 set), cadence, power.
  const parsed = parseIndoorBikeData(frame(0x0045, u16(150), u16(500)));
  t.equal(parsed.cadence, 75, 'cadence decoded');
  t.equal(parsed.power, 500, 'power decoded');
  t.notOk('speed' in parsed, 'speed key is absent rather than zero');
  t.end();
});

test('parseIndoorBikeData() returns nothing but the fields the flags declare', t => {
  // flags 0x0001 = "more data" set and no other field: an empty-but-valid frame.
  const parsed = parseIndoorBikeData(frame(0x0001));
  t.deepEqual(parsed, {}, 'no optional field is invented');
  t.end();
});

test('parseIndoorBikeData() reads power as a signed 16-bit value', t => {
  const high = parseIndoorBikeData(frame(0x0041, u16(2000)));
  t.equal(high.power, 2000, 'power above 255 uses both bytes');

  // FTMS defines instantaneous power as sint16, so regenerative braking is negative.
  const negative = parseIndoorBikeData(frame(0x0041, s16(-20)));
  t.equal(negative.power, -20, 'negative power survives the decode');
  t.end();
});

test('parseIndoorBikeData() rejects frames truncated inside a declared field', t => {
  t.throws(() => parseIndoorBikeData(frame(0x0045, u16(150))), /^Error: unable to parse message$/, 'power is missing');
  t.throws(() => parseIndoorBikeData(frame(0x0045, Buffer.from([0x96]))), /^Error: unable to parse message$/, 'cadence is half present');
  t.throws(() => parseIndoorBikeData(frame(0x0075, u16(100), u24(1000), u16(20))), /^Error: unable to parse message$/, 'power missing after the resistance field');
  t.end();
});

test('parseIndoorBikeData() walks average power (bit 7) and rejects a frame truncated there', t => {
  // flags 0x00c5 = no speed, cadence, instantaneous power, average power.
  const complete = parseIndoorBikeData(frame(0x00c5, u16(100), u16(400), u16(380)));
  t.equal(complete.cadence, 50, 'cadence decoded');
  t.equal(complete.power, 400, 'instantaneous power decoded');

  t.throws(
    () => parseIndoorBikeData(frame(0x00c5, u16(100), u16(400))),
    /unable to parse message/,
    'a declared average power field that never arrived is a truncation, not a valid frame'
  );
  t.end();
});

test('parseIndoorBikeData() rejects values that are not an Indoor Bike Data frame', t => {
  t.throws(() => parseIndoorBikeData(undefined), /unable to parse message/, 'no buffer');
  t.throws(() => parseIndoorBikeData(null), /unable to parse message/, 'null');
  t.throws(() => parseIndoorBikeData(Buffer.alloc(0)), /unable to parse message/, 'no flag word');
  t.throws(() => parseIndoorBikeData(Buffer.alloc(1)), /unable to parse message/, 'half a flag word');
  t.throws(() => parseIndoorBikeData([0x45, 0x00]), /unable to parse message/, 'plain array instead of a buffer');
  t.throws(() => parseIndoorBikeData('4500'), /unable to parse message/, 'string instead of a buffer');
  t.end();
});
