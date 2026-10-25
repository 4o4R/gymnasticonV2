# Gotchas

- Reproduce pi-gen's dropped capabilities when checking privilege-sensitive setup. Unrestricted-root tests do not model an `on_chroot` child without CAP_SETFCAP; clear runtime xattrs on the host and fail closed when installer-test boundaries are missing.
- Recover a never-completing advertising command by retiring its native binding before replacement. Clearing only a JavaScript latch leaves late callbacks able to stop a newer advertiser.
- Separate "no telemetry" from "no bike": zero the outputs on a telemetry gap and only reconnect after a longer deadline. Any timer that must not decide process lifetime (keep-alives, maintenance, grace windows) has to be unref'd, or a completed test suite never exits.
- Distinguish the build host, target hardware, and flashing computer when discussing Raspberry Pi images. This project builds images under Linux even when someone uses macOS to flash the card and edit its visible `bootfs` partition; do not imply that the maintainer builds on macOS.
- Before calling a Bluetooth release robust, test the real dependency lifecycle rather than only mocked public APIs: verify that forced noble/bleno instances do not share cached HCI bindings, exercise malformed variable-length packets, connection/disconnect races, failed GATT setup cleanup, and the exact systemd environment used by release images.
- When asked to publish a GitHub comment, verify the posted URL and pass Markdown through `--body-file`; do not interpolate backticks or code fences through PowerShell and WSL shell layers.
