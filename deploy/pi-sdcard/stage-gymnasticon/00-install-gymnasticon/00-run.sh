#!/bin/bash -e

# Ensure the basic pseudo-filesystem mount points exist before `on_chroot`
# tries to bind mount them. Some earlier stages prune empty directories and we
# don't want realpath() to complain and abort our helper wrapper.
mkdir -p "${ROOTFS_DIR}/proc" \
         "${ROOTFS_DIR}/sys" \
         "${ROOTFS_DIR}/dev/pts"

# Keep the chroot pinned to the primary mirrors that still host Buster packages
# before we install Gymnasticon-specific dependencies and disable the expiry
# checks that the old Buster Release metadata no longer refreshes.
on_chroot <<'EOF'
sed -i -E 's|https?://(raspbian\.raspberrypi\.org|archive\.raspbian\.org|mirrordirector\.raspbian\.org)/raspbian|http://archive.raspbian.org/raspbian|g' /etc/apt/sources.list
if [ -f /etc/apt/sources.list.d/raspi.list ]; then
  sed -i -E 's|https?://archive.raspberrypi.org/debian|http://archive.raspberrypi.org/debian|g' /etc/apt/sources.list.d/raspi.list
fi
cat >/etc/apt/apt.conf.d/99legacy-repos <<'CONF'
Acquire::Check-Valid-Until "false";
Acquire::Retries "5";
Acquire::http::Pipeline-Depth "0";
CONF
apt-get update
EOF
