import test from '../support/tape.js';
import {parse} from '../../bikes/flywheel.js';

test('parse() parses Flywheel stats messages', t => {
  t.plan(3);
  const buf = Buffer.from('ff1f0c0122000000000000005a00000000000000000000000000000a000000016155', 'hex');
  const {type, payload: {power, cadence}} = parse(buf);
  t.equal(type, 'stats', 'message type');
  t.equal(power, 290, 'power (watts)');
  t.equal(cadence, 90, 'cadence (rpm)');
});

test('parse() rejects short Flywheel frames gracefully (no RangeError crash)', t => {
  t.plan(1);
  // Stats magic prefix followed by a truncated payload.
  const buf = Buffer.from('ff1f0c0122', 'hex');
  t.throws(() => parse(buf), /unable to parse message/, 'throws the graceful parse error, not RangeError');
});
