import test from '../support/tape.js';
import {parse} from '../../bikes/ic4.js';

test('parse() parses Schwinn IC4 indoor bike data values', t => {
  t.plan(2);
  const buf = Buffer.from('4402da020201220100', 'hex');
  const {power, cadence} = parse(buf);
  t.equal(power, 290, 'power (watts)');
  t.equal(cadence, 129, 'cadence (rpm)');
});

test('parse() rejects short IC4 frames gracefully (no RangeError crash)', t => {
  t.plan(1);
  // Magic byte 0x44 followed by a truncated payload.
  const buf = Buffer.from('4402da02', 'hex');
  t.throws(() => parse(buf), /unable to parse message/, 'throws the graceful parse error, not RangeError');
});
