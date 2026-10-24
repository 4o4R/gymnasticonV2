import EventEmitter from 'events';

import test from '../support/tape.js';
import {stopBluetoothStack} from '../../util/bluetooth-shutdown.js';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a fake HCI helper whose poller behaves like noble's/bleno's:
 * every tick schedules the next one by reading `this.pollIsDevUp` again.
 */
function createFakeHci({withSocket = true} = {}) {
  const state = {
    polls: 0,
    socketStops: 0,
    listenerDetaches: 0,
  };

  const hci = {
    pollIsDevUp() {
      state.polls += 1;
      setTimeout(this.pollIsDevUp.bind(this), 2);
    },
  };

  if (withSocket) {
    hci._socket = {
      stop() {
        state.socketStops += 1;
      },
      removeAllListeners() {
        state.listenerDetaches += 1;
      },
    };
  }

  return {hci, state};
}

test('stopBluetoothStack() stops a self-rescheduling noble poller', async (t) => {
  const {hci, state} = createFakeHci();
  const stack = {_bindings: {_hci: hci}};

  hci.pollIsDevUp(); // Start the chain the way noble does on init.
  await delay(10);
  t.ok(state.polls > 1, 'the poller keeps rescheduling before shutdown');

  t.equal(stopBluetoothStack(stack), true, 'shutdown reports that it released the radio');
  t.equal(state.socketStops, 1, 'the native socket stop is called once');
  t.equal(state.listenerDetaches, 1, 'the socket listeners are detached');

  const pollsAtShutdown = state.polls;
  await delay(20);
  t.ok(
    state.polls - pollsAtShutdown <= 1,
    `the poll chain dies instead of rescheduling forever (extra polls: ${state.polls - pollsAtShutdown})`
  );

  const settledPolls = state.polls;
  await delay(20);
  t.equal(state.polls, settledPolls, 'no further polls are scheduled');

  t.equal(stopBluetoothStack(stack), false, 'repeated shutdown is a no-op');
  t.equal(state.socketStops, 1, 'the socket stop is not repeated');
});

test('stopBluetoothStack() handles the bleno `_hci` shape', async (t) => {
  const {hci, state} = createFakeHci();
  const stack = new EventEmitter();
  stack._hci = hci;

  hci.pollIsDevUp();
  await delay(6);

  t.equal(stopBluetoothStack(stack), true, 'the bleno shape is released');
  t.equal(state.socketStops, 1, 'the bleno socket is stopped once');

  const pollsAtShutdown = state.polls;
  await delay(20);
  t.ok(state.polls - pollsAtShutdown <= 1, 'the bleno poll chain also dies');
});

test('stopBluetoothStack() neutralizes the poller even without a native socket', async (t) => {
  const {hci, state} = createFakeHci({withSocket: false});
  const stack = {_bindings: {_hci: hci}};

  hci.pollIsDevUp();
  await delay(6);

  t.equal(stopBluetoothStack(stack), true, 'the poller alone is worth releasing');

  const pollsAtShutdown = state.polls;
  await delay(20);
  t.ok(state.polls - pollsAtShutdown <= 1, 'the poll chain dies without a socket');
});

test('stopBluetoothStack() tolerates malformed stacks', (t) => {
  const malformed = [
    undefined,
    null,
    0,
    'noble',
    {},
    {_bindings: null},
    {_bindings: {}},
    {_bindings: {_hci: null}},
    {_bindings: {_hci: 'not-an-object'}},
    {_bindings: {_hci: {_socket: null}}},
    {_bindings: {_hci: {_socket: 42}}},
    {_hci: {}},
  ];

  for (const stack of malformed) {
    t.doesNotThrow(() => {
      stopBluetoothStack(stack);
    }, `malformed stack ${JSON.stringify(stack)} does not throw`);
  }

  t.equal(stopBluetoothStack(new EventEmitter()), false, 'a stub without native bindings reports no work');
  t.end();
});
