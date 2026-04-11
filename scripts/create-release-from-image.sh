#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/create-release-from-image.sh <tag> [bookworm|buster] [--draft]

Creates (or updates) a GitHub release and uploads the built Raspberry Pi image
artifact (.img.xz + .sha256) from deploy/pi-sdcard/pi-gen/deploy.

Examples:
  scripts/create-release-from-image.sh v1.5.2 bookworm
  scripts/create-release-from-image.sh v1.5.2 buster --draft
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

TAG="${1:-}"
TARGET="${2:-bookworm}"
DRAFT_FLAG="${3:-}"

if [[ -z "${TAG}" ]]; then
  echo "Missing required tag argument." >&2
  usage
  exit 1
fi

if [[ "${TARGET}" != "bookworm" && "${TARGET}" != "buster" ]]; then
  echo "Target must be either 'bookworm' or 'buster'." >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required. Install it, then run: gh auth login" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="${REPO_ROOT}/deploy/pi-sdcard/pi-gen/deploy"

if [[ ! -d "${DEPLOY_DIR}" ]]; then
  echo "Build output directory not found: ${DEPLOY_DIR}" >&2
  echo "Build first (example): GYM_CONFIG=config.${TARGET} bash scripts/build-pi-image.sh" >&2
  exit 1
fi

if [[ "${TARGET}" == "bookworm" ]]; then
  IMAGE_GLOB="Gymnasticon-modern-*.img.xz"
else
  IMAGE_GLOB="Gymnasticon-legacy-*.img.xz"
fi

mapfile -t CANDIDATES < <(ls -1t "${DEPLOY_DIR}"/${IMAGE_GLOB} 2>/dev/null || true)
if [[ "${#CANDIDATES[@]}" -eq 0 ]]; then
  echo "No image found for ${TARGET} in ${DEPLOY_DIR} matching ${IMAGE_GLOB}" >&2
  exit 1
fi

IMAGE_PATH="${CANDIDATES[0]}"
SHA_PATH="${IMAGE_PATH}.sha256"

if [[ ! -f "${SHA_PATH}" ]]; then
  echo "Generating SHA256 checksum: ${SHA_PATH}"
  (cd "${DEPLOY_DIR}" && sha256sum "$(basename "${IMAGE_PATH}")" > "$(basename "${SHA_PATH}")")
fi

NOTES="Raspberry Pi ${TARGET} image release.

Flash the .img.xz directly with Raspberry Pi Imager or Balena Etcher."

if gh release view "${TAG}" >/dev/null 2>&1; then
  echo "Release ${TAG} already exists; uploading assets (clobber enabled)."
  gh release upload "${TAG}" "${IMAGE_PATH}" "${SHA_PATH}" --clobber
else
  echo "Creating release ${TAG} and uploading assets."
  if [[ "${DRAFT_FLAG}" == "--draft" ]]; then
    gh release create "${TAG}" "${IMAGE_PATH}" "${SHA_PATH}" \
      --title "${TAG}" \
      --notes "${NOTES}" \
      --draft
  else
    gh release create "${TAG}" "${IMAGE_PATH}" "${SHA_PATH}" \
      --title "${TAG}" \
      --notes "${NOTES}"
  fi
fi

echo "Done. Release: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/${TAG}"
