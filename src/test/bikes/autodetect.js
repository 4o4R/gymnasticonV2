import {EventEmitter} from 'events';

import test from '../support/tape.js';
import {createBikeClient} from '../../bikes/index.js';
import {KeiserBikeClient} from '../../bikes/keiser.js';
import {Ic8BikeClient} from '../../bikes/ic8.js';

test('Ic8BikeClient.matchesAdvertisement() recognizes C6/IC8 bikes by name', (t) => {
  t.ok(Ic8BikeClient.matchesAdvertisement({advertisement: {localName: 'Bowflex C6'}}), 'matches by Bowflex C6 name');
  t.ok(Ic8BikeClient.matchesAdvertisement({advertisement: {localName: 'IC8'}}), 'matches by IC8 name');
  t.end();
});

test('Ic8BikeClient.matchesAdvertisement() matches by fitness service when the name is missing', (t) => {
  t.ok(Ic8BikeClient.matchesAdvertisement({advertisement: {serviceUuids: ['1826']}}), 'matches FTMS service UUID without a name');
  t.ok(Ic8BikeClient.matchesAdvertisement({advertisement: {serviceUuids: ['1816']}}), 'matches CSC service UUID without a name');
  t.notOk(Ic8BikeClient.matchesAdvertisement({advertisement: {serviceUuids: ['fe9f']}}), 'rejects unrelated service UUIDs');
  t.notOk(Ic8BikeClient.matchesAdvertisement({advertisement: {}}), 'rejects an empty advertisement');
  t.end();
});

test('autodetect reports what the radio saw and falls back with actionable feedback', async (t) => {
  const noble = new EventEmitter();
  noble.startScanningAsync = async () => {};
  noble.stopScanningAsync = async () => {};

  const logs = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => { logs.push(args.join(' ')); };
  console.warn = (...args) => { logs.push(args.join(' ')); };

  try {
    // 3ms scan window: short enough for a fast test, long enough to receive
    // the discovery events emitted on the next tick.
    const pending = createBikeClient(
      {bike: 'autodetect', defaultBike: 'keiser', bikeConnectTimeout: 0.003, pelotonPath: undefined},
      noble
    );
    setTimeout(() => {
      noble.emit('discover', {address: 'aa:bb:cc:dd:ee:01', advertisement: {localName: 'RandomThing'}});
      noble.emit('discover', {address: 'aa:bb:cc:dd:ee:02', advertisement: {serviceUuids: ['fe9f']}});
    }, 0);

    const client = await pending;

    t.ok(client instanceof KeiserBikeClient, 'falls back to the configured default bike (keiser)');
    const text = logs.join('\n');
    t.ok(text.includes('No supported bike found'), 'logs that no supported bike was found');
    t.ok(text.includes('2 BLE device(s) seen'), 'reports how many devices the radio actually saw');
    t.ok(text.includes('RandomThing'), 'reports a sample of the device names that were seen');
    t.ok(text.includes('default bike: keiser'), 'announces the fallback destination');
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
  t.end();
});

test('autodetect warns when the radio sees no advertisements at all', async (t) => {
  const noble = new EventEmitter();
  noble.startScanningAsync = async () => {};
  noble.stopScanningAsync = async () => {};

  const logs = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => { logs.push(args.join(' ')); };
  console.warn = (...args) => { logs.push(args.join(' ')); };

  try {
    const client = await createBikeClient(
      {bike: 'autodetect', defaultBike: 'keiser', bikeConnectTimeout: 0.002, pelotonPath: undefined},
      noble
    );

    t.ok(client instanceof KeiserBikeClient, 'still falls back to the default bike');
    const text = logs.join('\n');
    t.ok(text.includes('0 BLE device(s) seen'), 'reports zero devices seen');
    t.ok(text.includes('radio saw no advertisements'), 'points the user at the bike/radio');
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
  t.end();
});
