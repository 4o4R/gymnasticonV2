## Fixed

- Autodetect now reports what the radio actually saw when no bike is found. Each failed scan prints the number of BLE devices seen (with sample names) plus actionable guidance: power the bike on, pedal once so it broadcasts, and confirm no phone/watch/tablet is currently connected to it — most bikes stop advertising while a device is connected. This turns a silent "nothing is happening" scan into a readable diagnostic.
- Schwinn IC8 / Bowflex C6 detection now also matches the CSC (0x1816) and FTMS (0x1826) service UUIDs, so these bikes are discovered even when the advertisement omits the local name.

## Context

Addresses issue #10 follow-up: the service was running and scanning, but a Bowflex C6 that was already connected to (or recently used by) a phone/watch/tablet stops broadcasting, so the Pi never sees it and advertising of `GymnasticonV2` never starts. The new scan visibility log line tells you exactly which case you are in.

## Tests

- Added regressions for autodetect no-match feedback, per-scan BLE visibility counting, and IC8/C6 service-UUID matching; the suite now contains 216 passing assertions.

## Images

- **Modern (Raspberry Pi Zero 2 W / Bookworm):** `Gymnasticon-modern-v2.0.8.img.xz` — attached with SHA256 checksum. Use this for the Pi Zero 2 W setup from issue #10.
- **Legacy (Raspberry Pi Zero / Buster):** `Gymnasticon-legacy-v2.0.8.img.xz` — attached with SHA256 checksum. Both images are now built; the Buster build was unblocked by neutralizing `sync()` during the build (a WSL2 kernel `sync()` hang that wedged debootstrap, package postinsts, and image export).
