import {EventEmitter} from 'events';

import test from '../support/tape.js';
import {App} from '../../app/app.js';

function createTestApp() {
  const noble = new EventEmitter();
  noble.state = 'poweredOn';

  const healthMonitor = {
    on() {},
    stop() {},
    recordMetric() {},
  };

  return new App({
    noble,
    antEnabled: false,
    healthMonitor,
    bleMultiOutput: false,
    serverAdapters: ['hci0'],
  });
}

function destroyTestApp(app) {
  process.removeListener('unhandledRejection', app.errorHandler);
  process.removeListener('uncaughtException', app.errorHandler);
  process.removeListener('SIGINT', app.onSigInt);
  process.removeListener('exit', app.onExit);
}

test('App.onBikeDisconnect() tolerates an early disconnect before BLE startup', (t) => {
  const app = createTestApp();
  try {
    t.doesNotThrow(() => {
      app.onBikeDisconnect({address: '00:00:00:00:00:00'});
    }, 'disconnect handler should not require an initialized BLE server');

    t.equal(app.pendingRestartReason, 'bike-disconnect', 'disconnect still requests a restart');
  } finally {
    destroyTestApp(app);
  }
  t.end();
});

test('App.onHeartRate() ignores heart-rate updates before the BLE server exists', (t) => {
  const app = createTestApp();
  try {
    t.doesNotThrow(() => {
      app.onHeartRate(123);
    }, 'heart-rate updates before BLE startup are ignored');
  } finally {
    destroyTestApp(app);
  }

  t.end();
});

test('App.clearRestartRequest() removes stale restart state after a failed startup', (t) => {
  const app = createTestApp();
  try {
    app.requestRestart('bike-disconnect');
    app.clearRestartRequest();

    t.equal(app.pendingRestartReason, null, 'pending restart reason cleared');
    t.equal(app.restartReason, null, 'active restart reason cleared');
    t.equal(app.restartSignal, null, 'restart signal cleared');
  } finally {
    destroyTestApp(app);
  }

  t.end();
});

test('App.run() retries cold-start bike discovery until a bike appears, then starts advertising', async (t) => {
  const logs = [];
  const sleepCalls = [];
  const serverEvents = [];
  let connectionAttempt = 0;

  const server = {
    async start() {
      serverEvents.push(`start:${connectionAttempt}`);
    },
    async stop() {
      serverEvents.push(`stop:${connectionAttempt}`);
    },
    ensureCscCapabilities() {},
    updatePower() {},
    updateCsc() {},
    updateHeartRate() {},
  };

  const app = createTestApp();
  try {
    app.createBikeClient = async () => {
      const attempt = ++connectionAttempt;
      const bike = new EventEmitter();
      bike.address = 'AA:BB:CC:DD:EE:FF';
      bike.connect = async () => {
        logs.push(`connect:${attempt}`);
        if (attempt === 1) {
          throw new Error('bike asleep');
        }
      };
      bike.disconnect = async () => {
        logs.push(`disconnect:${attempt}`);
      };
      return bike;
    };
    app.sleep = async (ms) => {
      sleepCalls.push(ms);
    };
    app.minimumRetryDelayMs = 0;
    app.opts.connectionRetryDelay = 25;
    app.server = server;
    app.logger = {
      log: (...args) => logs.push(`log:${args.join(' ')}`),
      warn: (...args) => logs.push(`warn:${args.join(' ')}`),
      error: (...args) => logs.push(`error:${args.join(' ')}`),
    };
    app.attachNobleDiagnostics = () => {};
    app.ensureBluetoothPoweredOn = async () => {};
    app.startOptionalSensors = async () => {
      logs.push('optional-sensors-started');
    };
    app.waitForRestartSignal = async () => {
      logs.push('wait-for-restart');
      app.keepRunning = false;
    };

    await app.run();

    t.equal(connectionAttempt, 2, 'bike discovery retried after the initial cold-start miss');
    t.deepEqual(sleepCalls, [25], 'retry delay applied between cold-start attempts');
    t.equal(serverEvents[0], 'start:2', 'BLE advertising only starts after the successful connect');
    t.ok(logs.includes('optional-sensors-started'), 'optional sensors start after the bike connects');
    t.ok(logs.includes('wait-for-restart'), 'run loop reaches steady connected state after the bike appears');
  } finally {
    destroyTestApp(app);
  }
});
