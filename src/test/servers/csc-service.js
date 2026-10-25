import test from '../support/tape.js';
import {spawnSync} from 'child_process';
import {CyclingSpeedAndCadenceService} from '../../servers/ble/services/cycling-speed-and-cadence/index.js';
import {ScControlPointCharacteristic} from '../../servers/ble/services/cycling-speed-and-cadence/characteristics/sc-control-point.js';

function writeControlPoint(controlPoint, bytes) { // Collect the ATT result and the Response Code indication.
  const result = {attResult: null, indications: []};
  controlPoint.updateValueCallback = value => result.indications.push(Buffer.from(value));
  controlPoint.onWriteRequest(Buffer.from(bytes), 0, false, code => {
    result.attResult = code;
  });
  return result;
}

function captureMeasurements(service) {
  const values = [];
  service.measurement.updateValueCallback = buffer => values.push(Buffer.from(buffer));
  return values;
}

test('loading BLE constructors does not initialize the default radio binding', t => {
  const helperUrl = new URL('../../servers/ble/bleno-deps.js', import.meta.url).href;
  const script = [
    'import assert from "assert";',
    'import {createRequire} from "module";',
    `const helperUrl = ${JSON.stringify(helperUrl)};`,
    'const require = createRequire(helperUrl);',
    'const constructors = await import(helperUrl);',
    'assert.strictEqual(typeof constructors.Characteristic, "function");',
    'assert.strictEqual(require.cache[require.resolve("@abandonware/bleno")], undefined);',
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {timeout: 5000, encoding: 'utf8'});
  t.equal(child.status, 0, child.error?.message || child.stderr || 'constructor import exits without opening a radio');
  t.end();
});

test('CSC service exposes the SC Control Point alongside measurement and feature', t => {
  const service = new CyclingSpeedAndCadenceService();
  const uuids = service.characteristics.map(characteristic => characteristic.uuid);

  t.deepEqual(uuids, ['2a5b', '2a5c', '2a55'], 'advertises measurement, feature and the control point');
  t.ok(service.measurement === service.characteristics[0], 'keeps measurement first for existing callers');
  t.ok(service.feature === service.characteristics[1], 'keeps feature second for existing callers');
  t.ok(service.controlPoint === service.characteristics[2], 'exposes the control point');
  t.deepEqual(service.controlPoint.properties, ['write', 'indicate'], 'accepts writes and answers with indications');
  t.end();
});

test('SC Control Point reports the documented supported features', t => {
  const controlPoint = new ScControlPointCharacteristic();

  t.equal(controlPoint.uuid, '2a55', 'uses the standard SC Control Point UUID');
  t.deepEqual(controlPoint.supportedOperations, [0x01], 'supports the cumulative wheel procedure');
  t.equal(controlPoint.supportedFeatures, 0b1, 'does not claim bike calibration that the bridge cannot perform');
  t.equal(controlPoint.supportsOperation(0x01), true, 'supports Set Cumulative Value');
  t.equal(controlPoint.supportsOperation(0x02), false, 'does not claim Start Sensor Calibration');
  t.equal(controlPoint.supportsOperation(0x04), false, 'does not claim unsupported op codes');
  t.end();
});

test('SC Control Point acknowledges Set Cumulative Value', t => {
  const controlPoint = new ScControlPointCharacteristic();
  const write = writeControlPoint(controlPoint, [0x01, 0x10, 0x00, 0x00, 0x00]);

  t.equal(write.attResult, 0x00, 'accepts the write');
  t.deepEqual(write.indications, [Buffer.from([0x10, 0x01, 0x01])], 'uses the SIG response opcode 0x10');
  t.equal(controlPoint.cumulativeWheelRevolutions, 16, 'records the requested baseline');
  t.end();
});

test('SC Control Point rejects a Set Cumulative Value with the wrong length', t => {
  const controlPoint = new ScControlPointCharacteristic();
  const write = writeControlPoint(controlPoint, [0x01, 0x10]);

  t.equal(write.attResult, 0x00, 'accepts the write itself');
  t.deepEqual(write.indications, [Buffer.from([0x10, 0x01, 0x03])], 'indicates an invalid parameter response');
  t.end();
});

test('SC Control Point rejects unsupported bike calibration', t => {
  const controlPoint = new ScControlPointCharacteristic();
  const write = writeControlPoint(controlPoint, [0x02]);

  t.deepEqual(write.indications, [Buffer.from([0x10, 0x02, 0x02])], 'reports unsupported instead of claiming calibration succeeded');
  t.end();
});

test('SC Control Point rejects unsupported op codes with an explicit response', t => {
  const controlPoint = new ScControlPointCharacteristic();
  const write = writeControlPoint(controlPoint, [0x04]);

  t.equal(write.attResult, 0x00, 'still accepts the write');
  t.deepEqual(write.indications, [Buffer.from([0x10, 0x04, 0x02])], 'indicates op code not supported');
  t.end();
});

test('SC Control Point requires indication subscription before changing a counter', t => {
  const controlPoint = new ScControlPointCharacteristic();
  let result;
  controlPoint.onWriteRequest(Buffer.from([1, 16, 0, 0, 0]), 0, false, code => { result = code; });
  t.equal(result, 0x81, 'returns the standard CCCD configuration error');
  t.equal(controlPoint.pendingCumulativeValue, null, 'does not change the baseline');
  t.end();
});

test('SC Control Point serializes procedures until indication confirmation', t => {
  const controlPoint = new ScControlPointCharacteristic();
  writeControlPoint(controlPoint, [1, 16, 0, 0, 0]);
  const second = writeControlPoint(controlPoint, [1, 32, 0, 0, 0]);
  t.equal(second.attResult, 0x80, 'rejects an overlapping procedure');
  t.equal(controlPoint.pendingCumulativeValue, 16, 'keeps the first requested baseline');
  controlPoint.onIndicate();
  const third = writeControlPoint(controlPoint, [1, 32, 0, 0, 0]);
  t.equal(third.attResult, 0, 'accepts another procedure after confirmation');
  controlPoint.onUnsubscribe();
  t.equal(controlPoint.procedurePending, false, 'disconnect releases the procedure');
  t.end();
});

test('CSC measurements stay unchanged until a client sets a cumulative value', t => {
  const service = new CyclingSpeedAndCadenceService();
  const measurements = captureMeasurements(service);

  service.updateMeasurement({wheel: {revolutions: 7, timestamp: 1.5}, crank: {revolutions: 3, timestamp: 1.5}});

  t.equal(measurements.length, 1, 'notifies subscribers');
  t.equal(measurements[0][0], 0x03, 'keeps both wheel and crank flags');
  t.equal(measurements[0].readUInt32LE(1), 7, 'keeps the upstream wheel revolutions');
  t.end();
});

test('CSC measurements honour a cumulative value set through the control point', t => {
  const service = new CyclingSpeedAndCadenceService();
  const measurements = captureMeasurements(service);

  writeControlPoint(service.controlPoint, [0x01, 0x10, 0x00, 0x00, 0x00]); // Ask for a baseline of 16 revolutions.
  service.updateMeasurement({wheel: {revolutions: 7, timestamp: 1.5}});
  service.updateMeasurement({wheel: {revolutions: 9, timestamp: 2.5}});

  t.equal(measurements.length, 2, 'notifies subscribers');
  t.equal(measurements[0].readUInt32LE(1), 16, 'first measurement lands on the requested baseline');
  t.equal(measurements[1].readUInt32LE(1), 18, 'later measurements keep advancing from it');
  t.end();
});

test('CSC service keeps ensureCapabilities working with the control point present', t => {
  const service = new CyclingSpeedAndCadenceService();
  service.ensureCapabilities({supportWheel: true, supportCrank: true});

  t.equal(service.feature.value.readUInt8(0), 0x03, 'advertises wheel and crank support');

  service.ensureCapabilities({supportWheel: false, supportCrank: true});
  t.equal(service.feature.value.readUInt8(0), 0x02, 'drops the wheel bit again');
  t.deepEqual(service.characteristics.map(characteristic => characteristic.uuid), ['2a5b', '2a5c', '2a55'], 'keeps the characteristic set stable');
  t.end();
});
