#!/bin/bash -e

# Keep the chroot pinned to the legacy mirrors that still host Buster packages
# before we install Gymnasticon-specific dependencies.
on_chroot <<'EOF'
sed -i -E 's|https?://(raspbian\.raspberrypi\.org|archive\.raspbian\.org|mirrordirector\.raspbian\.org)/raspbian|http://legacy.raspbian.org/raspbian|g' /etc/apt/sources.list
if [ -f /etc/apt/sources.list.d/raspi.list ]; then
  sed -i -E 's|https?://archive.raspberrypi.org/debian|http://archive.raspberrypi.org/debian|g' /etc/apt/sources.list.d/raspi.list
fi
apt-get update
EOF
