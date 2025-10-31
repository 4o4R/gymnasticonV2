#!/usr/bin/env node

import { readFileSync } from 'fs';
import { resolve } from 'path';
import yargs from 'yargs/yargs.js';
import { hideBin } from 'yargs/helpers';

import { App } from './app.js';
import { options as cliOptions } from './cli-options.js';
import { initializeBluetooth } from '../util/noble-wrapper.js';

const loadConfig = (configPath) => {
  const fullPath = resolve(configPath);
  const contents = readFileSync(fullPath, 'utf8');
  return JSON.parse(contents);
};

const buildAppOptions = ({ _, $0, config, ...rest }) => rest;

const main = async () => {
  const argv = yargs(hideBin(process.argv))
    .options(cliOptions)
    .config('config', loadConfig)
    .parserConfiguration({ 'camel-case-expansion': true })
    .help()
    .alias('h', 'help')
    .strict()
    .parse();

  if (argv.bikeAdapter) {
    process.env.NOBLE_HCI_DEVICE_ID = argv.bikeAdapter;
    process.env.NOBLE_MULTI_ROLE = '1';
    process.env.NOBLE_EXTENDED_SCAN = '1';
  }
  if (argv.serverAdapter) {
    process.env.BLENO_HCI_DEVICE_ID = argv.serverAdapter;
    if (!process.env.BLENO_MAX_CONNECTIONS) {
      process.env.BLENO_MAX_CONNECTIONS = '3';
    }
  }

  const { noble } = await initializeBluetooth(argv.bikeAdapter);
  const app = new App({
    ...buildAppOptions(argv),
    noble
  });

  await app.start();

  process.stdin.resume();

  const shutdown = async () => {
    try {
      await app.stop();
    } finally {
      process.exit(0);
    }
  };

  ['SIGINT', 'SIGTERM'].forEach((signal) => {
    process.on(signal, shutdown);
  });
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
