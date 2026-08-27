#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: scripts/build-release-images.sh <output-directory>"
}

if [[ $# -ne 1 ]]; then
  usage >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output_dir="$1"
release_version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${repo_root}/package.json" | head -n 1)"

if [[ -z "${release_version}" ]]; then
  echo "Unable to read the release version from package.json." >&2
  exit 1
fi

mkdir -p "${output_dir}"

build_and_copy() {
  local config="$1"
  local variant="$2"
  local deploy_dir="${repo_root}/deploy/pi-sdcard/pi-gen/deploy"
  local image_path
  local image_name
  local zip_path
  local zip_image

  echo "Building ${config} image..."
  (
    cd "${repo_root}"
    GYM_CONFIG="${config}" bash scripts/build-pi-image.sh
  )

  image_name="Gymnasticon-${variant}-v${release_version}.img.xz"
  image_path="$(find "${deploy_dir}" -maxdepth 1 -type f \
    -name "*Gymnasticon-${variant}*.img.xz" -print -quit)"

  if [[ -n "${image_path}" ]]; then
    cp "${image_path}" "${output_dir}/${image_name}"
  else
    zip_path="$(find "${deploy_dir}" -maxdepth 1 -type f \
      -name "image_*Gymnasticon-${variant}*.zip" -print -quit)"
    if [[ -z "${zip_path}" ]]; then
      echo "Build completed without producing a ${variant} disk image." >&2
      exit 1
    fi

    zip_image="$(unzip -Z1 "${zip_path}" | sed -n '/\.img$/p' | head -n 1)"
    if [[ -z "${zip_image}" ]]; then
      echo "${zip_path} does not contain a disk image." >&2
      exit 1
    fi

    echo "Converting $(basename "${zip_path}") to ${image_name}..."
    unzip -p "${zip_path}" "${zip_image}" | xz -T0 -c > "${output_dir}/${image_name}"
  fi

  (
    cd "${output_dir}"
    sha256sum "${image_name}" > "${image_name}.sha256"
  )

  echo "Saved ${output_dir}/${image_name}"
}

build_and_copy config.bookworm modern
build_and_copy config.buster legacy

echo "Release assets:"
ls -lh "${output_dir}"
