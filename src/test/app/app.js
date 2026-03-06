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
