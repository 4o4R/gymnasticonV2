# Changelog

## [2.0.5] - 2026-08-28
### Fixed
- **Process-crash fixes** — several code paths could kill the whole service via the global `uncaughtException → process.exit(1)` handler:
  - Bot mode: a non-JSON (or `null`) UDP control packet no longer crashes the process; the handler bails out gracefully and the leftover debug logging was removed.
  - Peloton: serial write/drain failures are surfaced as a disconnect instead of throwing from inside the write callback.
  - IC4 and Flywheel: truncated protocol frames are rejected with a graceful parse error instead of a `RangeError` crash.
- **ANT+ broadcasting**
  - The ANT+ server now waits for the stick's async `startup` handshake (instead of configuring the channel before the network key is set), so ANT+ broadcasting actually works on real hardware.
  - The broadcaster fires its first tick immediately and removed dead/ignored timer options.
- **BLE server robustness**
  - A failed `startAdvertising`/`setServices` now resets server state so retries can succeed instead of wedging the server in `starting` forever (which also left a potential zombie advertiser).
  - Removed the nonstandard `0x2903` CCCD descriptors from the notify characteristics (bleno auto-adds the spec-correct `0x2902`).
  - Cycling Power notifications are now trimmed to the populated payload length so the byte count matches the flag bits.
  - The CSC Feature characteristic now updates its value buffer in place, so clients always read the current capability bits.
- **Reconnect robustness**
  - Speed/cadence sensor clients: the stats watchdog now tears down the physical BLE link before reconnecting, preventing an endless "already connected" retry loop.
  - Connection manager: timeout handling no longer races the in-flight `connectAsync`, and the internal connection map no longer leaks entries.
  - IC8: added peripheral-disconnect handling so the app stops advertising stale power/cadence when the bike drops; `disconnect()` now resets crank state.
  - Health monitor: `stale` events are emitted only on the transition into staleness (with recovery on fresh data) instead of every interval, and a zero/negative interval no longer spins a tight loop.
- **Sensor / protocol correctness**
  - Fixed HCI-version parsing in adapter detection (hex `0x0b` and decimal codes) and the extended-scan threshold, so `NOBLE_EXTENDED_SCAN` is only enabled on Bluetooth 5.0+ radios.
  - Keiser: no longer accepts arbitrary nameless BLE devices that merely share the ubiquitous `02 01` advertisement prefix.
  - Peloton: truncated telemetry frames no longer emit `NaN` power/cadence.
  - Power/speed estimators now guard against `NaN` inputs instead of propagating them.
- **Timers**
  - A throwing timer listener no longer kills a repeating timer (the next tick is always scheduled).
  - `Timer` now supports an `immediate` first tick (used by the ANT+ broadcaster).
- **Tests**
  - Added regression tests for the crash paths (short IC4/Flywheel frames, malformed bot UDP messages, truncated Peloton frames, timer throw-safety/immediate) and corrected the ANT+ startup test to model real stick behavior.

## [2.0.4] - 2026-08-27
### Fixed
- Put first-boot customization files on the macOS-visible `bootfs` partition for Bookworm images.
- Configure Wi-Fi through NetworkManager on Bookworm while retaining the Buster `wpa_supplicant` fallback.
- Handle both `/boot/firmware` and `/boot` in image setup and read-only boot services.

## [2.0.3] - 2026-08-26
### Changed
- Expanded the IC4 Bluetooth matcher to also recognize Schwinn 290 advertising names (shared FTMS payload).
- Hardened noble MTU handling to avoid crashes on rapid disconnect/reconnect.
- Added BLE multi-output mirroring across adapters with new `--ble-multi-output` / `--server-adapters` controls.
- Made hcitool fallback respect the configured adapter and emit clearer setup errors.
- Fixed automatic BLE role assignment on Pi Zero-class dual-radio installs so the onboard adapter scans for the bike while USB BLE dongles advertise to apps; single-adapter installs still fall back to reduced-feature mode.
- Fixed Pi Zero install/image setup by using the actual Node.js path in the systemd service, enabling SSH in generated images, and routing the deprecated Pi Zero setup script through the maintained installer.
- Published modern Bookworm and legacy Buster Raspberry Pi images as release assets.

## 1.4.0

- Added support for Keiser M series bikes. [6c0e4571](https://github.com/ptx2/gymnasticon/commit/6c0e45713ba98b9921f1b70550246d5eded3280e)

## 1.3.0

- Added Peloton active cable support (to use without tablet). [40cd8ce1](https://github.com/ptx2/gymnasticon/commit/40cd8ce1c25da335a286b4f24dfcb0b9c252952d)
- Added support for Schwinn IC4/IC8/Bowflex C6 bike. [7f9b0958](https://github.com/ptx2/gymnasticon/commit/7f9b095887010eed5a81dc1d954b4926148b0c58)
- Added BLE Cycling Speed and Cadence output (use non-Peloton bike with Peloton app). [991e03a7](https://github.com/ptx2/gymnasticon/commit/991e03a7c37ebe10e97f1aa50e9f6af62598ec3e)
- Raspberry Pi headless config via /boot/gymnasticon.json. [67496df1](https://github.com/ptx2/gymnasticon/commit/67496df1fb49da8d1e684da947c7e04d850e1b79)

## 1.2.0
- Added ANT+ Bike Power Profile output (for Garmin Fenix and other watches/bike computers). [d72804f6](https://github.com/ptx2/gymnasticon/commit/d72804f601bc7289219901468860a161183d5e2b)
- Fix Bluetooth LE power/cadence reporting issue for Windows clients. [737f8bf5](https://github.com/ptx2/gymnasticon/commit/737f8bf5744cdee7c138c205915b7b3d26115c80)
- Fix Peloton edge-case where user's last-reported cadence persisted after they'd left the ride screen. [1dc4d0d7](https://github.com/ptx2/gymnasticon/commit/1dc4d0d78ffb29f7904741d076529c7d7617f83f)
- Update bleno dependency to add support for recent macOS. [637d6f90](https://github.com/ptx2/gymnasticon/commit/637d6f90e10e5af23a677893a47836f7ced91ead)
- Update ini transitive dependency to fix CVE-2020-7788. [47bec1cd](https://github.com/ptx2/gymnasticon/commit/47bec1cd385925f236b407bd2e2eb2c946765a2a)

## 1.1.0
- Added support for Peloton data source via USB serial device patched to the Peloton data cable. [d9d5f591](https://github.com/ptx2/gymnasticon/commit/d9d5f591ac2367a663da7bd16f5906a1c4847b24)
- Peloton responsiveness improvements. [aef38383](https://github.com/ptx2/gymnasticon/commit/aef38383f074649ce9b2bde2cea24e2dd58f5eba)
- Fix for devices that require crank data to be sent at least every second. [1f0ac252](https://github.com/ptx2/gymnasticon/commit/1f0ac25223146f4f441ddae12f5d95f291e1d9b5)
- Fix burst of pedal events when going from zero to non-zero cadence. [e1e9c681](https://github.com/ptx2/gymnasticon/commit/e1e9c6817fe912878da042e0132079ae0ae9bde3)
- Fix systemd service to always restarts. [54659c64](https://github.com/ptx2/gymnasticon/commit/54659c6432307ad71d2994cc53e3f902010011b7)

## 1.0.5
- Add fix for accurate cadence reporting. [f807cb48](https://github.com/ptx2/gymnasticon/commit/f807cb48c85711e1bbc695762d9293dfaf8a5982)
- Add error message when run with insufficient capabilities. [7cd90d2f](https://github.com/ptx2/gymnasticon/commit/7cd90d2fcabcb354fb5ade7903fa8eb23a523bdb)

## 1.0.4
- Add power-scale and power-offset CLI options. [d6c0e4e0](https://github.com/ptx2/gymnasticon/commit/d6c0e4e067317e4903fafbe1a9016e02087e402f)

## 1.0.3
- Add fix for Flywheel bike's occasional spurious zero power readings. [8f19542f](https://github.com/ptx2/gymnasticon/commit/8f19542fefdc0a25bfdde8fe13392c6c547253cf)

## 1.0.2
- Use a better default value for pedaling timeout. [6b74a655](https://github.com/ptx2/gymnasticon/commit/6b74a6552daadfd7dde582bfe694926fcfb2f810)
- Add minimum Node.js version to NPM package. [11a0b04f](https://github.com/ptx2/gymnasticon/commit/11a0b04f22d71244db9223fc1820ef727587f03d)

## 1.0.1
- Add transpiled files to NPM package. [16010f89](https://github.com/ptx2/gymnasticon/commit/16010f8931335c66fe61b26d0519594a00b4fbb8)

## 1.0.0
- Initial release. [15374e1d](https://github.com/ptx2/gymnasticon/commit/15374e1d825076da835c052f17426b2b47ca50ef)
