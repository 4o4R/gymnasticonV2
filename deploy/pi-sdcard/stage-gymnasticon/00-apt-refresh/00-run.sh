#!/bin/bash -e

# Prepare the chroot for package operations before the Gymnasticon stage runs.
# Older pi-gen stages occasionally leave the pseudo filesystem mount points
# missing or rewrite APT mirrors back to the now-stale defaults; correct the
# layout and refresh the cache from the archive mirrors that still host Buster.

install -d "${ROOTFS_DIR}/proc" \
           "${ROOTFS_DIR}/sys" \
           "${ROOTFS_DIR}/dev/pts"

on_chroot <<'EOF'
set -e

# Normalise the mirror URLs so we always hit the archived Buster packages.
sed -i -E 's|https?://(raspbian\.raspberrypi\.org|archive\.raspbian\.org|mirrordirector\.raspbian\.org)/raspbian|http://archive.raspbian.org/raspbian|g' /etc/apt/sources.list
if [ -f /etc/apt/sources.list.d/raspi.list ]; then
  sed -i -E 's|https?://archive.raspberrypi.org/debian|http://archive.raspberrypi.org/debian|g' /etc/apt/sources.list.d/raspi.list
fi

cat >/etc/apt/apt.conf.d/99legacy-repos <<'CONF'
Acquire::Check-Valid-Until "false";
Acquire::Retries "5";
Acquire::http::Pipeline-Depth "0";
Acquire::AllowReleaseInfoChange::Suite "1";
Acquire::AllowReleaseInfoChange::Codename "1";
Acquire::AllowReleaseInfoChange::Version "1";
CONF

apt-get -o Acquire::Check-Valid-Until=false \
        -o Acquire::AllowReleaseInfoChange::Suite=true \
        -o Acquire::AllowReleaseInfoChange::Codename=true \
        -o Acquire::AllowReleaseInfoChange::Version=true \
        update

for pkg in libudev-dev watchdog; do
  if ! apt-cache show "$pkg" >/dev/null 2>&1; then
    echo "ERROR: $pkg missing from archive after mirror refresh" >&2
    exit 1
  fi
done
EOF
