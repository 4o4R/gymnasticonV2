#!/bin/bash -e

# Prepare the chroot for package operations before the Gymnasticon stage runs.
# Older pi-gen stages occasionally leave the pseudo filesystem mount points
# missing or rewrite APT mirrors back to the now-stale defaults; correct the
# layout and refresh the cache from the archive mirrors that still host Buster.

echo "[gymnasticon] Ensuring chroot mount points exist before apt refresh"
mkdir -p "${ROOTFS_DIR}/proc" \
         "${ROOTFS_DIR}/sys" \
         "${ROOTFS_DIR}/dev/pts"

on_chroot <<'EOF'
set -e

. /etc/os-release
if [ "${VERSION_CODENAME:-}" = "buster" ] || [ "${VERSION_ID:-}" = "10" ]; then
  echo "[gymnasticon] Normalising legacy Buster mirror URLs"
  # Only Buster belongs on the legacy mirror. Preserve Bookworm's live sources.
  for list in /etc/apt/sources.list /etc/apt/sources.list.d/*.list; do
    [ -f "$list" ] || continue
    sed -i -E 's@(https?://)(raspbian\.raspberrypi\.(org|com)|archive\.raspbian\.org|mirrordirector\.raspbian\.org)/raspbian@\1legacy.raspbian.org/raspbian@g' "$list"
  done
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
fi

echo "[gymnasticon] Refreshing package indexes"
apt-get -o Acquire::Check-Valid-Until=false \
        -o Acquire::AllowReleaseInfoChange::Suite=true \
        -o Acquire::AllowReleaseInfoChange::Codename=true \
        -o Acquire::AllowReleaseInfoChange::Version=true \
        update

# Modern raspi-config otherwise downloads overlayroot during first boot, when
# the appliance may have no network. Buster uses its older initramfs overlay.
if [ "${VERSION_CODENAME:-}" = "bookworm" ] || [ "${VERSION_ID:-}" = "12" ]; then
  apt-get install -y --no-install-recommends overlayroot
fi

for pkg in libudev-dev watchdog; do
  if apt-cache show "$pkg" >/dev/null 2>&1; then
    echo "[gymnasticon] Verified availability of $pkg"
  else
    echo "ERROR: $pkg missing from archive after mirror refresh" >&2
    exit 1
  fi
done
EOF
