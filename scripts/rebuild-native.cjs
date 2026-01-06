// Helper script to rebuild native modules (CommonJS) - use .cjs when package.json "type": "module"
const { spawnSync } = require('child_process'); // import the synchronous process spawner so we can run npm rebuild commands inline
const path = require('path'); // bring in path helpers for cross-platform safe file resolution
const fs = require('fs'); // load the filesystem module to check if dependencies exist before rebuilding

const nodeVersion = process.versions.node; // capture the current Node runtime version string (e.g. "14.21.3")
const nodeMajor = Number(nodeVersion.split('.')[0]); // extract the major version number to allow conditional logic per runtime

// Teaching note: the README guarantees Node 14 compatibility, so we only refresh
// bluetooth-hci-socket when a maintainer explicitly opts in *and* the runtime
// can handle the newer usb/node-gyp toolchain.
const refreshHciSocket = process.env.GYMNASTICON_REFRESH_HCI_SOCKET === '1';
if (refreshHciSocket && nodeMajor >= 16) {
  try {
    console.log('\nRefreshing @abandonware/bluetooth-hci-socket from upstream...');
    const installResult = spawnSync(
      'npm',
      ['install', '--no-save', '--unsafe-perm', 'github:abandonware/node-bluetooth-hci-socket#master'],
      {
        stdio: 'inherit',
        env: { ...process.env, npm_config_build_from_source: 'true' }
      }
    );
    if (installResult.status !== 0) {
      console.warn('Optional bluetooth-hci-socket refresh failed; continuing with pinned dependency.');
    }
  } catch (err) {
    console.warn('Optional bluetooth-hci-socket refresh threw an error; continuing.', err);
  }
} else if (refreshHciSocket) {
  console.warn('Skipping bluetooth-hci-socket refresh: requires Node >= 16 to avoid usb/node-gyp breakage.');
}

const modulesToRebuild = [
  '@abandonware/noble', // BLE scanning library used for ANT+/Bluetooth communication
  '@abandonware/bleno', // BLE peripheral library that advertises the virtual device
  'serialport', // Serial interface used for trainer and bike hardware communication
  ...(nodeMajor >= 16 ? ['usb'] : []) // only include the usb module when the runtime meets the node-gyp >=16 requirement
]; // collect the native modules that should be rebuilt for the active Node version

console.log(`Rebuilding native modules for the Node ${nodeMajor} runtime...`); // inform the user which Node major version triggered this rebuild pass

// Ensure node-gyp is available globally (best-effort)
try {
  require.resolve('node-gyp');
} catch (e) {
  console.log('node-gyp not found globally; continuing — npm rebuild will use local node-gyp if available.');
}

modulesToRebuild.forEach(moduleName => {
  const modulePath = path.join(__dirname, '..', 'node_modules', moduleName);
  if (!fs.existsSync(modulePath)) {
    console.log(`Skipping ${moduleName} - not installed`);
    return;
  }

  console.log(`\nRebuilding ${moduleName}...`);
  const env = {
    ...process.env,
    npm_config_build_from_source: 'true'
  };
  if (!env.CXXFLAGS) {
    env.CXXFLAGS = '-std=gnu++14';
  }

  const result = spawnSync('npm', ['rebuild', moduleName, '--build-from-source'], {
    stdio: 'inherit',
    env
  });

  if (result.status !== 0) {
    console.error(`Failed to rebuild ${moduleName} (exit ${result.status})`);
  } else {
    console.log(`Successfully rebuilt ${moduleName}`);
  }
});

console.log('\nNative module rebuild complete');
