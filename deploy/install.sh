#!/bin/bash
set -e

# System prep
sudo apt-get update
sudo apt-get install -y nodejs npm bluetooth bluez libudev-dev

# Install Gymnasticon
sudo npm install -g gymnasticon

# Configure systemd
cat > /etc/systemd/system/gymnasticon.service << EOL
[Unit]
Description=Gymnasticon Bike Bridge
After=bluetooth.service
Requires=bluetooth.service

[Service]
Type=simple
ExecStart=/usr/bin/gymnasticon
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOL

# Enable and start service
sudo systemctl enable gymnasticon
sudo systemctl start gymnasticon