#!/bin/bash -e
# Stage script that prepares the pi-gen image with Gymnasticon, Node, Bluetooth
# helpers, watchdog, and systemd services so the flashed disk boots ready to ride.

NODE_VERSION=14.21.3  # Node.js build compatible with Pi Zero/Zero W (ARMv6)
NODE_SHASUM256=       # optional checksum when we want to verify downloads again
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-armv6l.tar.xz"
NODE_URL="https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}/${NODE_ARCHIVE}"
GYMNASTICON_USER=${FIRST_USER_NAME}  # default pi-gen user
GYMNASTICON_GROUP=${FIRST_USER_NAME} # keep npm install permissions aligned

# Download and extract Node.js into /opt/gymnasticon/node when missing.
if [ ! -x "${ROOTFS_DIR}/opt/gymnasticon/node/bin/node" ] ; then
  TMPD=$(mktemp -d)
  trap 'rm -rf $TMPD' EXIT
  curl -Lo "$TMPD/node.tar.xz" "${NODE_URL}"
  if [ -n "$NODE_SHASUM256" ]; then
    sha256sum -c <(echo "$NODE_SHASUM256 $TMPD/node.tar.xz")
  else
    echo "Skipping Node.js tarball checksum verification (no hash provided)"
  fi
  install -v -m 644 "$TMPD/node.tar.xz" "${ROOTFS_DIR}/tmp/node.tar.xz"
  on_chroot <<'NODE_EOF'
    mkdir -p /opt/gymnasticon/node
    cd /opt/gymnasticon/node
    tar --strip-components=1 -xJf /tmp/node.tar.xz
    chown -R "${GYMNASTICON_USER}:${GYMNASTICON_GROUP}" /opt/gymnasticon
    echo "export PATH=/opt/gymnasticon/bin:/opt/gymnasticon/node/bin:\$PATH" >> /home/pi/.profile
    echo "raspi-config nonint get_overlay_now || export PROMPT_COMMAND=\"echo  -e '\033[1m(rw-mode)\033[0m\c'\"" >> /home/pi/.profile
    echo "overctl -s" >> /home/pi/.profile
NODE_EOF
fi

# Extract the bundled Gymnasticon source into /opt/gymnasticon/app.
install -v -m 644 files/gymnasticon-src.tar.gz "${ROOTFS_DIR}/tmp/gymnasticon-src.tar.gz"
on_chroot <<'APP_EOF'
  set -e
  APP_ROOT="/opt/gymnasticon/app"
  mkdir -p "${APP_ROOT}"
  tar -xzf /tmp/gymnasticon-src.tar.gz -C "${APP_ROOT}"
  chown -R "${GYMNASTICON_USER}:${GYMNASTICON_GROUP}" /opt/gymnasticon
  rm -f /tmp/gymnasticon-src.tar.gz
  ln -sf /etc/gymnasticon.json "${APP_ROOT}/gymnasticon.json"
  ln -sf /etc/gymnasticon.json /opt/gymnasticon/gymnasticon.json
APP_EOF

# Install production dependencies using the bundled Node runtime.
on_chroot <<'NPM_EOF'
  su ${GYMNASTICON_USER} -c 'export PATH=/opt/gymnasticon/node/bin:\$PATH; cd /opt/gymnasticon/app; CXXFLAGS="-std=gnu++14" npm install --omit=dev'
NPM_EOF

# Deploy helper scripts, services, and firmware/udev assets.
install -v -m 644 files/gymnasticon.json "${ROOTFS_DIR}/etc/gymnasticon.json"
install -d -m 755 "${ROOTFS_DIR}/opt/gymnasticon/bin"
install -v -m 755 files/gymnasticon-wrapper.sh "${ROOTFS_DIR}/opt/gymnasticon/bin/gymnasticon"
install -v -m 644 files/gymnasticon.service "${ROOTFS_DIR}/etc/systemd/system/gymnasticon.service"
install -v -m 644 files/gymnasticon-mods.service "${ROOTFS_DIR}/etc/systemd/system/gymnasticon-mods.service"
install -v -m 755 files/gymnasticon-wifi-setup.sh "${ROOTFS_DIR}/usr/local/sbin/gymnasticon-wifi-setup.sh"
install -v -m 644 files/gymnasticon-wifi-setup.service "${ROOTFS_DIR}/etc/systemd/system/gymnasticon-wifi-setup.service"
install -v -m 644 files/gymnasticon-wifi.env.example "${ROOTFS_DIR}/boot/gymnasticon-wifi.env.example"
install -d -m 755 "${ROOTFS_DIR}/lib/firmware/brcm"
install -v -m 644 files/firmware/brcm/BCM20702A1-0a5c-21e8.hcd "${ROOTFS_DIR}/lib/firmware/brcm/"
install -v -m 644 files/btusb.conf "${ROOTFS_DIR}/etc/modprobe.d/btusb.conf"
install -v -m 644 files/lockrootfs.service "${ROOTFS_DIR}/etc/systemd/system/lockrootfs.service"
install -v -m 644 files/bootfs-ro.service "${ROOTFS_DIR}/etc/systemd/system/bootfs-ro.service"
install -v -m 644 files/overlayfs.sh "${ROOTFS_DIR}/etc/profile.d/overlayfs.sh"
install -v -m 755 files/overctl "${ROOTFS_DIR}/usr/local/sbin/overctl"
install -v -m 644 files/watchdog.conf "${ROOTFS_DIR}/etc/watchdog.conf"

# Configure Bluetooth, watchdog, and system settings from inside the chroot.
on_chroot <<'CHROOT_EOF'
echo 'dtparam=watchdog=on' >> /boot/config.txt
systemctl enable watchdog

systemctl enable bluetooth
systemctl start bluetooth
hciconfig hci0 up || true
hciconfig hci1 up || true

MODEL="$(tr -d '\0' </proc/device-tree/model 2>/dev/null || echo '')"
if echo "$MODEL" | grep -qiE 'raspberry pi 4|compute module 4|raspberry pi 3|raspberry pi zero 2'; then
  apt-get update
  apt-get install -y --no-install-recommends bluez bluez-firmware pi-bluetooth || true
  systemctl restart bluetooth || true
fi

systemctl enable gymnasticon
systemctl enable gymnasticon-mods
systemctl enable gymnasticon-wifi-setup.service

systemctl enable lockrootfs

dphys-swapfile swapoff
dphys-swapfile uninstall
systemctl disable dphys-swapfile.service
apt-get remove -y --purge logrotate fake-hwclock rsyslog

setcap cap_net_raw+eip /opt/gymnasticon/node/bin/node || true

WIFI_COUNTRY=${WPA_COUNTRY:-US}
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat >/etc/systemd/system/getty@tty1.service.d/override.conf <<'GETTY_OVERRIDE'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin ${FIRST_USER_NAME} --noclear %I \$TERM
GETTY_OVERRIDE
systemctl daemon-reload

raspi-config nonint do_wifi_country "${WIFI_COUNTRY}" || true
rfkill unblock all || true
CHROOT_EOF

on_chroot <<'CHROOT_ENABLE'
systemctl enable gymnasticon-bt-reprobe.service
CHROOT_ENABLE

# Systemd helper: if fewer than two HCIs exist at boot, restart hciuart and
# bring both adapters up. This avoids manual unplug/replug when a USB dongle
# races the onboard UART on Zero/Zero 2.
cat > "${ROOTFS_DIR}/etc/systemd/system/gymnasticon-bt-reprobe.service" <<'REPROBE'
[Unit]
Description=Ensure both Bluetooth HCIs are up for Gymnasticon
After=bluetooth.service hciuart.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c '\
  count=$(ls /sys/class/bluetooth 2>/dev/null | wc -l); \
  if [ "$count" -lt 2 ]; then \
    systemctl restart hciuart || true; \
    sleep 2; \
    hciconfig hci0 up || true; \
    hciconfig hci1 up || true; \
  fi'

[Install]
WantedBy=multi-user.target
REPROBE

# Ensure the UART overlay lines remain in the read-only boot partition.
if [ -f "${ROOTFS_DIR}/boot/config.txt" ]; then
  grep -q '^enable_uart=1' "${ROOTFS_DIR}/boot/config.txt" || printf '\nenable_uart=1\n' >> "${ROOTFS_DIR}/boot/config.txt"
  grep -q '^dtoverlay=miniuart-bt' "${ROOTFS_DIR}/boot/config.txt" || printf 'dtoverlay=miniuart-bt\n' >> "${ROOTFS_DIR}/boot/config.txt"
fi

install -v -m 644 files/motd "${ROOTFS_DIR}/etc/motd"
install -v -m 644 files/51-garmin-usb.rules "${ROOTFS_DIR}/etc/udev/rules.d/51-garmin-usb.rules"
