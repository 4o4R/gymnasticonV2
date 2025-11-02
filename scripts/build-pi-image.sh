#!/bin/bash

# This wrapper ensures the Pi image build script runs even on NTFS mounts where execute bits vanish.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" # resolve the directory containing this wrapper
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)" # determine the repository root from the scripts directory
PI_SD_DIR="${REPO_ROOT}/deploy/pi-sdcard" # path to the deployment helper directory that owns build.sh
BUILD_SCRIPT="${PI_SD_DIR}/build.sh" # absolute path to the real build script inside deploy

if [ ! -f "${BUILD_SCRIPT}" ]; then
  echo "Unable to find deploy/pi-sdcard/build.sh from ${SCRIPT_DIR}" # guard against malformed checkouts or moved files
  exit 1
fi

cd "${PI_SD_DIR}" # align the working directory so relative paths inside build.sh (like ../config) resolve correctly
exec bash "${BUILD_SCRIPT}" "$@" # delegate to the real script using bash so execute permissions are not required
