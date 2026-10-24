## Fixed

- BLE scans no longer hang when noble leaves the adapter in an `unknown` state (seen on some Pi/BlueZ combos): `stopScanningAsync()` could wait forever for a `scanStop` event, which froze autodetect — no "No supported bike found" log, no fallback, no advertising — and also stalled SIGTERM shutdown. Scans now resolve immediately and scan-stopping is bounded everywhere (ble-scan, Keiser disconnect, heart-rate client). This is the issue #10 follow-up fix.
- Image builds now neutralize `sync()` on WSL2 (the host kernel's `sync()` can wedge intermittently, hanging debootstrap, package postinsts, and image export) for **both** the modern and legacy images. Note: the shipped images contain a no-op `/bin/sync`; harmless for the appliance (systemd flushes on shutdown).

## Images

- **Modern (Pi Zero 2 W / Bookworm):** `Gymnasticon-modern-v2.0.9.img.xz` + SHA256
- **Legacy (Pi Zero / Buster):** `Gymnasticon-legacy-v2.0.9.img.xz` + SHA256
