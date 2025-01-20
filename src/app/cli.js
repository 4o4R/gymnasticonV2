#!/usr/bin/env node

import { GymnastriconApp } from './index.js';
import { initializeBluetooth } from '../util/noble-wrapper.js';
import { BikeAutoDetector } from '../bikes/auto-detect.js';

const main = async () => {
  const { noble } = await initializeBluetooth();
  const detector = new BikeAutoDetector(noble);
  const app = new GymnastriconApp({
    noble,
    detector,
    powerSmoothing: 0.8
  });
  
  await app.start();
  
  // Keep process running
  process.stdin.resume();
  
  // Handle shutdown gracefully
  ['SIGINT', 'SIGTERM'].forEach(signal => {
    process.on(signal, async () => {
      await app.stop();
      process.exit(0);
    });
  });
};

main().catch(console.error);
