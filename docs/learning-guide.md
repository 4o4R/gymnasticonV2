# Gymnasticon V2 Learning Guide

This guide gives a “tour” of the code base so you can learn how each piece fits together without having to reverse–engineer every module. It’s organised by the same directories you will see in the repository, and for each major file it explains the problem it solves, the inputs/outputs to expect, and the most important ideas to notice while you study the source.

> **Tip:** When you want to trace behaviour, start from `src/app/cli.js`, follow the imports mentioned here, and keep this document open as a map.

---

## Top-Level Layout

| Path | What lives here | Study highlights |
| ---- | --------------- | ---------------- |
| `src/app/` | Runtime entry points (CLI, application lifecycle, simulation utilities) | Focus on how the CLI gathers options, builds `App`, and coordinates Bluetooth setup. |
| `src/bikes/` | Drivers for each supported bike, plus auto-detection logic | Each driver interprets bike-specific data formats and emits standardised “stats” events. |
| `src/servers/` | BLE and ANT+ servers that expose stats to external apps | Look at how measurements are encoded according to the relevant specs. |
| `src/util/` | Reusable helpers (BLE scanning, timers, filtering, logging, power smoothing) | These utilities are used by both bike drivers and servers to keep behaviour consistent. |
| `src/test/` | Tape-based unit tests, plus a small fake-timer shim for deterministic timing | Read alongside the modules they exercise to understand expected behaviour. |
| `deploy/` | Scripts and configuration used to build Pi SD-card images and services | Useful when preparing Raspberry Pi deployments (Zero, Zero 2, 3B/4). |
| `scripts/` | Small automation helpers (native module rebuild, test loader) | The project is pure ESM, so these scripts glue together tooling that still expects CommonJS. |
| `docs/` | This guide and reference diagrams/images | Add your own notes here as you learn. |

---

## `src/app/` – Orchestration & Simulation

| File | Role | Key concepts to notice while reading |
| ---- | ---- | ------------------------------------ |
| `cli.js` | Node entry point. Parses CLI flags with `yargs`, loads optional JSON config, initialises Bluetooth, and starts the `App`. | How command-line arguments map to environment variables (`NOBLE_HCI_DEVICE_ID`, `BLENO_HCI_DEVICE_ID`). The shutdown handler listens for `SIGINT`/`SIGTERM` so stop logic always runs. |
| `cli-options.js` | Declarative description of all CLI options (aliases, defaults, descriptions). | A single source of truth for help output and validation. |
| `app.js` | Main controller class. Manages the chosen bike client, BLE/ANT servers, the power smoothing pipeline, and metrics filtering. | Notice the event wiring: bike clients emit `stats`, which feed through filters before being broadcast. |
| `simulation.js` | Emits synthetic pedal events for testing or demo purposes. | Uses a timer-based loop to match a target cadence; the unit tests drive it via fake timers so you can study cadence behaviour without waiting in real time. |
| `auto-install.sh` | Helper shell script to auto-install prerequisites on Debian-based systems. | Useful reference for manual setup. |

---

## `src/bikes/` – Bike Clients & Parsing

| File | Role | What to learn |
| ---- | ---- | ------------- |
| `index.js` | Factory that returns the correct bike client (Flywheel, Keiser, Peloton, IC4, or the simulator/bot). | Shows how CLI options flow into driver selection. |
| `auto-detect.js` | Scans BLE advertisements to identify which bike is nearby. | Example of reusing `createFilter`/`createNameFilter` utilities. |
| `base.js` | Abstract base class that normalises start/stop lifecycle and event emission. | Notice how subclasses emit standardised `stats` events. |
| `bot.js` | “Bike bot” that produces deterministic stats for testing other components. | Good entry point to understand the stats message format without BLE. |
| `flywheel.js`, `keiser.js`, `ic4.js`, `peloton.js` | Real BLE clients for each brand. Each handles discovery, connection, message parsing, dropout filtering, and version quirks. | Cross-reference with corresponding tests in `src/test/bikes/`. Pay attention to manufacturer data parsing and timeout handling. |

When you read any specific bike driver:
- Start from its constructor to see which dependencies it expects (usually `noble`, filters, timers).
- Follow the BLE scanning logic to understand how devices are discovered and filtered.
- Study the `parse` helper near the bottom to learn the raw message layout.

---

## `src/servers/` – BLE & ANT Interfaces

Structure: `src/servers/ble/services/<service-name>/…`

| Area | Description | Learning focus |
| ---- | ----------- | -------------- |
| `heart-rate/`, `cycling-power/`, `cycling-speed-and-cadence/` | GATT service implementations using Bleno. | Each service exports characteristic classes that encode measurement frames; compare with spec documents if you want deeper context. |
| `ant/` | ANT+ broadcast support. | Understand how metrics from bike clients are translated into ANT+ packets. |

The server classes subscribe to `stats` events from the `App`, convert values into the correct protocol format, and push them to connected devices/apps (Zwift, TrainerRoad, etc.).

---

## `src/util/` – Shared Helpers

| Utility | Why it matters |
| ------- | --------------- |
| `ble-scan.js` | Wraps Noble scanning with pluggable filters (`createFilter`, `createNameFilter`, `createAddressFilter`). | Review the tests in `src/test/util/ble-scan.js` for examples. |
| `dropout-filter.js` | Fills in occasional zero values from BLE packets to smooth telemetry. | Demonstrates a simple stateful filter design. |
| `timer.js` | Minimal EventEmitter-based timer abstraction used for cadence timeouts. | Useful when you want deterministic behaviour for bike drivers. |
| `metrics.js`, `metrics-processor.js`, `power-smoother.js`, `health-monitor.js` | Keep rolling averages and monitor connection health. | Follow how each handles edge cases (NaN, negative cadences, etc.). |
| `noble-wrapper.js`, `ble-server.js`, `connection-manager.js` | Simplify initialisation for native Bluetooth libraries. | Pay attention to error handling paths so you know what fails when hardware isn’t present. |
| `logger.js` | Central logging helper. | Understand how debug namespaces map to the `debug` package. |

---

## `src/test/` – Unit Tests & Support

| Path | Purpose |
| ---- | ------- |
| `app/simulation.js` | Asserts that the simulation emits pedal events at the expected timestamps; uses a fake-timer shim. |
| `bikes/*.js` | Validates each bike parser and firmware-specific behaviour (e.g., Keiser timeout changes). |
| `util/*.js` | Exercises the filters and validators in `src/util/`. |
| `support/sinon.js` | Lightweight fake-timer implementation (so the project can run offline without pulling in `@sinonjs/fake-timers`). |
| `support/tape.js` | Small wrapper to import Tape tests from ES modules. |

Run `node scripts/run-tests.mjs` to execute everything without the npm wrapper—handy when you want to tweak tests and rerun quickly.

---

## `scripts/`

| Script | Purpose |
| ------ | ------- |
| `run-tests.mjs` | Loads each test suite (ESM friendly) and then waits for Tape to finish. |
| `rebuild-native.cjs` | Forces a rebuild of native modules after installation—useful on Raspberry Pi when prebuilt binaries aren’t available. |

---

## `deploy/`

Contains everything required to bake a Raspberry Pi image:

- `install.sh` – high-level setup script for Raspbian/Raspberry Pi OS.
- `pi-sdcard/` – stages, services, overlays, and rules used when building a ready-to-boot SD card image.
- `.service` files – systemd units for running Gymnasticon at startup.

If you’re deploying on a Pi Zero, follow this directory while reading the README instructions for hardware-specific tweaks.

---

## How to Use This Guide While Learning

1. **Pick a slice** – Choose the flow you want to understand (e.g., CLI → Keiser bike → BLE server).
2. **Read the summary here** – Note the responsibilities and terminology.
3. **Open the source** – Step through the code with the summary handy. Annotate or print bits you want to remember.
4. **Run the matching tests** – They show the required behaviour and edge cases.
5. **Experiment** – Try running the simulator or bot with different options to see live output.

As you discover new insights, append your own notes to this file or create sibling docs (for example `docs/keiser-notes.md`) so your future self has an even richer reference.

Happy hacking! Keep asking “what does this module assume?” and “who consumes this output?”—that’s the quickest path to mastering the whole code base.
