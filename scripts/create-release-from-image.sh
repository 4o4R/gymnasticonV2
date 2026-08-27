#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/create-release-from-image.sh <tag> <asset-directory> [--draft]

Creates a GitHub release, or updates an existing one, with both Raspberry Pi
images and their SHA256 checksum files.

The asset directory must contain files produced by build-release-images.sh:
  Gymnasticon-modern-<tag>.img.xz
  Gymnasticon-modern-<tag>.img.xz.sha256
  Gymnasticon-legacy-<tag>.img.xz
  Gymnasticon-legacy-<tag>.img.xz.sha256
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -lt 2 || $# -gt 3 ]]; then
  usage >&2
  exit 1
fi

tag="$1"
asset_dir="$2"
draft_flag="${3:-}"

if [[ "${draft_flag}" != "" && "${draft_flag}" != "--draft" ]]; then
  echo "Unknown option: ${draft_flag}" >&2
  usage >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required. Install it and run 'gh auth login'." >&2
  exit 1
fi

if ! command -v sha256sum >/dev/null 2>&1; then
  echo "sha256sum is required to verify release assets." >&2
  exit 1
fi

if [[ ! -d "${asset_dir}" ]]; then
  echo "Asset directory not found: ${asset_dir}" >&2
  exit 1
fi

asset_dir="$(cd "${asset_dir}" && pwd)"
assets=()

for variant in modern legacy; do
  image_name="Gymnasticon-${variant}-${tag}.img.xz"
  checksum_name="${image_name}.sha256"

  if [[ ! -f "${asset_dir}/${image_name}" || ! -f "${asset_dir}/${checksum_name}" ]]; then
    echo "Missing ${variant} release image or checksum in ${asset_dir}." >&2
    exit 1
  fi

  if ! (cd "${asset_dir}" && sha256sum --check --status "${checksum_name}"); then
    echo "Checksum verification failed for ${image_name}." >&2
    exit 1
  fi

  assets+=("${asset_dir}/${image_name}" "${asset_dir}/${checksum_name}")
done

if gh release view "${tag}" >/dev/null 2>&1; then
  echo "Updating existing release ${tag}..."
  gh release upload "${tag}" "${assets[@]}" --clobber
else
  create_args=(
    "${tag}"
    "${assets[@]}"
    --verify-tag
    --title "${tag}"
    --generate-notes
  )
  if [[ "${draft_flag}" == "--draft" ]]; then
    create_args+=(--draft)
  fi

  echo "Creating release ${tag}..."
  gh release create "${create_args[@]}"
fi

release_url="$(gh release view "${tag}" --json url --jq .url)"
echo "Published ${release_url}"
