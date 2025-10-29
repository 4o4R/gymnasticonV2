// Helper script to rebuild native modules
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const modulesToRebuild = [
  '@abandonware/noble',
  '@abandonware/bleno',
  'serialport',
  'usb',
  'bluetooth-hci-socket'
];

console.log('Rebuilding native modules for Node 14...');

// Ensure node-gyp is available
try {
  const nodeGyp = require.resolve('node-gyp');
  console.log(`Using node-gyp from: ${nodeGyp}`);
} catch (e) {
  console.error('node-gyp not found. Installing...');
  spawnSync('npm', ['install', '-g', 'node-gyp'], { stdio: 'inherit' });
}

// Rebuild each module
modulesToRebuild.forEach(moduleName => {
  const modulePath = path.join(__dirname, '..', 'node_modules', moduleName);
  
  if (!fs.existsSync(modulePath)) {
    console.log(`Skipping ${moduleName} - not installed`);
    return;
  }

  console.log(`\nRebuilding ${moduleName}...`);
  const result = spawnSync('npm', ['rebuild', moduleName], {
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_build_from_source: 'true'
    }
  });

  if (result.status !== 0) {
    console.error(`Failed to rebuild ${moduleName}`);
  } else {
    console.log(`Successfully rebuilt ${moduleName}`);
  }
});

console.log('\nNative module rebuild complete');
