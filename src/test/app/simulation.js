import test from '../support/tape.js';
import sinon from '../support/sinon.js';
import {Simulation} from '../../app/simulation.js';

test('constant cadence', async t => {
  const timeline = [
    cadenceChange(0, 60),
    pedalEvent(0),
    pedalEvent(1000),
    pedalEvent(2000),
    pedalEvent(3000),
  ];
  
  await testTimeline(timeline, t);
});

test('start/stop/start', async t => {
  const timeline = [
    cadenceChange(0, 60),
    pedalEvent(0),
    pedalEvent(1000),
    pedalEvent(2000),
    pedalEvent(3000),

    cadenceChange(3001, 0),

    cadenceChange(100000, 1000),
    pedalEvent(100000),
    pedalEvent(100060),
  ]

  await testTimeline(timeline, t);
});

test('inconsequential cadence changes', async t => {
  const timeline = [
    cadenceChange(0, 10),
    pedalEvent(0),
    pedalEvent(6000),
    pedalEvent(12000),
    cadenceChange(12001, 20),
    cadenceChange(12002, 30),
    cadenceChange(12020, 40),
    cadenceChange(12100, 50),
    cadenceChange(12150, 120),
    cadenceChange(12499, 60),
    cadenceChange(12999, 30),
    pedalEvent(14000),
  ]

  await testTimeline(timeline, t);
});

test('increase/decrease cadence', async t => {
  const timeline = [
    cadenceChange(0, 10),
    pedalEvent(0),
    pedalEvent(6000),

    cadenceChange(6001, 1000),
    pedalEvent(6060),
    pedalEvent(6120),
    pedalEvent(6180),

    cadenceChange(6181, 60),
    pedalEvent(7180),
    pedalEvent(8180),
  ]

  await testTimeline(timeline, t);
});

test('varying cadence', async t => {
  const timeline = [
    cadenceChange(0, 60),
    pedalEvent(0),
    pedalEvent(1000),
    pedalEvent(2000),

    cadenceChange(2001, 120),
    pedalEvent(2500),
    pedalEvent(3000),

    cadenceChange(3100, 30),
    pedalEvent(5000),
    pedalEvent(7000),

    cadenceChange(8999, 10),
    pedalEvent(13000),
    pedalEvent(19000),

    cadenceChange(24999, 1000),
    pedalEvent(24999),
    pedalEvent(25059),
    pedalEvent(25119),

    cadenceChange(25178, 60),
    pedalEvent(26119),
  ]

  await testTimeline(timeline, t);
});


const C = 'CADENCE_CHANGE';
const P = 'PEDAL_EMIT';
const cadenceChange = (timestamp, cadence) => ({timestamp, type: C, cadence})
const pedalEvent = (timestamp) => ({timestamp, type: P})
const isPedalEvent = (evt) => evt.type === P
const isCadenceChange = (evt) => evt.type === C

/**
 * Test that pedal events are emitted with the expected timestamps.
 * @param {object[]} timeline - timestamped events (pedal or cadence change)
 * @param {string} timeline[].type - event type P|C (pedal or cadence change)
 * @param {number} timeline[].timestamp - millisecond timestamp
 * @param {number} [timeline[].cadence] - cadence in rpm (only for cadence change event)
 * @param {Test} t - tape test object
 * @returns {Promise<void>} resolves once all simulated pedal events have fired
 */
async function testTimeline(timeline, t) {
  const timestamps = timeline.filter(isPedalEvent).map(e => e.timestamp);
  const cadenceChanges = timeline.filter(isCadenceChange);
  const duration = Math.max(...timestamps);

  const clock = sinon.useFakeTimers();
  const sim = new Simulation();

  // change sim.cadence at the appropriate times
  for (let {timestamp, cadence} of cadenceChanges) {
    setTimeout(() => { sim.cadence = cadence; }, timestamp);
  }

  t.plan(timestamps.length);

  let i = 0;
  sim.on('pedal', (timestamp) => {
    t.equal(timestamp, timestamps[i], `pedal event ${timestamp}`);
    i++;
  });

  // Tick slightly beyond the last expected timestamp so that any timers
  // scheduled exactly at `duration` have a chance to fire before we restore.
  await clock.tickAsync(duration + 1);
  // Newer versions of @sinonjs/fake-timers queue callbacks that are added while
  // tick() is running. runAllAsync() flushes any stragglers so every planned
  // assertion fires before we restore the originals.
  await clock.runAllAsync();
  clock.restore();
}
