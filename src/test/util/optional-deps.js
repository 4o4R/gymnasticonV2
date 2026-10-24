import test from '../support/tape.js';
import {listStubLoads, loadDependency, stubsPermitted} from '../../util/optional-deps.js';

const MISSING_MODULE = 'gymnasticon-missing-native-module'; // Guaranteed to fail so the fallback path is always exercised.
const BLENO_STUB = '../../../stubs/bleno.cjs'; // Same stub the BLE services fall back to.

test('stubsPermitted only allows stubs for explicit dev or Windows hosts', t => {
  t.equal(stubsPermitted({env: {GYMNASTICON_ALLOW_STUBS: '1'}, platform: 'linux'}), true, 'honours the explicit opt-in');
  t.equal(stubsPermitted({env: {NODE_ENV: 'test'}, platform: 'linux'}), true, 'allows the test environment');
  t.equal(stubsPermitted({env: {}, platform: 'win32'}), true, 'allows Windows development hosts');
  t.equal(stubsPermitted({env: {}, platform: 'linux'}), false, 'refuses stubs on a production Linux host');
  t.equal(stubsPermitted({env: {GYMNASTICON_ALLOW_STUBS: '0'}, platform: 'linux'}), false, 'only the literal 1 opts in');
  t.end();
});

test('loadDependency loads the real module without warnings', t => {
  const warnings = [];
  const loaded = loadDependency('events', BLENO_STUB, import.meta, {
    env: {},
    platform: 'linux',
    logger: message => warnings.push(String(message)),
  });

  t.equal(typeof loaded.EventEmitter, 'function', 'returns the real module');
  t.equal(loaded.__isStub, undefined, 'is not marked as a stub');
  t.deepEqual(warnings, [], 'does not warn');
  t.end();
});

test('loadDependency falls back to the stub when stubs are explicitly allowed', t => {
  const warnings = [];
  const loaded = loadDependency(MISSING_MODULE, BLENO_STUB, import.meta, {
    env: {GYMNASTICON_ALLOW_STUBS: '1'},
    platform: 'linux',
    logger: message => warnings.push(String(message)),
  });

  t.equal(loaded.__isStub, true, 'returns the marked stub');
  t.equal(warnings.length, 1, 'warns exactly once');
  t.ok(/NATIVE DEPENDENCY FALLBACK/.test(warnings[0]), 'the warning is loud');
  t.ok(new RegExp(MISSING_MODULE).test(warnings[0]), 'the warning names the module');
  t.ok(/do not run this in production/.test(warnings[0]), 'the warning explains the risk');
  t.ok(listStubLoads().some(entry => entry.request === MISSING_MODULE), 'records the substitution');
  t.end();
});

test('loadDependency allows stubs in the test environment', t => {
  const loaded = loadDependency(MISSING_MODULE, BLENO_STUB, import.meta, {
    env: {NODE_ENV: 'test'},
    platform: 'linux',
    logger: () => {},
  });

  t.equal(loaded.__isStub, true, 'returns the stub');
  t.end();
});

test('loadDependency allows stubs on Windows development hosts', t => {
  const loaded = loadDependency(MISSING_MODULE, BLENO_STUB, import.meta, {
    env: {},
    platform: 'win32',
    logger: () => {},
  });

  t.equal(loaded.__isStub, true, 'returns the stub');
  t.end();
});

test('loadDependency refuses to substitute a stub in production', t => {
  let error = null;
  try {
    loadDependency(MISSING_MODULE, BLENO_STUB, import.meta, {
      env: {},
      platform: 'linux',
      logger: () => t.fail('a refused stub must not warn about being used'),
    });
  } catch (err) {
    error = err;
  }

  t.ok(error, 'throws instead of returning a stub');
  t.ok(new RegExp(MISSING_MODULE).test(error.message), 'names the module that failed');
  t.ok(/native dependency/i.test(error.message), 'explains that the native dependency failed');
  t.ok(/GYMNASTICON_ALLOW_STUBS/.test(error.message), 'mentions the deliberate dev opt-in');
  t.ok(/Cannot find module/.test(error.originalMessage || ''), 'surfaces the original load failure');
  t.end();
});

test('loadDependency keeps a readable failure when even the stub is missing', t => {
  let error = null;
  try {
    loadDependency(MISSING_MODULE, '../../../stubs/also-missing.cjs', import.meta, {
      env: {GYMNASTICON_ALLOW_STUBS: '1'},
      platform: 'linux',
      logger: () => {},
    });
  } catch (err) {
    error = err;
  }

  t.ok(error, 'throws when the stub cannot be loaded either');
  t.ok(/also-missing/.test(error.message), 'names the missing stub file');
  t.end();
});
