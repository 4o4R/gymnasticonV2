import {readdir} from 'fs/promises';
import {join} from 'path';
import {fileURLToPath, pathToFileURL} from 'url';

const {default: tape} = await import('../src/test/support/tape.js');

const rootDir = fileURLToPath(new URL('../src/test', import.meta.url));

async function loadTests(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await loadTests(fullPath);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) {
      await import(pathToFileURL(fullPath));
    }
  }
}

try {
  const finished = new Promise(resolve => tape.onFinish(resolve));
  await loadTests(rootDir);
  await finished;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
