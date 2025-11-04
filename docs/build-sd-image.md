# Building the Raspberry Pi Image on WSL

Follow the steps below to create the Gymnasticon Raspberry Pi SD/SSD card image from inside Windows Subsystem for Linux (WSL). The process works on any x86\_64 Windows 10/11 machine with WSL2 and Docker Desktop.

## Prerequisites

- Windows 10/11 with WSL2 enabled.
- Docker Desktop 4.x (or newer) installed and running.
  - Enable the **Use the WSL 2 based engine** option.
  - Under **Settings -> Resources -> WSL Integration**, toggle on your WSL distribution (e.g. Ubuntu).
- At least 15 GB of free disk space inside your WSL filesystem.
- This repository cloned inside the WSL filesystem (e.g. `\\wsl$\Ubuntu\home\<user>\gymnasticonV2`). Avoid building from `/mnt/c/...` because pi-gen writes many small files and the NTFS bridge slows down the build.

## Build the image

1. Open a terminal in your WSL distro.
2. Ensure Docker can talk to the daemon:
   ```bash
   docker info
   ```
   If this fails, start Docker Desktop in Windows and retry.   Or if you have tried to build before, Docker may have an old container. Try to remove it:
    ```bash
   docker ps -a | grep pigen_work   # optional: confirm it exists
   docker rm -v pigen_work          # drop the stopped container and scratch volumes
    ```


4. From the repository root, launch the build helper:
   ```bash
   cd ~/gymnasticonV2
   bash scripts/build-pi-image.sh
   ```
   - The wrapper clones Raspberry Pi's `pi-gen` project, applies Gymnasticon's stages, and starts the Docker build.
   - A full build takes 20-40 minutes on most machines. The script prints progress as each pi-gen stage finishes.

## Locate the output

After the build completes, the compressed disk image and SHA256 sums live under:

- `deploy/pi-sdcard/pi-gen/deploy/gymnasticon-raspberrypi.img`
- `deploy/pi-sdcard/pi-gen/deploy/gymnasticon-raspberrypi.img.xz`
- `deploy/pi-sdcard/pi-gen/deploy/gymnasticon-raspberrypi.img.xz.sha256`

You can copy the `.img.xz` (or the raw `.img` if you prefer) onto your Windows filesystem, for example:

```bash
cp deploy/pi-sdcard/pi-gen/deploy/gymnasticon-raspberrypi.img.xz /mnt/c/Users/James/Downloads/
```
You can then clone this to an an SD card to use in your Rasberry Pi.
