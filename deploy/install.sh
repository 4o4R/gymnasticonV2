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
sudo apt-get update
sudo apt-get install -y bluetooth bluez libbluetooth-dev libudev-dev libusb-1.0-0-dev build-essential python3 python-is-python3 pkg-config git curl ca-certificates

NODE_VERSION="${NODE_VERSION:-16.20.2}"
ARCH="$(uname -m)"

install_node_armv6() {
    local archive="node-v${NODE_VERSION}-linux-armv6l.tar.xz"
    local url="https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}/${archive}"
    local tmpdir
    tmpdir="$(mktemp -d)"
    echo "Downloading Node.js ${NODE_VERSION} for armv6l..."
    curl -fsSL "${url}" -o "${tmpdir}/${archive}"
    echo "Installing Node.js into /usr/local..."
    sudo tar --strip-components=1 -xJf "${tmpdir}/${archive}" -C /usr/local
    rm -rf "${tmpdir}"
}

install_node_default() {
    curl -fsSL https://deb.nodesource.com/setup_16.x | sudo -E bash -
    sudo apt-get install -y nodejs npm
}

if [ "${ARCH}" = "armv6l" ]; then
    install_node_armv6
else
    install_node_default
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

