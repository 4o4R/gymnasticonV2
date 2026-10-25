import {EventEmitter} from 'events';
import {existsSync, readFileSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync} from 'fs';
import {spawnSync} from 'child_process';
import {tmpdir} from 'os';
import {join} from 'path';
import {fileURLToPath} from 'url';

import test from '../support/tape.js';
import {App} from '../../app/app.js';
import {GymnasticonApp} from '../../app/gymnasticon-app.js';
import {HeartRateClient} from '../../hr/heart-rate-client.js';
import {BleServer} from '../../util/ble-server.js';
import {stopBluetoothStack} from '../../util/bluetooth-shutdown.js';
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
  t.ok(process.listeners('unhandledRejection').includes(app.rejectionHandler), 'rejection handler starts attached');
  await app.cleanup();
  t.notOk(process.listeners('uncaughtException').includes(app.errorHandler), 'handler is removed during cleanup');
  t.notOk(process.listeners('unhandledRejection').includes(app.rejectionHandler), 'rejection handler is also removed');
  t.end();
});

test('stopBluetoothStack releases a native HCI handle once', t => {
  let stopCalls = 0;
  const stack = {
    _bindings: {
      _hci: {
        _socket: {
          stop() {
            stopCalls += 1;
          },
        },
      },
    },
  };

  t.equal(stopBluetoothStack(stack), true, 'releases an active native socket');
  t.equal(stopBluetoothStack(stack), false, 'repeated shutdown is a no-op');
  t.equal(stopCalls, 1, 'calls the native stop method once');
  t.equal(stopBluetoothStack(new EventEmitter()), false, 'accepts stubs without native bindings');
  t.end();
});

test('App.stop releases noble and every bleno binding after a cleanup error', async t => {
  const createStack = () => {
    const stack = new EventEmitter();
    stack.state = 'poweredOn';
    stack.stopCalls = 0;
    stack._bindings = {
      _hci: {
        _socket: {
          stop() {
            stack.stopCalls += 1;
          },
        },
      },
    };
    return stack;
  };
  const noble = createStack();
  const dedicatedHeartRateNoble = createStack();
  const firstBleno = createStack();
  const secondBleno = createStack();
  const healthMonitor = {on() {}, stop() {}, recordMetric() {}};
  const app = new App({
    noble,
    heartRateNoble: dedicatedHeartRateNoble,
    antEnabled: false,
    healthMonitor,
    bleMultiOutput: false,
    serverAdapters: ['hci0'],
  });
  app.bike = {
    async disconnect() {
      throw new Error('bike-disconnect-failed');
    },
  };
  app.server = {
    entries: [
      {server: {bleno: firstBleno}},
      {server: {bleno: secondBleno}},
    ],
  };

  try {
    await app.stop();
    t.fail('reports the first cleanup error');
  } catch (error) {
    t.equal(error.message, 'bike-disconnect-failed', 'preserves the cleanup failure');
  }
  t.equal(noble.stopCalls, 1, 'releases the bike noble binding');
  t.equal(dedicatedHeartRateNoble.stopCalls, 1, 'releases the dedicated heart-rate binding');
  t.equal(firstBleno.stopCalls, 1, 'releases the first advertising binding');
  t.equal(secondBleno.stopCalls, 1, 'releases the second advertising binding');

  process.removeListener('unhandledRejection', app.errorHandler);
  process.removeListener('uncaughtException', app.errorHandler);
  t.end();
});

test('image and manual installers share the canonical systemd service', t => {
  const serviceUrl = new URL('../../../deploy/gymnasticon.service', import.meta.url);
  const obsoleteImageServiceUrl = new URL(
    '../../../deploy/pi-sdcard/stage-gymnasticon/00-install-gymnasticon/files/gymnasticon.service',
    import.meta.url
  );
  const service = readFileSync(serviceUrl, 'utf8');

  t.match(service, /ExecStart=\/opt\/gymnasticon\/bin\/gymnasticon/, 'canonical unit uses the cross-layout wrapper');
  t.match(service, /\/usr\/sbin:\/usr\/bin:\/sbin:\/bin/, 'canonical unit exposes system Bluetooth tools');
  t.notOk(existsSync(obsoleteImageServiceUrl), 'no divergent image-only unit remains');
  t.end();
});

test('manual installer documentation seeds default gymnasticon.json', t => {
  const readmeUrl = new URL('../../../README.md', import.meta.url);
  const readme = readFileSync(readmeUrl, 'utf8');

  t.match(
    readme,
    /sudo install -m 644 deploy\/pi-sdcard\/stage-gymnasticon\/00-install-gymnasticon\/files\/gymnasticon\.json \/etc\/gymnasticon\.json/,
    'manual install copies the template config to /etc/gymnasticon.json'
  );
  t.match(
    readme,
    /sudo ln -sf \/etc\/gymnasticon\.json \/opt\/gymnasticon\/gymnasticon\.json/,
    'manual install symlinks /etc/gymnasticon.json into repository root'
  );
  t.end();
});

test('manual installer documentation installs node-gyp before deriving its path', t => {
  const readmeUrl = new URL('../../../README.md', import.meta.url);
  const readme = readFileSync(readmeUrl, 'utf8');

  const installIndex = readme.indexOf('sudo npm install -g node-gyp@9');
  const deriveIndex = readme.indexOf('NODE_GYP_BIN="$(sudo npm root -g)/node-gyp/bin/node-gyp.js"');
  t.ok(installIndex >= 0, 'manual install installs a Node 14 compatible node-gyp');
  t.ok(deriveIndex > installIndex, 'node-gyp is installed before NODE_GYP_BIN is derived');

  const verifyIndex = readme.indexOf('test -f "$NODE_GYP_BIN"', deriveIndex);
  const useIndex = readme.indexOf('npm_config_node_gyp="$NODE_GYP_BIN" npm_config_python', deriveIndex);
  t.ok(verifyIndex > deriveIndex, 'resolved node-gyp path is verified');
  t.ok(useIndex > verifyIndex, 'verified node-gyp path is used by npm install');

  t.match(readme, /npm install --omit=dev/, 'manual install still installs production dependencies');
  t.match(readme, /npm_config_python=\/usr\/bin\/python3/, 'manual install keeps npm_config_python');
  t.match(readme, /CXXFLAGS=-std=gnu\+\+14/, 'manual install keeps CXXFLAGS');
  t.end();
});

test('published package ships every lifecycle script it references', t => {
  const packageUrl = new URL('../../../package.json', import.meta.url);
  const manifest = JSON.parse(readFileSync(packageUrl, 'utf8'));
  const allowlist = manifest.files ?? [];

  const isCovered = scriptPath => allowlist.some(entry => {
    const normalized = String(entry).replace(/^\.\//, '').replace(/\/+$/, '');
    if (!normalized) {
      return false;
    }
    if (normalized.includes('*')) {
      const pattern = new RegExp(`^${normalized.split('*').map(part =>
        part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      return pattern.test(scriptPath);
    }
    return scriptPath === normalized || scriptPath.startsWith(`${normalized}/`);
  });

  const referenced = [];
  for (const hook of ['preinstall', 'postinstall']) {
    const command = manifest.scripts?.[hook];
    t.ok(command, `${hook} is declared`);
    for (const match of String(command ?? '').matchAll(/(?:^|\s)node\s+(?:\.\/)?([^\s"']+)/g)) {
      referenced.push(match[1]);
    }
  }

  t.ok(referenced.length > 0, 'lifecycle hooks invoke script files');
  t.ok(allowlist.includes('scripts'), 'scripts/ is in the files allowlist');
  for (const scriptPath of referenced) {
    t.ok(isCovered(scriptPath), `${scriptPath} is shipped by the files allowlist`);
  }
  t.end();
});

test('installer points legacy Raspbian sources at the working legacy mirror', t => {
  const installerUrl = new URL('../../../deploy/install.sh', import.meta.url);
  const installer = readFileSync(installerUrl, 'utf8');

  t.match(installer, /legacy\.raspbian\.org/, 'installer rewrites Buster Raspbian sources to legacy.raspbian.org');
  t.notOk(/archive\.raspbian\.org/.test(installer), 'installer no longer rewrites sources to the dead archive.raspbian.org host');
  t.match(installer, /s\|deb\.debian\.org\|archive\.debian\.org\|g/, 'installer still archives Debian sources');
  t.match(installer, /s\|security\.debian\.org\|archive\.debian\.org\|g/, 'installer still archives Debian security sources');
  t.match(installer, /Acquire::AllowReleaseInfoChange::Codename "1";/, 'release-change apt tweaks are preserved');
  t.end();
});

test('image builder repoints the archived Buster mirror at the legacy archive', t => {
  const buildUrl = new URL('../../../deploy/pi-sdcard/build.sh', import.meta.url);
  const build = readFileSync(buildUrl, 'utf8');

  t.match(
    build,
    /PRIMARY_BUSTER_MIRROR="https:\/\/legacy\.raspbian\.org\/raspbian\/"/,
    'Buster builds use the live legacy mirror'
  );
  t.match(
    build,
    /STALE_BUSTER_MIRROR='[^']*archive\\\.raspbian\\\.org/,
    'archived Buster mirror values are treated as stale and rewritten'
  );
  t.end();
});

test('image apt refresh stage uses the working legacy Raspbian mirror', t => {
  const scriptUrl = new URL(
    '../../../deploy/pi-sdcard/stage-gymnasticon/00-apt-refresh/00-run.sh',
    import.meta.url
  );
  const script = readFileSync(scriptUrl, 'utf8');
  const mirrorLines = script
    .split('\n')
    .filter(line => line.includes('sed') && line.includes('raspbian'));

  t.ok(mirrorLines.length > 0, 'apt refresh rewrites Raspbian sources');
  t.notOk(/archive\.raspbian\.org/.test(script), 'apt refresh no longer targets the dead archive.raspbian.org host');
  for (const line of mirrorLines) {
    t.match(line, /legacy\.raspbian\.org\/raspbian/, `mirror rewrite uses legacy.raspbian.org: ${line.trim()}`);
  }
  t.end();
});

test('boot guard units avoid ExecCondition for systemd 241 compatibility', t => {
  const unitUrl = name => new URL(
    `../../../deploy/pi-sdcard/stage-gymnasticon/00-install-gymnasticon/files/${name}`,
    import.meta.url
  );
  const lockrootfs = readFileSync(unitUrl('lockrootfs.service'), 'utf8');
  const mods = readFileSync(unitUrl('gymnasticon-mods.service'), 'utf8');

  for (const [name, unit] of [['lockrootfs', lockrootfs], ['gymnasticon-mods', mods]]) {
    t.notOk(/^\s*ExecCondition\s*=/m.test(unit), `${name} does not rely on systemd 243+ ExecCondition`);
    t.notOk(/^\s*Condition\w*Path\s*=/m.test(unit), `${name} does not rely on unit-level path conditions`);
    t.match(unit, /^\s*ExecStart=\/bin\/sh -c '/m, `${name} performs its guard in a POSIX shell`);
  }

  t.match(lockrootfs, /\/boot\/no_read_only/, 'lockrootfs checks the Buster boot flag');
  t.match(lockrootfs, /\/boot\/firmware\/no_read_only/, 'lockrootfs checks the Bookworm boot flag');
  t.match(lockrootfs, /exit 0/, 'lockrootfs exits cleanly when the flag is present');
  const lockSkipIndex = lockrootfs.indexOf('exit 0');
  const overlayIndex = lockrootfs.indexOf('enable_overlayfs');
  t.ok(overlayIndex > lockSkipIndex, 'overlayfs setup only runs after the no_read_only guard');
  t.match(lockrootfs, /raspi-config nonint enable_overlayfs/, 'lockrootfs still enables overlayfs');
  t.match(lockrootfs, /systemctl disable lockrootfs/, 'lockrootfs still disables itself');
  t.match(lockrootfs, /systemctl enable bootfs-ro/, 'lockrootfs still enables bootfs-ro');
  t.match(lockrootfs, /rm -f \/etc\/systemd\/system\/lockrootfs\.service/, 'lockrootfs still removes its unit');
  t.match(lockrootfs, /Before=gymnasticon-mods\.service/, 'lockrootfs still runs before the mods gate');

  t.match(mods, /Before=gymnasticon\.service/, 'mods gate still precedes the application');
  t.match(mods, /\/boot\/firmware\/gymnasticon\.json/, 'mods gate checks the Bookworm boot path');
  t.match(mods, /\/boot\/gymnasticon\.json/, 'mods gate checks the Buster boot path');
  const modsGuardIndex = mods.indexOf('exit 0');
  const modsInstallIndex = mods.indexOf('install -o pi -g pi -m 644');
  t.ok(modsGuardIndex >= 0 && modsInstallIndex > modsGuardIndex, 'mods gate skips the copy when no boot config exists');
  t.match(mods, /install -o pi -g pi -m 644 "\$src" \/etc\/gymnasticon\.json/, 'mods gate still copies the user config');
  t.end();
});

test('boot Bluetooth reprobe never resets a radio that Gymnasticon is using', t => {
  const stageUrl = new URL(
    '../../../deploy/pi-sdcard/stage-gymnasticon/00-install-gymnasticon/01-run.sh',
    import.meta.url
  );
  const stage = readFileSync(stageUrl, 'utf8');
  const unitMatch = stage.match(/<<'REPROBE'\r?\n([\s\S]*?)\r?\nREPROBE/);
  t.ok(unitMatch, 'stage still generates the Bluetooth reprobe unit');
  const unit = unitMatch ? unitMatch[1] : '';

  t.match(unit, /^Before=gymnasticon\.service$/m, 'reprobe is ordered before the application');
  t.match(unit, /^After=bluetooth\.service hciuart\.service/m, 'reprobe still waits for the Bluetooth stack');
  t.notOk(/^\s*ExecCondition\s*=/m.test(unit), 'reprobe does not rely on systemd 243+ ExecCondition');
  t.match(unit, /systemctl is-active --quiet gymnasticon/, 'reprobe checks whether Gymnasticon is already running');
  t.match(unit, /already up/, 'reprobe skips adapters that are already up');
  t.match(unit, /modprobe btusb/, 'reprobe still loads the USB Bluetooth driver');
  t.match(unit, /rfkill unblock all/, 'reprobe still clears rfkill blocks');
  t.match(unit, /udevadm settle/, 'reprobe still waits for udev to settle');

  const loopIndex = unit.indexOf('for i in ');
  t.ok(loopIndex >= 0, 'reprobe still retries in a bounded loop');
  const restartIndexes = [...unit.matchAll(/systemctl restart hciuart/g)].map(match => match.index);
  t.ok(restartIndexes.length > 0, 'reprobe still restarts hciuart for genuinely missing adapters');
  for (const restartIndex of restartIndexes) {
    const guardedRegion = unit.slice(loopIndex, restartIndex);
    t.match(
      guardedRegion,
      /systemctl is-active --quiet gymnasticon[\s\S]*?exit 0/,
      'each hciuart restart is unreachable while Gymnasticon is active'
    );
  }
  const firstRestartIndex = restartIndexes[0] ?? -1;
  t.ok(
    unit.indexOf('systemctl is-active --quiet gymnasticon') < firstRestartIndex,
    'the active-service guard precedes the first restart'
  );
  t.match(stage, /systemctl enable gymnasticon-bt-reprobe\.service/, 'reprobe is enabled at build time');
  t.end();
});

test('GymnasticonApp seeds ConfigManager with documented defaults when config file is missing', t => {
  const app = new GymnasticonApp({
    configPath: '/tmp/nonexistent-gymnasticon.json',
    healthMonitor: { stop() {} },
  });
  t.deepEqual(app.configManager.defaults, {
    bike: 'autodetect',
    defaultBike: 'keiser',
    serverName: 'GymnasticonV2',
    bikeReceiveTimeout: 10,
    bikeDisconnectTimeout: 60,
    serverReconnectGrace: 60,
    powerScale: 1,
    powerOffset: 0,
  }, 'configManager receives the full set of documented defaults');
  t.end();
});

test('CLI version and help exit naturally from an unrelated project directory', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'gymnasticon-cli.'));
  const foreignManifest = join(cwd, 'package.json');
  const cli = fileURLToPath(new URL('../../app/cli.js', import.meta.url));
  const expectedVersion = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;
  writeFileSync(foreignManifest, JSON.stringify({name: 'unrelated-project', version: '99.0.0'}));
  try {
    const version = spawnSync(process.execPath, [cli, '--version'], {cwd, encoding: 'utf8', timeout: 5000});
    t.equal(version.status, 0, version.stderr || 'version command exits successfully');
    t.equal(version.signal, null, 'version needs no forced termination');
    t.equal(version.stdout.trim().split(/\r?\n/).pop(), expectedVersion, 'reports the installed package version, regardless of caller package');
    const help = spawnSync(process.execPath, [cli, '--help'], {cwd, encoding: 'utf8', timeout: 5000});
    t.equal(help.status, 0, help.stderr || 'help command exits successfully');
    t.equal(help.signal, null, 'help needs no forced termination');
    t.match(help.stdout, /--bike\s/, 'help displays the supported bike option without starting Bluetooth');
  } finally {
    unlinkSync(foreignManifest);
    rmdirSync(cwd);
  }
  t.end();
});
