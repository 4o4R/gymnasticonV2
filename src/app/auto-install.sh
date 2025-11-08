#!/bin/bash
set -euo pipefail

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
sudo apt-get update
sudo apt-get install -y bluetooth bluez libbluetooth-dev libudev-dev libusb-1.0-0-dev \
  build-essential python3 python-is-python3 pkg-config git curl ca-certificates

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
sudo env CXXFLAGS="-std=gnu++14" npm install --omit=dev

# ── Stage 3: Register the service so Gymnasticon auto-starts on boot ──────────
echo -e "${YELLOW}Configuring systemd service...${NC}"
sudo cp deploy/gymnasticon.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable gymnasticon
sudo systemctl restart gymnasticon

echo -e "${GREEN}Installation complete! Gymnasticon service is running.${NC}"
