# Build a Raspberry Pi Image

Use this guide to build Gymnasticon Raspberry Pi images on Linux. The build wraps Raspberry Pi `pi-gen`, applies the Gymnasticon image stage, and writes compressed `.img.xz` files suitable for flashing from Linux, Windows, or macOS.

## Requirements

- A Linux host, Windows 10/11 with WSL2, or a Mac running an x86_64 Linux VM.
- Docker Desktop 4.x or newer on Windows, with WSL integration enabled.
- At least 15 GB of free space inside the Linux filesystem.
- The repository cloned inside the Linux filesystem.

On WSL, prefer a path like:

```text
\\wsl$\Ubuntu\home\<user>\gymnasticonV2
```

Avoid building from `/mnt/c/...`; `pi-gen` writes many small files and the NTFS bridge significantly slows the build.

### Building from a Mac

The supported Mac-hosted route is an x86_64 Ubuntu VM or remote x86_64 Linux
machine. Install Docker inside Linux, clone this repository onto the VM's Linux
filesystem, and run the same commands below. Do not clone into a macOS shared
folder; `pi-gen` needs Linux filesystem semantics, loop devices, and `binfmt`
support. Native Docker Desktop builds on macOS are not currently supported.

The build output still targets Raspberry Pi hardware. Copy the completed
`.img.xz` back to macOS and flash it with Raspberry Pi Imager or balenaEtcher.

## Prepare Docker

Confirm Docker is reachable:

```bash
docker info
```

If a previous `pi-gen` build left a stopped container behind, remove it:

```bash
docker ps -a | grep pigen_work
docker rm -v pigen_work
```

> **Buster builds on modern kernels (WSL2):** the legacy Buster archive ships an
> ancient `qemu-user-static` whose emulated `sync()` can hang the build forever
> (a wedged `qemu-arm-static ... /bin/sync` process in `D` state). `build.sh`
> now downloads a modern, statically-linked `qemu-arm-static` automatically and
> injects it into the pi-gen container, so no manual step is needed. If a build
> ever hangs again at `sync`, terminate the distro (`wsl --terminate Ubuntu`),
> restart the Docker daemon, remove the stale `pigen_work` container
> (`docker rm -v pigen_work`), and rerun.

## Build

From the repository root:

```bash
# Modern Bookworm image for Zero 2 W, Pi 3, Pi 4, Pi 400, and CM boards
GYM_CONFIG=config.bookworm bash scripts/build-pi-image.sh

# Legacy Buster image for Pi Zero / Zero W with a USB BLE dongle
GYM_CONFIG=config.buster bash scripts/build-pi-image.sh
```

Run both commands sequentially to build both release images. Each build recreates
the `pi-gen` workspace, so copy or publish the first artifact before starting the
second build.

The build usually takes 20-40 minutes depending on host performance and network speed.

## Output

Completed images and checksums are written under:

```text
deploy/pi-sdcard/pi-gen/deploy/
```

Expected image names:

- `Gymnasticon-modern-*.img.xz`
- `Gymnasticon-legacy-*.img.xz`

Copy an image to your Windows downloads folder if needed:

```bash
cp deploy/pi-sdcard/pi-gen/deploy/Gymnasticon-modern-*.img.xz /mnt/c/Users/James/Downloads/
```

Flash the `.img.xz` with Raspberry Pi Imager, balenaEtcher, or `dd`.

## First-Boot Customization

Before first boot, open the FAT partition named `bootfs`. This is normally the
only partition macOS displays; the Linux root partition is intentionally hidden.
The same FAT partition is mounted at `/boot/firmware` on Bookworm and `/boot` on
Buster.

At the top level of `bootfs`, optionally add:

- `gymnasticon-wifi.env` for Wi-Fi credentials.
- `gymnasticon.json` for bike-specific Gymnasticon settings.

The image copies these settings into the installed system during boot.

## Release Checklist

Before publishing an image:

1. Verify the SHA256 checksum.
2. Flash the image to fresh media.
3. Boot on the target Pi family.
4. Confirm `sudo systemctl status gymnasticon`.
5. Pair a training app with `GymnasticonV2`.
6. Save the service log if anything behaves unexpectedly.

## Publish a GitHub Release

Build both supported images into a dedicated asset directory:

```bash
scripts/build-release-images.sh release-assets
```

After testing the images and pushing the matching Git tag, create or update the
GitHub release with both images and their checksums:

```bash
scripts/create-release-from-image.sh v2.0.4 release-assets
```

Add `--draft` to create a draft release. The uploader verifies every checksum
before publishing and refuses to create a release unless its tag already exists
on GitHub.
