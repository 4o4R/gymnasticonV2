## Fixed

- Graceful shutdown now releases native noble/bleno HCI handles, including handles abandoned during Bluetooth adapter fallback.
- Shutdown continues if an individual component cleanup fails.
- Added `--ant-enabled` and `--no-ant-enabled` while retaining `--ant-plus` compatibility.
- Unified manual and image installs on one systemd service and wrapper.

## Images

- Modern: Raspberry Pi Zero 2 W / Bookworm
- Legacy: Raspberry Pi Zero / Buster
- SHA256 checksum files are included for both images.
