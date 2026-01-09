#!/bin/bash
set -euo pipefail

OS_RELEASE_NAME="Unknown" # default placeholders make our log messages understandable even before we detect the OS
OS_RELEASE_VERSION_ID="" # numeric Debian version (10/11/12) captured from /etc/os-release when available
OS_RELEASE_CODENAME="" # Debian codename (buster/bullseye/bookworm) captured alongside the numeric version

detect_os_release() {
  local os_release_file="/etc/os-release" # standard metadata file that every Raspberry Pi OS build ships with
  if [ -r "$os_release_file" ]; then # guard the source command so we do not error out on exotic/minimal systems
    # shellcheck disable=SC1090
    . "$os_release_file" # import NAME/VERSION_ID/VERSION_CODENAME variables directly into this script
    OS_RELEASE_NAME="${NAME:-Unknown}" # remember the friendly OS label for human-readable logging
    OS_RELEASE_VERSION_ID="${VERSION_ID:-}" # remember the numeric Debian release (10 == Buster, 12 == Bookworm, etc.)
    OS_RELEASE_CODENAME="${VERSION_CODENAME:-}" # remember the codename (buster/bullseye/bookworm) for branch decisions
  else
    OS_RELEASE_NAME="Unknown" # fall back gracefully when the metadata file is missing
    OS_RELEASE_VERSION_ID="" # empty strings keep string comparisons simple even with `set -u`
    OS_RELEASE_CODENAME="" # same here for the codename
  fi
}

maybe_enable_legacy_apt_mirror() {
  local release_is_buster="false" # default assumption is that we are on a modern OS with working mirrors
  if [[ "${OS_RELEASE_CODENAME}" == "buster" || "${OS_RELEASE_VERSION_ID}" == "10" ]]; then # Raspberry Pi OS Legacy reports either codename or version 10
    release_is_buster="true" # mark the detection so we can branch below
  fi

  if [[ "$release_is_buster" != "true" ]]; then # if we are not on Buster, there is nothing special to do
    echo "Detected ${OS_RELEASE_NAME} (${OS_RELEASE_CODENAME:-unknown}); apt mirrors already point at supported repos." # friendly FYI for the user
    return # bail out so Bookworm/Bullseye etc. remain untouched
  fi

  echo "Detected Raspberry Pi OS Legacy (Buster). Repointing apt sources to the archive mirror so installs keep working automatically..." # spell out the automatic fix

  local apt_conf_file="/etc/apt/apt.conf.d/99-gymnasticon-archive-tweaks" # dedicated config file so we do not overwrite user edits
  sudo tee "$apt_conf_file" >/dev/null <<'APTCONF' # write the apt.conf entries with sudo rights
Acquire::Check-Valid-Until "false";
Acquire::AllowReleaseInfoChange::Suite "1";
Acquire::AllowReleaseInfoChange::Codename "1";
Acquire::AllowReleaseInfoChange::Version "1";
APTCONF

  local -a sources_files=("/etc/apt/sources.list") # queue the primary apt sources file for rewriting
  if [ -d /etc/apt/sources.list.d ]; then # many Pi images ship additional list files in this directory
    while IFS= read -r -d '' extra_list; do # read each path using null delimiters to handle spaces safely
      sources_files+=("$extra_list") # remember every discovered file so the loop below touches each one
    done < <(sudo find /etc/apt/sources.list.d -type f -name '*.list' -print0) # `sudo find` is required because the files belong to root
  fi

  local list_file # declare outside the loop for clarity
  for list_file in "${sources_files[@]}"; do # rewrite every sources file we collected
    sudo sed -i 's|deb.debian.org|archive.debian.org|g' "$list_file" # Debian moved Buster packages under archive.debian.org; make the switch automatically
    sudo sed -i 's|security.debian.org|archive.debian.org|g' "$list_file" # security updates live on archive as well, so keep them aligned
    sudo sed -i 's|raspbian.raspberrypi.org|archive.raspbian.org|g' "$list_file" # Raspberry Pi’s repo follows the same archive naming
  done

  echo "Apt mirror patch for Buster complete. Proceeding with package installs..." # status update so the user knows the script is still running
}

# ──────────────────────────────────────────────────────────────────────────────
# Teaching note:
#   This script deliberately resembles a lab handout.  Each block is explained
#   so you can understand *why* we do every step when provisioning a Pi.
# ──────────────────────────────────────────────────────────────────────────────

# Vivid status colors make long installs easier to follow.
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

echo -e "${GREEN}Starting Gymnasticon installation with Node 14 LTS...${NC}"

# ── Stage 1: Install system dependencies and the Pi-compatible Node runtime ──
echo -e "${YELLOW}Installing system packages and Node.js 14.21.3...${NC}"
detect_os_release # gather OS metadata so the script can transparently support both legacy and current Raspberry Pi OS releases
maybe_enable_legacy_apt_mirror # auto-patch apt mirrors on Buster so users never have to learn the codename differences
sudo apt-get update # refresh package indexes using the mirrors configured above (stock mirrors on new OSes, archive mirrors on Buster)
APT_PACKAGES=(
  bluetooth
  bluez
  libbluetooth-dev
  libudev-dev
  libusb-1.0-0-dev
  build-essential
  python3
  pkg-config
  git
  curl
  ca-certificates
)
if sudo apt-cache show python-is-python3 >/dev/null 2>&1; then
  APT_PACKAGES+=(python-is-python3)
else
  echo -e "${YELLOW}python-is-python3 not available on this image; continuing without it (expected on legacy Pi Zero images).${NC}"
fi
sudo apt-get install -y "${APT_PACKAGES[@]}"

# We pin Node to 14.21.3 because it is the newest release that still provides
# official/unofficial ARMv6 builds for the Raspberry Pi Zero / Zero W family.
NODE_VERSION="${NODE_VERSION:-14.21.3}"
ARCH="$(uname -m)"

install_node_armv6() {
  # On ARMv6 we pull from the unofficial archive that still ships legacy builds.
  local archive="node-v${NODE_VERSION}-linux-armv6l.tar.xz"
  local url="https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}/${archive}"
  local tmpdir
  tmpdir="$(mktemp -d)"
  echo -e "${YELLOW}Downloading Node ${NODE_VERSION} for ARMv6...${NC}"
  curl -fsSL "${url}" -o "${tmpdir}/${archive}"
  echo -e "${YELLOW}Installing Node ${NODE_VERSION} into /usr/local...${NC}"
  sudo tar --strip-components=1 -xJf "${tmpdir}/${archive}" -C /usr/local
  rm -rf "${tmpdir}"
}

install_node_default() {
  # Newer boards (ARMv7/ARMv8/x86) can rely on NodeSource’s maintained Node 14 repo.
  curl -fsSL https://deb.nodesource.com/setup_14.x | sudo -E bash -
  sudo apt-get install -y nodejs npm
}

if [ "${ARCH}" = "armv6l" ]; then
  install_node_armv6
else
  install_node_default
fi

# npm v6 (bundled with Node 14) ships node-gyp v5, which fails on Python 3.11 (Bookworm) due to the deprecated 'rU' mode.
sudo npm install -g node-gyp@9 --unsafe-perm >/dev/null 2>&1 || sudo npm install -g node-gyp@9 --unsafe-perm
NODE_GYP_BIN="$(sudo npm root -g)/node-gyp/bin/node-gyp.js"
# Do not persist node_gyp into npm config (some npm versions reject it).
sudo npm config set python /usr/bin/python3

# Grant the Node binary CAP_NET_RAW so noble/bleno can access BLE sockets as
# a non-root user.  This mirrors the behavior described in the README.
sudo setcap cap_net_raw+eip "$(command -v node)" || true

# ── Stage 2: Deploy Gymnasticon into /opt just like the production installer ──
echo -e "${YELLOW}Cloning gymnasticonV2 into /opt/gymnasticon...${NC}"
sudo rm -rf /opt/gymnasticon
sudo git clone https://github.com/4o4R/gymnasticonV2.git /opt/gymnasticon
cd /opt/gymnasticon

# Explain why we pass the CXX standard flag: serialport/noble bindings target
# gnu++14 for Pi Zero builds and will fail to compile without this override.
echo -e "${YELLOW}Installing npm dependencies (omit dev) with Pi-friendly flags...${NC}"
sudo env \
  CXXFLAGS="-std=gnu++14" \
  npm_config_node_gyp="${NODE_GYP_BIN}" \
  npm_config_python="/usr/bin/python3" \
  npm install --omit=dev

# ── Stage 3: Register the service so Gymnasticon auto-starts on boot ──────────
echo -e "${YELLOW}Configuring systemd service...${NC}"
sudo cp deploy/gymnasticon.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable gymnasticon
sudo systemctl restart gymnasticon

echo -e "${GREEN}Installation complete! Gymnasticon service is running.${NC}"
