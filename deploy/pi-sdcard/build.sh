#!/bin/bash -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" # path to deploy/pi-sdcard
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)" # repository root (contains src/, package.json, etc.)
CONFIG_FILE="${SCRIPT_DIR}/config"
if [ -n "${GYM_CONFIG}" ]; then
  CONFIG_FILE="${SCRIPT_DIR}/${GYM_CONFIG}"
fi
if [ ! -f "${CONFIG_FILE}" ]; then
  echo "Config file not found: ${CONFIG_FILE}" >&2
  exit 1
fi
RELEASE="$(grep '^RELEASE=' "${CONFIG_FILE}" | tail -n1 | cut -d= -f2)"
PI_GEN_BRANCH=""
if [ "${RELEASE}" = "buster" ]; then
  PI_GEN_BRANCH="2020-02-13-raspbian-buster"
elif [ "${RELEASE}" = "bookworm" ]; then
  # Use a known-good Bookworm tag from pi-gen to avoid signature mismatches on main
  PI_GEN_BRANCH="2025-05-13-raspios-bookworm-armhf"
fi
# Normalise Bookworm mirrors so we don't fall back to the occasionally unavailable
# redirector. If the config leaves them empty or uses the standard raspbian.raspberrypi
# hosts, force a stable direct mirror and keep the upstream as fallback.
if [ "${RELEASE}" = "bookworm" ]; then
  PRIMARY_RASPBIAN_MIRROR="https://raspbian.mirror.constant.com/raspbian/"
  FALLBACK_RASPBIAN_MIRROR="https://raspbian.raspberrypi.org/raspbian/"

  if grep -Eq '^MIRROR=$' "${CONFIG_FILE}" || grep -Eq '^MIRROR=https?://raspbian\.raspberrypi\.(org|com)/raspbian/?$' "${CONFIG_FILE}"; then
    sed -i "s|^MIRROR=.*|MIRROR=${PRIMARY_RASPBIAN_MIRROR}|" "${CONFIG_FILE}"
  fi
  if grep -Eq '^APT_MIRROR=$' "${CONFIG_FILE}" || grep -Eq '^APT_MIRROR=https?://raspbian\.raspberrypi\.(org|com)/raspbian/?$' "${CONFIG_FILE}"; then
    sed -i "s|^APT_MIRROR=.*|APT_MIRROR=${PRIMARY_RASPBIAN_MIRROR}|" "${CONFIG_FILE}"
  fi
fi

# Normalise Buster mirrors separately so we can enforce a primary+fallback pair.
if [ "${RELEASE}" = "buster" ]; then
  PRIMARY_BUSTER_MIRROR="https://archive.raspbian.org/raspbian/"
  FALLBACK_BUSTER_MIRROR="https://raspbian.mirror.constant.com/raspbian/"

  if grep -Eq '^MIRROR=$' "${CONFIG_FILE}" || grep -Eq '^MIRROR=https?://raspbian\.raspberrypi\.(org|com)/raspbian/?$' "${CONFIG_FILE}"; then
    sed -i "s|^MIRROR=.*|MIRROR=${PRIMARY_BUSTER_MIRROR}|" "${CONFIG_FILE}"
  fi
  if grep -Eq '^APT_MIRROR=$' "${CONFIG_FILE}" || grep -Eq '^APT_MIRROR=https?://raspbian\.raspberrypi\.(org|com)/raspbian/?$' "${CONFIG_FILE}"; then
    sed -i "s|^APT_MIRROR=.*|APT_MIRROR=${PRIMARY_BUSTER_MIRROR}|" "${CONFIG_FILE}"
  fi
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to build the Raspberry Pi image. Please install Docker Desktop (with WSL2 integration) or the Linux docker engine before rerunning build.sh."
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not running. Start Docker (e.g. launch Docker Desktop or run 'sudo service docker start') and try again."
  exit 1
fi
if [ ! -f "${REPO_ROOT}/package.json" ] || [ ! -d "${REPO_ROOT}/src" ]; then
  echo "Unable to locate the repository root (expected src/ and package.json next to deploy/) from ${REPO_ROOT}" >&2
  exit 1
fi
if [ -d "pi-gen" ]; then
  echo "Removing previous pi-gen workspace..." # ensure stale clones don't break new builds
  rm -rf pi-gen # wipe the old pi-gen tree so the clone below starts clean
fi
git clone https://github.com/RPi-Distro/pi-gen
cd pi-gen
if [ -n "${PI_GEN_BRANCH}" ]; then
  git fetch
  git fetch --tags
  git checkout "${PI_GEN_BRANCH}"
fi
# Ensure the Docker image that runs pi-gen can generate .bmap files during export
# (required for the export-image stage). The stock Dockerfile occasionally omits
# bmap-tools; force it into the install set if missing.
python3 - <<'PY'
from pathlib import Path
dockerfile = Path("Dockerfile")
text = dockerfile.read_text()
needle = "git vim parted"
if needle in text and "bmap-tools" not in text:
    dockerfile.write_text(text.replace(needle, f"{needle} bmap-tools", 1))
PY
if [ "${RELEASE}" = "buster" ]; then
python3 - <<'PY' # rewrite the Dockerfile so apt pulls from the Debian archive mirrors and ignores expired Release metadata for legacy Buster builds
from pathlib import Path # use pathlib for concise file IO

dockerfile = Path('Dockerfile') # reference the pi-gen Dockerfile we just checked out
original = dockerfile.read_text() # capture the current file contents
needle = "RUN apt-get -y update && \\\n" # locate the original apt-get command that needs augmentation
replacement = ( # build the new RUN command that rewrites sources.list and disables validity checks before updating
    "RUN sed -i 's|deb.debian.org|archive.debian.org|g' /etc/apt/sources.list && \\\n"
    "    sed -i 's|security.debian.org|archive.debian.org|g' /etc/apt/sources.list && \\\n"
    "    echo 'Acquire::Check-Valid-Until \"false\";' > /etc/apt/apt.conf.d/99no-check-valid-until && \\\n"
    "    apt-get -o Acquire::Check-Valid-Until=false -y update && \\\n"
)
if needle not in original: # bail out early if the Dockerfile structure changes unexpectedly
    raise SystemExit('Expected apt-get stanza not found in Dockerfile')
dockerfile.write_text(original.replace(needle, replacement, 1)) # write the patched Dockerfile back to disk

# Prefer archive.raspbian.org for Buster (authoritative), with constant.com as fallback.
primary = "https://archive.raspbian.org/raspbian/"
fallback = "https://raspbian.mirror.constant.com/raspbian/"
mirror = primary
Path("stage0/prerun.sh").write_text(
    '#!/bin/bash -e\n\n'
    'if [ ! -d "${ROOTFS_DIR}" ]; then\n'
    f'\tbootstrap buster "${{ROOTFS_DIR}}" {primary}\n'
    'fi\n'
)
sources_list = (
    f"deb {primary} buster main contrib non-free rpi\n"
    f"deb {fallback} buster main contrib non-free rpi\n"
    f"#deb-src {primary} buster main contrib non-free rpi\n"
)
Path("stage0/00-configure-apt/files/sources.list").write_text(sources_list)

# Add the APT config tweaks in stage0's prerun so they're present before any package operations
prerun = Path("stage0/prerun.sh")
if "99archive-tweaks" not in prerun.read_text():
    prerun.write_text(
        prerun.read_text()
        + "\nmkdir -p \"${ROOTFS_DIR}/etc/apt/apt.conf.d\"\n"
          "cat >\"${ROOTFS_DIR}/etc/apt/apt.conf.d/99archive-tweaks\" <<'APTCONF'\n"
          "Acquire::Check-Valid-Until \"false\";\n"
          "Acquire::Retries \"5\";\n"
          "Acquire::http::Pipeline-Depth \"0\";\n"
          "Acquire::AllowReleaseInfoChange::Suite \"1\";\n"
          "Acquire::AllowReleaseInfoChange::Codename \"1\";\n"
          "Acquire::AllowReleaseInfoChange::Version \"1\";\n"
          "APTCONF\n"
    )

# Add apt-get update helpers to stage1 and stage2 without overwriting existing prerun.sh
for stage in ("stage1", "stage2"):
    update_dir = Path(stage) / "00-apt-update"
    update_dir.mkdir(parents=True, exist_ok=True)
    run_sh = update_dir / "00-run.sh"

    lines = [
        "#!/bin/bash -e",
        "",
        "on_chroot <<'EOF'",
        "set -e",
        "apt-get -o Acquire::Check-Valid-Until=false \\",
        "        -o Acquire::AllowReleaseInfoChange::Suite=true \\",
        "        -o Acquire::AllowReleaseInfoChange::Codename=true \\",
        "        -o Acquire::AllowReleaseInfoChange::Version=true \\",
        "        update",
        "EOF",
        "",
    ]

    run_sh.write_text("\n".join(lines))
    run_sh.chmod(0o755)

sys_tweaks_run = Path("stage2/01-sys-tweaks/01-run.sh")
ensure_snippet = """
# Ensure the apt sources keep the preferred Buster mirror ordering (primary archive.raspbian.org, fallback constant.com)
on_chroot <<'EOF'
set -e
sed -i 's|raspbian\\.raspberrypi\\.org/raspbian|archive.raspbian.org/raspbian|g' /etc/apt/sources.list
sed -i 's|https://raspbian\\.raspberrypi\\.org|https://archive.raspbian.org|g' /etc/apt/sources.list
if [ -d /etc/apt/sources.list.d ]; then
  find /etc/apt/sources.list.d -type f -name '*.list' -exec sed -i 's|raspbian\\.raspberrypi\\.org/raspbian|archive.raspbian.org/raspbian|g' {} \\;
fi
cat >/etc/apt/apt.conf.d/99archive-tweaks <<'APTCONF'
Acquire::Check-Valid-Until "false";
Acquire::Retries "5";
Acquire::http::Pipeline-Depth "0";
Acquire::AllowReleaseInfoChange::Suite "1";
Acquire::AllowReleaseInfoChange::Codename "1";
Acquire::AllowReleaseInfoChange::Version "1";
APTCONF
apt-get -o Acquire::Check-Valid-Until=false \\
        -o Acquire::AllowReleaseInfoChange::Suite=true \\
        -o Acquire::AllowReleaseInfoChange::Codename=true \\
        -o Acquire::AllowReleaseInfoChange::Version=true \\
        update
apt-cache show wpasupplicant >/dev/null 2>&1 || { echo 'ERROR: wpasupplicant missing from archive mirror' >&2; exit 1; }
apt-cache show wireless-tools >/dev/null 2>&1 || { echo 'ERROR: wireless-tools missing from archive mirror' >&2; exit 1; }
EOF
"""
existing_sys_run = sys_tweaks_run.read_text()
if "Ensure the apt sources keep the preferred Buster mirror ordering" not in existing_sys_run:
    sys_tweaks_run.write_text(existing_sys_run.rstrip() + "\n\n" + ensure_snippet.lstrip())

# Also add the apt-get update directly into stage2/02-net-tweaks to ensure it runs
net_tweaks_update = Path("stage2/02-net-tweaks/00-apt-update")
net_tweaks_update.mkdir(parents=True, exist_ok=True)
net_tweaks_run = net_tweaks_update / "00-run.sh"
net_tweaks_run.write_text(
    "#!/bin/bash -e\n"
    "\n"
    "on_chroot <<'EOF'\n"
    "set -e\n"
    "echo '=== Updating apt package cache in 02-net-tweaks ==='\n"
    "apt-get -o Acquire::Check-Valid-Until=false \\\n"
    "        -o Acquire::AllowReleaseInfoChange::Suite=true \\\n"
    "        -o Acquire::AllowReleaseInfoChange::Codename=true \\\n"
    "        -o Acquire::AllowReleaseInfoChange::Version=true \\\n"
    "        update\n"
    "echo '=== Checking for wpasupplicant ==='\n"
    "if ! apt-cache show wpasupplicant >/dev/null 2>&1; then\n"
    "  echo 'ERROR: wpasupplicant not found after apt-get update' >&2\n"
    "  echo '=== Contents of /etc/apt/sources.list ===' >&2\n"
    "  cat /etc/apt/sources.list >&2\n"
    "  echo '=== Contents of /etc/apt/sources.list.d/ ===' >&2\n"
    "  ls -la /etc/apt/sources.list.d/ >&2 || true\n"
    "  exit 1\n"
    "fi\n"
    "echo 'wpasupplicant found in package cache'\n"
    "EOF\n"
)
net_tweaks_run.chmod(0o755)

PY
fi

# For Bookworm, pin a direct mirror and keep a fallback to the upstream mirror to avoid
# the redirector choosing dead mirrors (e.g., mirror.fcix.net).
if [ "${RELEASE}" = "bookworm" ]; then
python3 - <<'PY'
from pathlib import Path

primary = "https://raspbian.mirror.constant.com/raspbian/"
fallback = "https://raspbian.raspberrypi.org/raspbian/"
lines = [
    f"deb {primary} bookworm main contrib non-free rpi",
    f"deb {fallback} bookworm main contrib non-free rpi",
]
src_list = Path("stage0/00-configure-apt/files/sources.list")
src_list.write_text("\n".join(lines) + "\n")

apt_conf = Path("stage0/00-configure-apt/files/apt.conf.d/99retries")
apt_conf.parent.mkdir(parents=True, exist_ok=True)
apt_conf.write_text(
    "Acquire::Retries \"5\";\n"
    "Acquire::http::Pipeline-Depth \"0\";\n"
    "Acquire::http::No-Cache \"true\";\n"
    "Acquire::https::No-Cache \"true\";\n"
)
PY
fi

cp "${CONFIG_FILE}" config
SRC_STAGE_DIR="${SCRIPT_DIR}/stage-gymnasticon"
if [ ! -d "${SRC_STAGE_DIR}" ]; then
  echo "stage-gymnasticon directory not found at ${SRC_STAGE_DIR}" >&2
  exit 1
fi
cp -a "${SRC_STAGE_DIR}" stage-gymnasticon
# Mirror any pre-packaged firmware blobs (e.g., Broadcom Bluetooth patches) into
# the stage files tree so the image ships them even without Internet access.
FIRMWARE_SRC="${REPO_ROOT}/deploy/firmware"
FIRMWARE_DEST="stage-gymnasticon/00-install-gymnasticon/files/firmware"
rm -rf "${FIRMWARE_DEST}"
if [ -d "${FIRMWARE_SRC}" ]; then
  mkdir -p "${FIRMWARE_DEST}"
  cp -av "${FIRMWARE_SRC}/." "${FIRMWARE_DEST}/"
fi
# Bundle the working tree so the pi-gen stage installs *this* checkout rather than whatever is published to npm.
SRC_ARCHIVE="stage-gymnasticon/00-install-gymnasticon/files/gymnasticon-src.tar.gz" # Location inside the pi-gen tree where the stage consumes the source archive.
rm -f "${SRC_ARCHIVE}" # Drop any stale archive from previous builds so we never accidentally reuse mismatched sources.
echo "Bundling local sources into ${SRC_ARCHIVE}..."
# --create starts a brand-new archive each time so we never append to stale data.
# --gzip compresses the payload so docker shuffles fewer bytes.
# --file selects the destination inside the pi-gen working tree.
# --directory ensures the paths inside the tarball are relative to the repo root.
# The remaining positional arguments enumerate the files and folders needed on target systems.
tar \
  --create \
  --gzip \
  --file "${SRC_ARCHIVE}" \
  --directory "${REPO_ROOT}" \
  package.json \
  package-lock.json \
  src \
  stubs \
  scripts \
  types \
  README.md \
  CHANGELOG.md \
  LICENSE || { echo "Failed to create ${SRC_ARCHIVE} (tar exited with $?)" >&2; exit 1; }
find stage-gymnasticon -type f -name '*.sh' -exec sed -i 's/\r$//' {} +
find stage-gymnasticon -type f -name '*.sh' -exec chmod +x {} +
sed -i 's/\r$//' config # strip potential CRLF endings introduced by Windows checkouts so pi-gen parses the config
touch stage2/SKIP_IMAGES
./build-docker.sh
