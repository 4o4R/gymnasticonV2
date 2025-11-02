#!/bin/bash

# This wrapper ensures the Pi image build script runs even on NTFS mounts where execute bits vanish.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" # resolve the directory containing this wrapper
BULID_SCRIPT="${SCRIPT_DIR}/../deploy/pi-sdcard/build.sh" # absolute path to the real build script inside deploy

if [ ! -f "${BULID_SCRIPT}" ]; then
  echo "Unable to find deploy/pi-sdcard/build.sh from ${SCRIPT_DIR}" # guard against malformed checkouts or moved files
  exit 1
fi

exec bash "${BULID_SCRIPT}" "$@" # delegate to the real script using bash so execute permissions are not required
