import test from 'tape';
import {parse} from '../../bikes/ic4.js';

test('parse() parses Schwinn IC4 indoor bike data values', t => {
  t.plan(2);
  const buf = Buffer.from('4402da020201220100', 'hex');
  const {power, cadence} = parse(buf);
  t.equal(power, 290, 'power (watts)');
  t.equal(cadence, 129, 'cadence (rpm)');
});
