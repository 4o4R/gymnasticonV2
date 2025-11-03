#!/bin/bash -e # fail fast inside the pi-gen stage so build issues surface immediately

NODE_VERSION=14.21.3 # pin the bundled Node runtime to the Raspberry Pi Zero-compatible release
NODE_SHASUM256= # placeholder for an optional checksum should we decide to verify downloads later
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-armv6l.tar.xz" # archive filename provided by the unofficial armv6 build server
NODE_URL="https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}/${NODE_ARCHIVE}" # download URL for the Node runtime
GYMNASTICON_USER=${FIRST_USER_NAME} # reuse the default pi-gen user
GYMNASTICON_GROUP=${FIRST_USER_NAME} # align the group with the chosen user

if [ ! -x "${ROOTFS_DIR}/opt/gymnasticon/node/bin/node" ] ; then # skip the install if Node already exists
  TMPD=$(mktemp -d) # temp directory to hold the download
  trap 'rm -rf $TMPD' EXIT # ensure the temporary directory is cleaned up on exit
  curl -Lo "$TMPD/node.tar.xz" "${NODE_URL}" # retrieve the Node archive quietly but fail on network errors
  if [ -n "$NODE_SHASUM256" ]; then # perform checksum verification when a hash is available
    sha256sum -c <(echo "$NODE_SHASUM256 $TMPD/node.tar.xz") # check the archive hash against the provided value
  else
    echo "Skipping Node.js tarball checksum verification (no hash provided)" # log that the checksum step is intentionally skipped
  fi
  install -v -m 644 "$TMPD/node.tar.xz" "${ROOTFS_DIR}/tmp/node.tar.xz" # stage the archive within the target root filesystem
  on_chroot <<EOF
    mkdir -p /opt/gymnasticon/node # prepare the Node runtime directory
    cd /opt/gymnasticon/node # enter the runtime directory before extraction
    tar --strip-components=1 -xJf /tmp/node.tar.xz # unpack the .tar.xz archive and drop the leading folder
    chown -R "${GYMNASTICON_USER}:${GYMNASTICON_GROUP}" /opt/gymnasticon # give ownership to the default user so npm installs work without sudo
    echo "export PATH=/opt/gymnasticon/node/bin:\$PATH" >> /home/pi/.profile # ensure the bundled Node binaries are available in interactive shells
    echo "raspi-config nonint get_overlay_now || export PROMPT_COMMAND=\"echo  -e '\033[1m(rw-mode)\033[0m\c'\"" >> /home/pi/.profile # keep the overlayfs prompt helper
    echo "overctl -s" >> /home/pi/.profile # show overlay mount status on login
EOF
fi

on_chroot <<EOF
su ${GYMNASTICON_USER} -c 'export PATH=/opt/gymnasticon/node/bin:\$PATH; CXXFLAGS="-std=gnu++14" /opt/gymnasticon/node/bin/npm install -g gymnasticon' # install Gymnasticon globally using the bundled Node runtime
EOF

install -v -m 644 files/gymnasticon.json "${ROOTFS_DIR}/etc/gymnasticon.json" # seed the default runtime configuration file
install -v -m 644 files/gymnasticon.service "${ROOTFS_DIR}/etc/systemd/system/gymnasticon.service" # ship the main systemd service unit
install -v -m 644 files/gymnasticon-mods.service "${ROOTFS_DIR}/etc/systemd/system/gymnasticon-mods.service" # include the overlay adjustments service

install -v -m 644 files/lockrootfs.service "${ROOTFS_DIR}/etc/systemd/system/lockrootfs.service" # add the root filesystem lock service
install -v -m 644 files/bootfs-ro.service "${ROOTFS_DIR}/etc/systemd/system/bootfs-ro.service" # mount /boot read-only after boot
install -v -m 644 files/overlayfs.sh "${ROOTFS_DIR}/etc/profile.d/overlayfs.sh" # expose overlayfs helper functions in shells
install -v -m 755 files/overctl "${ROOTFS_DIR}/usr/local/sbin/overctl" # install the overlay control command

install -v -m 644 files/watchdog.conf "${ROOTFS_DIR}/etc/watchdog.conf" # configure the watchdog daemon

on_chroot <<EOF
echo 'dtparam=watchdog=on' >> /boot/config.txt # enable the hardware watchdog in firmware
systemctl enable watchdog # start the watchdog on boot

systemctl enable bluetooth # ensure BlueZ starts automatically after boot
systemctl start bluetooth # start Bluetooth during image build so adapters are configured
hciconfig hci0 up || true # bring the onboard Bluetooth adapter online when available
hciconfig hci1 up || true # attempt to power on a second USB Bluetooth adapter

systemctl enable gymnasticon # launch Gymnasticon automatically
systemctl enable gymnasticon-mods # ensure overlay modifications happen at startup

systemctl enable lockrootfs # switch the root filesystem to read-only

dphys-swapfile swapoff # disable swap for better SD longevity
dphys-swapfile uninstall # remove the swap file entirely
systemctl disable dphys-swapfile.service # keep the swap service from coming back
apt-get remove -y --purge logrotate fake-hwclock rsyslog # drop high-write services that cause SD wear

setcap cap_net_raw+eip /opt/gymnasticon/node/bin/node || true # allow the bundled Node runtime to open raw BLE sockets

EOF

install -v -m 644 files/motd "${ROOTFS_DIR}/etc/motd" # customize the login banner
install -v -m 644 files/51-garmin-usb.rules "${ROOTFS_DIR}/etc/udev/rules.d/51-garmin-usb.rules" # add udev rules for Garmin ANT+ USB sticks
