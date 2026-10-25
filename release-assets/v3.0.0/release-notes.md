Compared with **v2.0.9**, v3.0 focuses on reliable Bluetooth startup, recovery, and accurate ride data on older hardware.

- **Bluetooth reliability:** fixes scan/connection hangs, late callbacks, shared-scan conflicts, adapter isolation, and shutdown leaks. Heart-rate reconnects and multi-adapter advertising now handle failures within bounded waits.
- **Ride data:** fixes IC4/Flywheel connection crashes, inflated simulated counters, split FTMS packets, and false IC8/C6 stops. IC8/C6 uses native FTMS power/cadence when available, with resistance-aware power estimation as a fallback.
- **Keiser selection:** prevents nearby consoles from contaminating a ride and adds `--keiser-equipment-id` for consoles whose Bluetooth address changes or is unavailable.
- **Bluetooth compatibility:** adds the required CSC control point with correct subscription, response, and confirmation handling.
- **Installation:** fixes native build tooling, missing npm install scripts, Buster mirrors and boot services, Bookworm mirror handling, and overlay recovery failures.

**Verification:** 726 passing assertions on Windows and Linux, nine deployment checks, lint/syntax checks, a clean Linux native build, and independent probes using the actual pinned Bluetooth libraries.

Node.js **14.21.3** remains required for the existing native stack and Pi Zero support. Physical Pi/radio/bike validation is still outstanding; IC5/Schwinn 290 protocol captures remain a documented limitation.

[Full changes since v2.0.9](https://github.com/4o4R/gymnasticonV2/compare/v2.0.9...v3.0.0)
