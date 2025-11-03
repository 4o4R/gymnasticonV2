# Gymnasticon

![Gymnasticon Logo](docs/gymnasticon.jpg)

Gymnasticon enables obsolete and/or proprietary exercise bikes to work with Zwift and other training apps. Support for new bikes can be added easily. The diagram below shows an example of how it works with the Flywheel Home Bike. :)

## Installation

# Installation Requirements

1. Node.js 14.x (14.21.3 recommended for Pi Zero / Zero W)  
   * Raspberry Pi Zero / Zero W (armv6): download `node-v14.21.3-linux-armv6l.tar.xz` from the [unofficial Node.js archive](https://unofficial-builds.nodejs.org/download/release/v14.21.3/) and unpack it into `/usr/local`.  
   * Raspberry Pi 3/4 and other 64/32-bit hosts: install Node.js 14.x via your preferred package manager (e.g. NodeSource `setup_14.x` for armv7/arm64 or x86\_64).
2. System dependencies:
```bash
sudo apt-get install -y bluetooth bluez libbluetooth-dev libudev-dev libusb-1.0-0-dev build-essential python3 python-is-python3 pkg-config git
```

When building native dependencies on Raspberry Pi Zero or other ARMv6 devices, export `CXXFLAGS=-std=gnu++14` before running `npm install` so that the `usb` bindings compile with the required C++ standard. For development and testing, install dependencies with:
```bash
npm install --include=dev
```
The production image and installer use `npm install --omit=dev`.

To automate the setup, run:
```bash
curl -sSL https://raw.githubusercontent.com/4o4R/gymnasticonV2/main/deploy/install.sh | bash
```


![Gymnasticon System Diagram](docs/diagram.png)

## Bikes tested

* Flywheel
* Peloton Bike (requires an [additional cable](https://github.com/ptx2/gymnasticon/pull/12#issuecomment-696345309))
* Schwinn IC4/IC8 aka Bowflex C6 (power estimation when necessary)
* Keiser M Series Bikes (M3i, M3i-TBT, M3iX)
* LifeFitness IC5 (power estimation)

## Apps and devices tested

Any software, bike computer or watch that supports standard Bluetooth LE and ANT+ power meter and cadence sensors should work, including:

* Zwift
* TrainerRoad
* Rouvy
* RGT
* FulGaz
* mPaceline
* Peloton iOS/Android (BLE CSC cadence only)
* Garmin Fenix (requires ANT+ stick)
* Garmin Edge
* Wahoo Elemnt Bolt (requires ANT+ stick)

## Platforms tested

Raspberry Pi Zero W is recommended for best user experience. The provided SD/SSD image targets Raspberry Pi Zero/Zero W through Pi 4 (Buster-based). For Raspberry Pi 5 devices, install Raspberry Pi OS Bookworm and run the manual installer script.

* Raspbian Buster on Raspberry Pi Zero W
* Raspbian Buster on Raspberry Pi 3B+
* Raspbian Buster on Raspberry Pi 4
* Raspberry Pi OS Bookworm on Raspberry Pi 5 (manual install via deploy/install.sh)
* macOS 10.14+
* Debian Buster/Bookworm on x86-64

> Note: If using a Bluetooth LE bike (e.g. Flywheel) a Bluetooth LE 4.1+ adapter with multi-role capability is required. All Raspberry Pi devices listed above have this capability but not every BT 4.1+ adapter is guaranteed to have it. Alternatively, two BT 4.0+ adapters can also work: one for the client (to connect to the bike) and one for the server (to receive connections from Zwift or another app).

## Quick Start: Install Gymnasticon on Raspberry Pi

### Preparation

#### Prepare the OS:

Use the Raspberry Pi Imager on another computer to flash your SD card with Raspbian Buster Lite (2021 version). This version is required for compatibility with Node.js ARMv6 builds.

You can download the OS image from Raspberry Pi Archives.

Insert the SD card:

Insert the prepared SD card into your Raspberry Pi and power it on.

Single Command Installation

SSH into your Raspberry Pi and run the following command:

sudo rm -rf /opt/gymnasticon && nohup bash -c "curl -sSL https://raw.githubusercontent.com/4o4R/gymnasticonV2/main/deploy/install.sh | bash" > install.log 2>&1 &

This command will:
- Remove any old Gymnasticon installation
- Download and execute the installation script
- Force reinstall Node.js (if necessary)
- Install Gymnasticon and configure it to run as a service
You can monitor the installation progress by checking the logs:

tail -f install.log

Test Gymnasticon

Once the installation completes, Gymnasticon should be running as a service. You can check the status:

sudo systemctl status gymnasticon

To monitor real-time logs:

journalctl -u gymnasticon -f

Connect your bike and open Zwift or any supported app to verify functionality.

Revert to Default Configuration

If you need to reset Gymnasticon for another bike or adjust the configuration, edit the config file:

sudo nano /opt/gymnasticon/gymnasticon.json

After making changes, restart the service:

sudo systemctl restart gymnasticon


For development (including running the automated test suite), install the project dependencies locally with:
```bash
npm install --include=dev
```
This ensures tooling such as `sinon` is available.


OR

Install Gymnasticon SD card image

![Gymnasticon Boot Animation](https://user-images.githubusercontent.com/68594395/90970770-e6879180-e4d6-11ea-91d6-26ff06267c86.gif)

This is the easiest way to get up and running on a Raspberry Pi.

Prerequisites:

1. A Raspberry Pi Zero W or Raspberry Pi 4
2. A [compatible](https://www.raspberrypi.org/documentation/installation/sd-cards.md) micro-SD card (4 GB+)
3. Access to a computer with an SD card slot
4. A program to write SD card images like [Raspberry Pi Imager](https://www.raspberrypi.org/downloads/) or `dd(1)`

Steps:

1. Download the latest [Gymnasticon SD card image](https://github.com/ptx2/gymnasticon/releases/latest/download/gymnasticon-raspberrypi.img.xz)
2. Write the image to the SD card using Raspberry Pi Imager or `dd`
3. Optionally add a config file to the SD card (not necessary for Flywheel or Peloton, see below)
4. Insert the SD card in the Raspberry Pi, power it up and wait 2-3 minutes
5. Start pedaling and Gymnasticon should appear in the Zwift device list

### Build the SD card image yourself

If you want to customize the Raspberry Pi image locally, use the `deploy/pi-sdcard` helper. Requirements:

1. Docker (Docker Desktop with the WSL2 backend or the Linux docker engine)
2. At least 15 GB of free disk space
3. The Gymnasticon repo cloned on a Linux system (WSL2 is fine)

Steps:

```bash
cd gymnasticonV2
bash scripts/build-pi-image.sh
```

The script clones Raspberry Pi’s `pi-gen`, applies Gymnasticon’s custom stages, and uses Docker to produce `gymnasticon-raspberrypi.img.xz` under `deploy/pi-sdcard/pi-gen/deploy`. Flash that image to your SD card with Raspberry Pi Imager or `dd`.

> Tip: if you are on Windows/WSL, install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and enable the WSL2 integration for your distribution before running `build.sh`. The script now checks that Docker is installed and running before it starts.

### Adapter auto-detection and multi-radio setups

Gymnasticon now inspects available adapters on boot and automatically chooses sensible defaults:

- Built-in Bluetooth (`hci0`) is used to connect to your bike while a second USB dongle (`hci1`) is used for advertising when present.
- ANT+ broadcasting is enabled automatically when a Garmin USB-M stick is detected; override with `--ant-plus` (force on/off) or `--ant-auto false` to disable.
- Use `--default-bike <type>` to define the fallback profile when autodetect does not find a match (default: `keiser`).
- Additional CLI tuning options let you calibrate estimated speed: `--speed-circumference`, `--speed-gear-factor`, `--speed-min`, and `--speed-max`.

Config file:

If using a bike other than Flywheel or Peloton - create and adapt a `gymnasticon.json` file within the main folder of the SD card. It should end up in the same folder as `bootcode.bin`, `cmdline.txt`, `config.txt`, etc.

The following example configures Gymnasticon to look for a Schwinn IC4 bike and to reduce its power measurement values by 8%:

```
{
  "bike": "ic4",
  "power-scale": 0.92
}
```

The following example configures Gymnasticon to look for a Keiser M series bike:

```
{
  "bike": "keiser"
}
```

See below for additional [configuration options](#CLI-options).

### Gymnasticon SD card read-only mode

During first boot Gymnasticon enables the [Overlay Filesystem](https://www.kernel.org/doc/html/latest/filesystems/overlayfs.html) for the root filesystem ("/") and mounts "/boot" as read-only. This reduces the risk of fatal filesystem corruption as result of e.g. power failures, but also extends the lifetime of the SD card by minimizing wear.

A clean shutdown of Gymnasticon is therefore not necessary. Just keep your Raspberry Pi plugged in and running.

It is still possible to setup [networking and remote access](https://www.raspberrypi.org/documentation/configuration/wireless/headless.md) so you can check logs, or participate in development work. But this mode is neither necessary, nor recommended for typical users.

> Note: This modified Pi OS image will behave equivalent to stock Pi OS images with regards to the `wpa_supplicant.conf` and `ssh` files only during first boot. This means that the Wifi and SSH settings become part of the underlay filesystem and persist across subsequent reboots.
> Placing a `wpa_supplicant.conf` or `ssh` file onto the boot partition after the first boot will result in settings NOT being persisted across reboots. Also note that in this case the `wpa_supplicant.conf` and `ssh` files are removed and not available during another reboot.

You can change the root filesystem between read-only and read-write mode, but also show the current mode using the command `overctl`.

## Troubleshooting

Flywheel bike

* Check that there are fresh batteries in the bike (2x D batteries)
* Check that the bike is calibrated: https://ptx2.net/apps/flytest/

Peloton bike (with passive wiring)

* Note that stats are only broadcast during a class or Just Ride session

## Manual install

Try the Quick Start first. Otherwise read on for how to install Gymnasticon and its dependencies manually.

Dependencies:

* Node.js 16.x
  * [armv6l](https://unofficial-builds.nodejs.org/download/release/v16.20.2/) binaries (Raspberry Pi Zero W)
  * [x64](https://nodejs.org/dist/latest-v16.x/) binaries

* On Linux (including Raspberry Pi)
  * `sudo apt-get install libudev-dev` (required by node-bluetooth-hci-socket)

> Note: Your user must have permission to access the Bluetooth adapter and advertise services.

Install:

```bash
export CXXFLAGS=-std=gnu++14
npm install -g gymnasticon
gymnasticon
```

To run as an unprivileged user:

```bash
# this gives cap_net_raw+eip to all node programs not just gymnasticon
sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
```

To run at boot time, restart on exit and to avoid giving `cap_net_raw+eip` to the node binary it is recommended to run under systemd. See the `deploy/gymnasticon.service` from this repository for an example systemd unit file.

```bash
sudo cp gymnasticon.service /etc/systemd/system
sudo systemctl enable gymnasticon
sudo systemctl start gymnasticon
```

To view the output of Gymnasticon running under systemd:

```bash
journalctl -u gymnasticon -f
```

## CLI options

> Note: The CLI options below can also be used in the config file. `--bike ic4` on
> the command-line is the same as `{"bike":"ic4"}` in the config file.

```text
$ gymnasticon --help
```

```text
   __o
 _ \<_
(_)/(_)

Gymnasticon
v1.4.0

usage: gymnasticon [OPTIONS]

Options:
  --config                <filename> load options from json file        [string]
  --bike                  <type>
               [string] [choices: "flywheel", "peloton", "ic4", "keiser", "bot",
                                           "autodetect"] [default: "autodetect"]
  --bike-connect-timeout  <seconds>                        [number] [default: 0]
  --bike-receive-timeout  <seconds>                        [number] [default: 4]
  --bike-adapter          <name> for bike connection           [default: "hci0"]
  --flywheel-address      <macaddr>
  --flywheel-name         <name>
  --peloton-path          <path> usb serial device path
                                              [string] [default: "/dev/ttyUSB0"]
  --bot-power             <watts> initial bot power                     [number]
  --bot-cadence           <rpm> initial bot cadence                     [number]
  --bot-host              <host> for power/cadence control over udp     [string]
  --bot-port              <port> for power/cadence control over udp     [number]
  --server-adapter        <name> for app connection            [default: "hci0"]
  --server-name           <name> used for Bluetooth advertisement
                                                        [default: "Gymnasticon"]
  --server-ping-interval  <seconds> ping app when user not pedaling
                                                           [number] [default: 1]
  --ant-device-id         <id> ANT+ device id for bike power broadcast
                                                       [number] [default: 11234]
  --power-scale           <value> scale watts by this multiplier
                                                           [number] [default: 1]
  --power-offset          <value> add this value to watts  [number] [default: 0]
  --version               Show version number                          [boolean]
  -h, --help              Show help                                    [boolean]
```

## Testing

Run the unit tests with:

```
npm install --include=dev
npm test
```

## Contributing

```bash
git clone https://github.com/4o4R/gymnasticonV2.git
cd gymnasticonV2
CXXFLAGS="-std=gnu++14" npm install
npm run build
npm link
gymnasticon --help
```

## HOWTO: Add support for a bike

It should be trivial to add support for other proprietary bikes, so long as
there is a means of getting realtime-ish cadence/power data from them.

1. Implement a bikeclient in src/bikes
2. Add cli options to src/app/cli-options
3. Add function to instantiate the bikeclient with the cli options to src/bikes/index.js

## License

MIT

## More info

For detailed development notes and technical background, see the [original project documentation about unbricking a bike with a Raspberry Pi](https://ptx2.net/posts/unbricking-a-bike-with-a-raspberry-pi).
