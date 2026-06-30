import {EventEmitter} from 'events';

import test from '../support/tape.js';
import {App, resolveServerAdapters} from '../../app/app.js';
import {options as cliOptions} from '../../app/cli-options.js';
import {DEFAULT_NAME as DEFAULT_SERVER_NAME} from '../../servers/ble/index.js';
import {chooseAdapterRoles} from '../../util/adapter-detect.js';

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

test('App defaults use the GymnasticonV2 BLE advertisement name', (t) => {
  const app = createTestApp();
  try {
    t.equal(app.opts.serverName, 'GymnasticonV2', 'app default server name matches the BLE branding choice');
    t.equal(DEFAULT_SERVER_NAME, 'GymnasticonV2', 'BLE server fallback name matches the app default');
  } finally {
    destroyTestApp(app);
  }

  t.end();
});

test('App.integrateKinematics() keeps CSC event timestamps stable until revolutions change', (t) => {
  const app = createTestApp();
  try {
    app.integrateKinematics(0, 0, 100);
    t.equal(app.crank.revolutions, 0, 'starts with zero crank revolutions');
    t.equal(app.wheel.revolutions, 0, 'starts with zero wheel revolutions');
    t.equal(app.crank.timestamp, 0, 'crank event timestamp stays at zero before first revolution');
    t.equal(app.wheel.timestamp, 0, 'wheel event timestamp stays at zero before first revolution');

    app.integrateKinematics(0, 0, 110);
    t.equal(app.crank.timestamp, 0, 'crank timestamp does not advance when cadence is zero');
    t.equal(app.wheel.timestamp, 0, 'wheel timestamp does not advance when speed is zero');

    app.integrateKinematics(120, 8, 111);
    t.ok(app.crank.revolutions > 0, 'crank revolutions advance when cadence is positive');
    t.ok(app.wheel.revolutions > 0, 'wheel revolutions advance when speed is positive');
    t.equal(app.crank.timestamp, 111, 'crank timestamp moves to the sample time when a crank revolution occurs');
    t.equal(app.wheel.timestamp, 111, 'wheel timestamp moves to the sample time when a wheel revolution occurs');
  } finally {
    destroyTestApp(app);
  }

  t.end();
});

test('App.startOptionalSensors() delays and serializes optional speed/cadence discovery', async (t) => {
  const app = createTestApp();
  const order = [];
  try {
    app.hrClient = null;
    app.sensorDiscoveryDelayMs = 7;
    app.sleep = async (ms) => {
      order.push(`sleep:${ms}`);
    };
    app.connectSpeedSensor = async () => {
      order.push('speed-start');
      await Promise.resolve();
      order.push('speed-end');
    };
    app.connectCadenceSensor = async () => {
      order.push('cadence-start');
    };

    await app.startOptionalSensors();

    t.deepEqual(order, ['sleep:7', 'speed-start', 'speed-end', 'cadence-start'], 'speed and cadence discovery run after the delay and do not overlap');
  } finally {
    destroyTestApp(app);
  }
});

test('App.connectSpeedSensor()/connectCadenceSensor() use conservative optional sensor options', async (t) => {
  const app = createTestApp();
  const constructed = [];
  class FakeSensorClient extends EventEmitter {
    constructor(noble, options) {
      super();
      constructed.push({noble, options});
    }
    async connect() {}
    async disconnect() {}
  }

  try {
    app.SpeedSensorClient = FakeSensorClient;
    app.CadenceSensorClient = FakeSensorClient;

    await app.connectSpeedSensor();
    await app.connectCadenceSensor();

    t.equal(constructed.length, 2, 'both optional sensor clients are constructed');
    constructed.forEach(({noble, options}) => {
      t.equal(noble, app.noble, 'uses the bike noble instance for optional accessory scans');
      t.equal(options.connectTimeout, 8, 'uses the short optional accessory scan window');
      t.equal(options.retryDelay, 60000, 'starts no-sensor retries at one minute');
      t.equal(options.maxRetryDelay, 300000, 'caps no-sensor retry delay at five minutes');
    });
  } finally {
    await app.stopOptionalSensorDiscovery('test').catch(() => {});
    destroyTestApp(app);
  }
});

test('App.connectHeartRateSensor() does not double-attach the heart-rate listener', async (t) => {
  const app = createTestApp();
  const hrClient = new EventEmitter();
  hrClient.connect = async () => {};
  hrClient.disconnect = async () => {};
  try {
    app.hrClient = hrClient;
    app.hrClient.on('heartRate', app.onHeartRateBound);

    await app.connectHeartRateSensor();

    const listenerCount = app.hrClient.listeners('heartRate')
      .filter(listener => listener === app.onHeartRateBound)
      .length;
    t.equal(listenerCount, 1, 'heart-rate handler remains attached once');
  } finally {
    destroyTestApp(app);
  }
});

test('App.onBikeDisconnect() stops optional speed/cadence sensor discovery', async (t) => {
  const app = createTestApp();
  let speedDisconnects = 0;
  let cadenceDisconnects = 0;
  class FakeSensorClient extends EventEmitter {
    constructor(onDisconnect) {
      super();
      this.onDisconnect = onDisconnect;
    }
    async disconnect() {
      this.onDisconnect();
    }
  }

  try {
    app.speedSensor = new FakeSensorClient(() => {
      speedDisconnects += 1;
    });
    app.cadenceSensor = new FakeSensorClient(() => {
      cadenceDisconnects += 1;
    });
    app.speedSensorConnected = true;
    app.cadenceSensorConnected = true;
    app.stopServerAdvertising = async () => {};

    app.onBikeDisconnect({address: 'AA:BB:CC:DD:EE:FF'});
    await Promise.resolve();

    t.equal(speedDisconnects, 1, 'speed sensor discovery is stopped');
    t.equal(cadenceDisconnects, 1, 'cadence sensor discovery is stopped');
    t.equal(app.speedSensor, null, 'speed client reference is cleared');
    t.equal(app.cadenceSensor, null, 'cadence client reference is cleared');
    t.equal(app.speedSensorConnected, false, 'speed connected state is cleared');
    t.equal(app.cadenceSensorConnected, false, 'cadence connected state is cleared');
    t.equal(app.pendingRestartReason, 'bike-disconnect', 'bike reconnect is still requested');
  } finally {
    destroyTestApp(app);
  }
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

test('App.ensureBluetoothPoweredOn() reinitializes when adapter is up but probe scan fails', async (t) => {
  const app = createTestApp();
  let setBikeAdapterCalls = 0;
  let reinitCalls = 0;
  let waitCalls = 0;
  try {
    app.noble.state = 'unknown';
    app.attachNobleDiagnostics = () => {};
    app.isAdapterUp = () => true;
    app.probeNobleScan = async () => false;
    app.waitForNobleStateChange = async () => {
      waitCalls += 1;
      return 'unknown';
    };
    app.getFallbackAdapters = () => ['hci1'];
    app.setBikeAdapter = () => {
      setBikeAdapterCalls += 1;
      return true;
    };
    app.reinitializeNoble = async () => {
      reinitCalls += 1;
      app.noble.state = 'poweredOn';
    };

    await app.ensureBluetoothPoweredOn();

    t.equal(waitCalls, 0, 'does not wait for stateChange when scan probe already proved adapter is unusable');
    t.equal(setBikeAdapterCalls, 1, 'tries a fallback adapter when available');
    t.equal(reinitCalls, 1, 'reinitializes noble instead of continuing in degraded mode');
  } finally {
    destroyTestApp(app);
  }
});

test('App.ensureBluetoothPoweredOn() returns immediately when adapter-up probe succeeds', async (t) => {
  const app = createTestApp();
  let reinitCalls = 0;
  try {
    app.noble.state = 'unknown';
    app.attachNobleDiagnostics = () => {};
    app.isAdapterUp = () => true;
    app.probeNobleScan = async () => true;
    app.reinitializeNoble = async () => {
      reinitCalls += 1;
    };

    await app.ensureBluetoothPoweredOn();
    t.equal(reinitCalls, 0, 'skips reinitialization when scan probe proves noble can scan');
  } finally {
    destroyTestApp(app);
  }
});

test('App.startAnt() treats ANT+ as USB transport independent from BLE adapter assignment', (t) => {
  const app = createTestApp();
  const logs = [];
  let started = 0;
  try {
    app.antEnabled = true;
    app.logger = {
      log: (...args) => logs.push(args.join(' ')),
      warn: () => {},
      error: () => {},
    };
    app.antStick = {
      is_present: () => true,
      open: () => true,
      on() {},
      close() {},
    };
    app.antServer = {
      isRunning: false,
      start: () => {
        started += 1;
      },
      stop() {},
    };

    app.setBikeAdapter('hci1', 'test-fallback');
    app.startAnt();

    t.equal(started, 1, 'ANT+ server starts even after bike BLE adapter is reassigned');
    t.ok(
      logs.some(line => line.includes('BLE adapter selection does not affect ANT+ USB transport')),
      'logs clarify that ANT+ uses separate USB transport'
    );
  } finally {
    destroyTestApp(app);
  }

  t.end();
});

test('App.logRadioMap() reports bike/advertise/hr/ant assignments in one line', (t) => {
  const app = createTestApp();
  const logs = [];
  try {
    app.logger = {
      log: (...args) => logs.push(args.join(' ')),
      warn() {},
      error() {},
    };
    app.opts.bikeAdapter = 'hci0';
    app.serverAdapters = ['hci1'];
    app.hrClient = null;
    app.antEnabled = true;
    app.antStick = { is_present: () => true };

    app.logRadioMap();

    const line = logs.find(entry => entry.includes('[gym-app] radio map:'));
    t.ok(line, 'radio map log line emitted');
    t.ok(line.includes('bike-scan=hci0'), 'bike adapter included');
    t.ok(line.includes('ble-advertise=hci1'), 'advertising adapter included');
    t.ok(line.includes('hr-scan=disabled'), 'hr role included');
    t.ok(line.includes('ant=enabled-stick-present'), 'ant role included');
  } finally {
    destroyTestApp(app);
  }

  t.end();
});

test('adapter role detection prefers onboard/non-USB for bike and USB for BLE server', (t) => {
  const roles = chooseAdapterRoles([
    { name: 'hci0', type: 'unknown' },
    { name: 'hci1', type: 'usb' },
  ]);

  t.equal(roles.bikeAdapter, 'hci0', 'unknown non-USB adapter is treated as the onboard bike radio');
  t.equal(roles.serverAdapter, 'hci1', 'USB adapter is selected for BLE advertising');
  t.equal(roles.multiAdapter, true, 'two HCIs enable multi-adapter mode');
  t.deepEqual(roles.adapters, ['hci0', 'hci1'], 'detected adapter names are preserved');
  t.end();
});

test('CLI adapter options stay unset so hardware detection can split dual radios', (t) => {
  t.equal(cliOptions['bike-adapter'].default, undefined, 'bike adapter has no yargs default');
  t.equal(cliOptions['server-adapter'].default, undefined, 'server adapter has no yargs default');
  t.equal(cliOptions['sensor-connect-timeout'].default, 8, 'optional speed/cadence sensor scan window defaults to 8 seconds');
  t.end();
});

test('resolveServerAdapters keeps Pi Zero bike radio out of advertising by default', (t) => {
  const adapters = resolveServerAdapters({
    bikeAdapter: 'hci0',
    serverAdapter: 'hci0',
    detectedAdapters: ['hci0', 'hci1'],
  }, { capable: false });

  t.deepEqual(adapters, ['hci1'], 'uses only the non-bike adapter when single-radio multi-role is not trusted');
  t.end();
});

test('resolveServerAdapters mirrors to bike radio only on multi-role-capable boards', (t) => {
  const adapters = resolveServerAdapters({
    bikeAdapter: 'hci0',
    serverAdapter: 'hci0',
    detectedAdapters: ['hci0', 'hci1'],
  }, { capable: true });

  t.deepEqual(adapters, ['hci1', 'hci0'], 'adds bike adapter mirror only when hardware is whitelisted');
  t.end();
});

test('App constructor preserves detected USB server adapter instead of restoring hci0', (t) => {
  const noble = new EventEmitter();
  noble.state = 'poweredOn';
  const healthMonitor = {
    on() {},
    stop() {},
    recordMetric() {},
  };

  const app = new App({
    noble,
    antEnabled: false,
    healthMonitor,
    bikeAdapter: 'hci0',
    serverAdapter: 'hci0',
    detectedAdapters: ['hci0', 'hci1'],
  });

  try {
    t.deepEqual(app.serverAdapters, ['hci1'], 'BLE advertising stays on the USB adapter');
    t.equal(app.opts.serverAdapter, 'hci1', 'primary server adapter follows the resolved list');
    t.notEqual(process.env.NOBLE_MULTI_ROLE, '1', 'multi-role is not enabled on the Pi Zero-style split');
  } finally {
    destroyTestApp(app);
  }

  t.end();
});
