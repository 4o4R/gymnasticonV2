#!/bin/bash

# Exit on error
set -e

echo "Setting up Gymnasticon dependencies for Raspberry Pi Zero..."

# Update package lists
sudo apt-get update

# Install Node.js 14
if ! command -v node &> /dev/null; then
    echo "Installing Node.js 14..."
    curl -fsSL https://deb.nodesource.com/setup_14.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# Install build dependencies
sudo apt-get install -y \
    git \
    build-essential \
    python2.7 \
    python-dev \
    cmake \
    pkg-config \
    libusb-1.0-0-dev \
    libudev-dev \
    libhidapi-dev \
    bluetooth \
    bluez \
    libbluetooth-dev \
    libglib2.0-dev

# Install global npm packages
sudo npm install -g node-gyp@6.1.0

# Set up bluetooth permissions
sudo setcap cap_net_raw+eip $(eval readlink -f `which node`)

echo "Setting up system service..."
sudo cp deploy/gymnasticon.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable gymnasticon

echo "Setup complete! You can now install Gymnasticon:"
echo "npm install"
echo ""
echo "To start the service:"
echo "sudo systemctl start gymnasticon"