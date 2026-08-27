# Build a Raspberry Pi Image

Use this guide to build Gymnasticon Raspberry Pi images locally with WSL2 or Linux. The build wraps Raspberry Pi `pi-gen`, applies the Gymnasticon image stage, and writes compressed `.img.xz` files suitable for flashing.

## Requirements

- Windows 10/11 with WSL2, or a Linux host.
- Docker Desktop 4.x or newer on Windows, with WSL integration enabled.
- At least 15 GB of free space inside the Linux filesystem.
- The repository cloned inside the Linux filesystem.

On WSL, prefer a path like:

```text
\\wsl$\Ubuntu\home\<user>\gymnasticonV2
```

Avoid building from `/mnt/c/...`; `pi-gen` writes many small files and the NTFS bridge significantly slows the build.

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

Before first boot, mount the boot partition and optionally add:

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
scripts/create-release-from-image.sh v2.0.3 release-assets
```

Add `--draft` to create a draft release. The uploader verifies every checksum
before publishing and refuses to create a release unless its tag already exists
on GitHub.
