#!/bin/bash -e
# Build both modern (bookworm) and legacy (buster) images back-to-back.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

for cfg in config.bookworm config.buster; do
  if [ ! -f "${cfg}" ]; then
    echo "Missing config file ${cfg}, skipping." >&2
    continue
  fi
  echo "=== Building image with ${cfg} ==="
  GYM_CONFIG="${cfg}" bash "${SCRIPT_DIR}/build.sh"
done
