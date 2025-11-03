#!/bin/bash
set -euo pipefail

# Cleanup previous installation
if systemctl list-unit-files | grep -q '^gymnasticon.service'; then
    sudo systemctl stop gymnasticon || true
    sudo systemctl disable gymnasticon || true
    sudo rm -f /etc/systemd/system/gymnasticon.service
fi
sudo npm uninstall -g gymnasticon >/dev/null 2>&1 || true
sudo rm -rf /opt/gymnasticon

# Install prerequisites
sudo apt-get update # refresh apt metadata so we can fetch the latest package lists
sudo apt-get install -y bluetooth bluez libbluetooth-dev libudev-dev libusb-1.0-0-dev build-essential python3 python-is-python3 pkg-config git curl ca-certificates # ensure all required system libraries and tools are present for BLE/USB and native builds

NODE_VERSION="${NODE_VERSION:-14.21.3}" # default to the Pi Zero-friendly Node.js LTS release unless the caller overrides it
ARCH="$(uname -m)" # capture the current CPU architecture so we can choose the correct Node installation path

install_node_armv6() {
    local archive="node-v${NODE_VERSION}-linux-armv6l.tar.xz" # Node tarball name for armv6 boards
    local url="https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}/${archive}" # unofficial archive that still publishes armv6 builds
    local tmpdir # temporary staging directory for the download
    tmpdir="$(mktemp -d)" # create the temp directory
    echo "Downloading Node.js ${NODE_VERSION} for armv6l..." # log progress for the user
    curl -fsSL "${url}" -o "${tmpdir}/${archive}" # fetch the tarball quietly but fail on errors
    echo "Installing Node.js into /usr/local..." # announce the install destination
    sudo tar --strip-components=1 -xJf "${tmpdir}/${archive}" -C /usr/local # unpack Node into /usr/local stripping the top-level folder
    rm -rf "${tmpdir}" # clean up the temporary files
}

install_node_default() {
    curl -fsSL https://deb.nodesource.com/setup_14.x | sudo -E bash - # configure the NodeSource repo for the Node 14 line
    sudo apt-get install -y nodejs npm # install the distro-specific Node.js 14 build along with npm
}

if [ "${ARCH}" = "armv6l" ]; then
    install_node_armv6 # Pi Zero/Zero W path
else
    install_node_default # newer Pis or other architectures use the NodeSource repository
fi

# Clone Gymnasticon repository
sudo git clone https://github.com/4o4R/gymnasticonV2.git /opt/gymnasticon
cd /opt/gymnasticon
sudo env CXXFLAGS="-std=gnu++14" npm install --omit=dev

# Configure systemd service
sudo tee /etc/systemd/system/gymnasticon.service > /dev/null <<'SERVICE'
[Unit]
Description=Gymnasticon Bike Bridge
After=bluetooth.service
Requires=bluetooth.service

[Service]
Type=simple
WorkingDirectory=/opt/gymnasticon
ExecStart=/usr/bin/env node /opt/gymnasticon/src/app/cli.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
SERVICE

sudo systemctl daemon-reload
sudo systemctl enable gymnasticon
sudo systemctl start gymnasticon

echo "Gymnasticon installation complete"

