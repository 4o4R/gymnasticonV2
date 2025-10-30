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

# Install Node.js 16 (matches repository runtime requirements)
curl -fsSL https://deb.nodesource.com/setup_16.x | sudo -E bash -
sudo apt-get update
sudo apt-get install -y nodejs npm bluetooth bluez libbluetooth-dev libudev-dev git

# Clone Gymnasticon repository
sudo git clone https://github.com/4o4R/gymnasticonV2.git /opt/gymnasticon
cd /opt/gymnasticon
sudo npm install --omit=dev

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

