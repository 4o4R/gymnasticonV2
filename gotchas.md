# Gotchas

- Distinguish the build host, target hardware, and flashing computer when discussing Raspberry Pi images. This project builds images under Linux even when someone uses macOS to flash the card and edit its visible `bootfs` partition; do not imply that the maintainer builds on macOS.
- Before calling a Bluetooth release robust, test the real dependency lifecycle rather than only mocked public APIs: verify that forced noble/bleno instances do not share cached HCI bindings, exercise malformed variable-length packets, connection/disconnect races, failed GATT setup cleanup, and the exact systemd environment used by release images.
