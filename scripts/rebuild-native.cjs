// Helper script to rebuild native modules (CommonJS) - use .cjs when package.json "type": "module"
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const modulesToRebuild = [
  '@abandonware/noble',
  '@abandonware/bleno',
  'serialport',
  'usb'
];

console.log('Rebuilding native modules for the Node 16 runtime...');

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
