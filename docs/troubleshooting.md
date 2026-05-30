# Troubleshooting

This guide covers the issues most likely to affect installation, Bluetooth pairing, and runtime operation.

## Check the Service First

On Raspberry Pi installs, Gymnasticon runs as a systemd service.

```bash
sudo systemctl status gymnasticon
journalctl -u gymnasticon -f
```

Useful signals in the log:

- `radio map`: shows which adapter is used for bike scanning, BLE advertising, heart-rate scanning, and ANT+.
- `bike disconnected`: confirms the bike connection dropped and Gymnasticon is restarting discovery.
- `ANT+ mode`: shows whether ANT+ output is enabled and whether a stick is present.
- `Heart-rate rebroadcast disabled`: usually means the system has only one Bluetooth adapter or heart-rate rebroadcast was disabled in config.

## Installation Fails During Native Module Build

Native modules are the most common source of install failures. The supported runtime is Node.js 14.21.3.

Confirm the active Node version:

```bash
node --version
npm --version
```

If you are on Raspberry Pi OS, prefer the installer because it pins Node 14 and configures the native build toolchain:

```bash
curl -sSL https://raw.githubusercontent.com/4o4R/gymnasticonV2/main/deploy/install.sh | bash
```

For manual Linux installs, set the build environment before running `npm install`:

```bash
sudo apt-get install -y bluetooth bluez libbluetooth-dev libudev-dev libusb-1.0-0-dev build-essential python3 pkg-config git curl ca-certificates

NODE_GYP_BIN="$(npm root -g)/node-gyp/bin/node-gyp.js"
export npm_config_node_gyp="$NODE_GYP_BIN"
export npm_config_python=/usr/bin/python3
export CXXFLAGS=-std=gnu++14

npm install
```

If you see `ValueError: invalid mode: 'rU'`, an old `node-gyp`/Python combination is being used. Use the installer on Raspberry Pi OS, or install a modern `node-gyp` and point `npm_config_node_gyp` at it.

## Bluetooth Adapter Is Missing

List adapters:

```bash
hciconfig -a
bluetoothctl list
rfkill list
```

Bring adapters up:

```bash
sudo rfkill unblock bluetooth
sudo hciconfig hci0 up
sudo hciconfig hci1 up
```

If a USB adapter does not appear:

1. Confirm it is visible over USB:
   ```bash
   lsusb
   ```
2. Check kernel logs:
   ```bash
   sudo dmesg | grep -i -E 'bluetooth|hci|firmware'
   ```
3. Try a powered USB hub if the adapter is connected through an OTG cable.

## Broadcom USB Bluetooth Firmware

Some USB BLE dongles, including adapters based on Broadcom BCM20702A1, require firmware before Linux creates `hci1`.

Missing firmware usually appears in `dmesg` as:

```text
Bluetooth: hci1: BCM: firmware Patch file not found
```

Gymnasticon includes `deploy/firmware/brcm/BCM20702A1-0a5c-21e8.hcd`. The Raspberry Pi image and installer copy it to `/lib/firmware/brcm/`. If `hci1` is still missing, verify the file exists on the Pi and reboot.

## App Cannot Pair With Gymnasticon

1. Confirm the bike is powered on and awake.
2. Watch the service logs while pairing:
   ```bash
   journalctl -u gymnasticon -f
   ```
3. Confirm Gymnasticon is advertising as `GymnasticonV2` or the configured `serverName`.
4. If using a Pi Zero / Zero W, prefer a USB BLE dongle for advertising.
5. Remove old pairings from the training app and scan again.
6. Restart the service:
   ```bash
   sudo systemctl restart gymnasticon
   ```

## Heart Rate Is Not Rebroadcast

Gymnasticon listens for standard BLE Heart Rate Service peripherals. Apple Watch does not advertise that profile directly, so it requires an iPhone bridge app that re-advertises watch heart rate over BLE.

Heart-rate rebroadcast is enabled automatically when Gymnasticon has a suitable second adapter. On single-adapter Pi Zero systems it is disabled by default for stability.

Configuration options:

```json
{
  "heartRateEnabled": true,
  "heartRateAdapter": "hci1"
}
```

## ANT+ Output Is Missing

ANT+ requires a compatible USB ANT+ stick. It is independent of Bluetooth adapter assignment.

Check that Linux sees the stick:

```bash
lsusb
journalctl -u gymnasticon -f
```

To force ANT+ on:

```json
{
  "antEnabled": true
}
```

If no stick is present, Gymnasticon continues running in BLE-only mode.

## Windows Development Issues

Windows is useful for source editing, tests, and bot-mode development. Raspberry Pi or Linux remains the recommended runtime environment for Bluetooth work.

If VSCode launches the wrong Node binary, run:

```powershell
nvm use 14.21.3
code .
```

If native modules fail during Windows install, use the Windows setup guide:

- [Windows development setup](windows-dev-setup.md)

## Reporting an Issue

Include:

- Raspberry Pi model or workstation OS.
- Install path used: image, installer, or manual install.
- Node and npm versions.
- Bluetooth adapters from `hciconfig -a`.
- ANT+ stick model if applicable.
- Last 100-200 lines from `journalctl -u gymnasticon`.
- The relevant `/etc/gymnasticon.json` settings with passwords or personal data removed.
