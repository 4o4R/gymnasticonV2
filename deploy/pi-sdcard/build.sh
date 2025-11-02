#!/bin/bash -e

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to build the Raspberry Pi image. Please install Docker Desktop (with WSL2 integration) or the Linux docker engine before rerunning build.sh."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not running. Start Docker (e.g. launch Docker Desktop or run 'sudo service docker start') and try again."
  exit 1
fi

if [ -d "pi-gen" ]; then
  echo "Removing previous pi-gen workspace..." # ensure stale clones don't break new builds
  rm -rf pi-gen # wipe the old pi-gen tree so the clone below starts clean
fi

git clone https://github.com/RPi-Distro/pi-gen
cd pi-gen
git fetch
git fetch --tags
git checkout 2020-02-13-raspbian-buster
sed -i 's|deb.debian.org/debian|archive.debian.org/debian|g' Dockerfile # point base image sources to the Debian archive since buster is EOL
sed -i 's|security.debian.org/debian-security|archive.debian.org/debian-security|g' Dockerfile # do the same for the security mirror
sed -i 's|apt-get -y update|apt-get -o Acquire::Check-Valid-Until=false -y update|g' Dockerfile # allow archived Release files without valid-until metadata
cp ../config config
cp -a ../stage-gymnasticon stage-gymnasticon
touch stage2/SKIP_IMAGES
./build-docker.sh
