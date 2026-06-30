import {EventEmitter} from 'events';

import test from '../support/tape.js';
import {createFilter, createNameFilter, createAddressFilter, scan} from '../../util/ble-scan.js';

// peripherals
const match = {address: '11-11-11-11-11-11', advertisement: { localName: 'Match'}};
const other = {address: '00-00-00-00-00-00', advertisement: { localName: 'Other'}};
const empty = {};

test('createFilter()', t => {
  t.plan(4);
  const allMatch = createFilter({ name: 'Match', address: '11-11-11-11-11-11' });
  const addressMatches = createFilter({ name: 'Natch', address: '11-11-11-11-11-11' });
  const nameMatches = createFilter({ name: 'Match', address: '11-11-11-11-11-10' });
  const noneMatch = createFilter({ name: 'Natch', address: '11-11-11-11-11-10' });
  t.ok(allMatch(match), 'true when all match');
  t.notOk(addressMatches(match), 'false when only address matches');
  t.notOk(nameMatches(match), 'false when only name matches');
  t.notOk(noneMatch(match), 'false when none match');
});

test('createNameFilter()', t => {
  t.plan(3);
  const filter = createNameFilter('Match');
  t.ok(filter(match), 'true when name matches');
  t.notOk(filter(other), 'false when name does not match');
  t.notOk(filter(empty), 'false when name given but peripheral name is missing');
});

test('createAddressFilter()', t => {
  t.plan(3);
  const filter = createAddressFilter('11-11-11-11-11-11');
  t.ok(filter(match), 'true when address matches');
  t.notOk(filter(other), 'false when address does not match');
  t.notOk(filter(empty), 'false when address given but peripheral address is missing');
});

test('scan() can timeout without falling back to hcitool', async (t) => {
  const noble = new EventEmitter();
  let startCalls = 0;
  let stopCalls = 0;
  noble.startScanningAsync = async () => {
    startCalls += 1;
  };
  noble.stopScanningAsync = async () => {
    stopCalls += 1;
  };

  const result = await scan(noble, ['181a'], () => false, {
    timeoutMs: 1,
    stopScanOnTimeout: true,
    fallbackOnTimeout: false,
  });

  t.equal(result, null, 'returns null when the noble scan times out');
  t.equal(startCalls, 1, 'starts a noble scan');
  t.equal(stopCalls, 1, 'stops the noble scan on timeout');
  t.end();
});
