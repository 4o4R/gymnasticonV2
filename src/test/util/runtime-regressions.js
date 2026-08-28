import {EventEmitter} from 'events';

import test from '../support/tape.js';
import {App} from '../../app/app.js';
import {HeartRateClient} from '../../hr/heart-rate-client.js';
import {BleServer} from '../../util/ble-server.js';
import {BluetoothConnectionManager} from '../../util/connection-manager.js';

test('BluetoothConnectionManager cancels a timed-out physical connection', async t => {
  const peripheral = new EventEmitter();
  peripheral.id = 'pending-device';
  peripheral.state = 'connecting';
  peripheral.connectAsync = () => new Promise(() => {});
  let disconnectCalls = 0;
  peripheral.disconnectAsync = async () => {
    disconnectCalls += 1;
    peripheral.state = 'disconnected';
    peripheral.emit('disconnect');
  };

  const manager = new BluetoothConnectionManager(null, {timeout: 5, maxRetries: 1});
  try {
    await manager.connect(peripheral);
    t.fail('connection should time out');
  } catch (error) {
    t.match(error.message, /Connection timeout/, 'reports the original timeout');
  }
  t.equal(disconnectCalls, 1, 'cancels the in-flight physical connection');
  t.equal(manager.connections.size, 0, 'removes the completed attempt from the connection map');
  t.end();
});

test('BleServer stops advertising when GATT service setup fails', async t => {
  const bleno = new EventEmitter();
  bleno.state = 'poweredOn';
  bleno.advertising = false;
  let stopCalls = 0;
  bleno.startAdvertising = (_name, _uuids, callback) => {
    bleno.advertising = true;
    callback(null);
  };
  bleno.setServices = (_services, callback) => callback(new Error('set-services-failed'));
  bleno.stopAdvertising = callback => {
    stopCalls += 1;
    bleno.advertising = false;
    callback(null);
  };
  bleno.disconnect = () => {};

  const server = new BleServer(bleno, 'test');
  try {
    await server.start();
    t.fail('service setup should fail');
  } catch (error) {
    t.equal(error.message, 'set-services-failed', 'preserves the startup error');
  }
  t.equal(server.state, 'stopped', 'resets the server state');
  t.notOk(bleno.advertising, 'does not leave a zombie advertiser');
  t.equal(stopCalls, 1, 'explicitly stops advertising');
  t.end();
});

test('HeartRateClient ignores truncated 16-bit measurements', t => {
  const client = new HeartRateClient(new EventEmitter(), {connectionManager: {}});
  const values = [];
  client.on('heartRate', value => values.push(value));

  t.doesNotThrow(() => client.onCharData(Buffer.from([0x01, 0x48])), 'truncated frame is safe');
  client.onCharData(Buffer.from([0x01, 0x48, 0x00]));
  t.deepEqual(values, [72], 'a complete 16-bit frame still emits');
  t.end();
});

test('App.cleanup removes its process-level error handlers', async t => {
  const noble = new EventEmitter();
  noble.state = 'poweredOn';
  const healthMonitor = {on() {}, stop() {}, recordMetric() {}};
  const app = new App({
    noble,
    antEnabled: false,
    healthMonitor,
    bleMultiOutput: false,
    serverAdapters: ['hci0'],
  });

  t.ok(process.listeners('uncaughtException').includes(app.errorHandler), 'handler starts attached');
  await app.cleanup();
  t.notOk(process.listeners('uncaughtException').includes(app.errorHandler), 'handler is removed during cleanup');
  t.notOk(process.listeners('unhandledRejection').includes(app.errorHandler), 'rejection handler is also removed');
  t.end();
});
