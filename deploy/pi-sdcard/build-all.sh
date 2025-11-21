#!/usr/bin/env bash
# File: deploy/pi-sdcard/build-all.sh
#
# Run both Gymnasticon images:
#   - config.bookworm  (new / lite / main)
#   - config.buster    (legacy)
#
# This script:
#   - Cleans pi-gen before each build
#   - Calls build.sh with the appropriate GYM_CONFIG
#   - Continues even if one build fails
#   - Prints a summary at the end

set -u  # no unbound variables; we handle errors manually instead of `set -e`

# --------------------------------------------------------------------
# Resolve paths so we can call build.sh reliably from any CWD
# --------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cd "${REPO_ROOT}"

# --------------------------------------------------------------------
# Configs to build (order matters)
# --------------------------------------------------------------------
CONFIGS=(
  "config.bookworm"  # new image (Gymnasticon v2 / lite etc.)
  "config.buster"    # legacy / older image
)

# Track results for a simple summary at the end
RESULT_CONFIGS=()
RESULT_CODES=()

# --------------------------------------------------------------------
# Helper: run a single build
# --------------------------------------------------------------------
run_build() {
  local cfg="$1"

  echo "============================================================"
  echo "=== Building Gymnasticon image with ${cfg} ==="
  echo "============================================================"

  # Clean previous pi-gen workspace to avoid cross-contamination
  if [ -d "${REPO_ROOT}/pi-gen" ]; then
    echo "[INFO] Removing previous pi-gen workspace..."
    rm -rf "${REPO_ROOT}/pi-gen"
  fi

  # Call the existing build.sh, passing through any APT_MIRROR / MIRROR
  # already set in the environment, and selecting the config via GYM_CONFIG.
  echo "[INFO] Starting build.sh for ${cfg}..."
  GYM_CONFIG="${cfg}" bash "${SCRIPT_DIR}/build.sh"
  local rc=$?

  if [ "${rc}" -ne 0 ]; then
    echo "!!! [ERROR] Build FAILED for ${cfg} (exit code ${rc})"
  else
    echo "*** [OK] Build SUCCEEDED for ${cfg}"
  fi

  RESULT_CONFIGS+=("${cfg}")
  RESULT_CODES+=("${rc}")
}

# --------------------------------------------------------------------
# Main loop: build each config, regardless of failures
# --------------------------------------------------------------------
for cfg in "${CONFIGS[@]}"; do
  run_build "${cfg}"
done

# --------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------
echo
echo "==================== BUILD SUMMARY ===================="
overall_rc=0
for i in "${!RESULT_CONFIGS[@]}"; do
  cfg="${RESULT_CONFIGS[$i]}"
  rc="${RESULT_CODES[$i]}"
  if [ "${rc}" -eq 0 ]; then
    echo "  ${cfg}: SUCCESS"
  else
    echo "  ${cfg}: FAILED (exit code ${rc})"
    overall_rc=1
  fi
done
echo "======================================================="
echo

exit "${overall_rc}"

