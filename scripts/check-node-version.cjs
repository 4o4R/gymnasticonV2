#!/usr/bin/env node

'use strict';

const REQUIRED_VERSION = '14.21.3';
const REQUIRED_MAJOR = 14;
const SKIP_ENV = 'GYMNASTICON_ALLOW_UNSUPPORTED_NODE';

if (process.env[SKIP_ENV] === '1') {
  process.exit(0);
}

const currentVersion = parseVersion(process.versions.node);
const minimumVersion = parseVersion(REQUIRED_VERSION);

if (!currentVersion) {
  exitWithError(
    `Could not parse the active Node.js version (${process.versions.node}).`
  );
}

if (currentVersion.major !== REQUIRED_MAJOR) {
  exitWithError(
    `Detected Node ${process.version}. Gymnasticon requires Node ${REQUIRED_MAJOR}.x (>= ${REQUIRED_VERSION}).`
  );
}

if (compareVersions(currentVersion, minimumVersion) < 0) {
  exitWithError(
    `Detected Node ${process.version}. Gymnasticon requires Node >= ${REQUIRED_VERSION} for compatibility with Raspberry Pi Zero targets.`
  );
}

function parseVersion(versionString) {
  const match = versionString.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10)
  };
}

function compareVersions(a, b) {
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  if (a.patch !== b.patch) {
    return a.patch - b.patch;
  }
  return 0;
}

function exitWithError(message) {
  const instructions = [
    message,
    '',
    `This repository includes an .nvmrc (${REQUIRED_VERSION}). Run "nvm use" or install Node ${REQUIRED_VERSION} manually.`,
    'For Windows/WSL instructions see docs/windows-dev-setup.md.',
    `Set ${SKIP_ENV}=1 to bypass this check if you really know what you are doing.`
  ];
  console.error('[gymnasticon] ' + instructions.join('\n[gymnasticon] '));
  process.exit(1);
}
