#!/bin/bash
set -e

# Colors for output
GREEN='\033[0;32m'
NC='\033[0m'

echo -e "${GREEN}Starting Gymnasticon Installation...${NC}"

# System dependencies
curl -fsSL https://deb.nodesource.com/setup_16.x | sudo -E bash -
sudo apt-get update
sudo apt-get install -y nodejs npm bluetooth bluez libudev-dev git

# Create installation directory
sudo mkdir -p /opt/gymnasticon
cd /opt/gymnasticon

# Clone and build
git clone https://github.com/4o4R/gymnasticonV2.git .
npm install --omit=dev
npm run build

# Setup systemd service for auto-start
sudo cp deploy/gymnasticon.service /etc/systemd/system/
sudo systemctl enable gymnasticon
sudo systemctl start gymnasticon

echo -e "${GREEN}Installation Complete! Gymnasticon is running.${NC}"
