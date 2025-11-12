#!/bin/bash -e
# fail fast inside the pi-gen stage so build issues surface immediately

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
    echo "export PATH=/opt/gymnasticon/bin:/opt/gymnasticon/node/bin:\$PATH" >> /home/pi/.profile # make both the shim (bin) and the bundled Node runtime available in shells for debugging
    echo "raspi-config nonint get_overlay_now || export PROMPT_COMMAND=\"echo  -e '\033[1m(rw-mode)\033[0m\c'\"" >> /home/pi/.profile # keep the overlayfs prompt helper
    echo "overctl -s" >> /home/pi/.profile # show overlay mount status on login
EOF
fi

install -v -m 644 files/gymnasticon-src.tar.gz "${ROOTFS_DIR}/tmp/gymnasticon-src.tar.gz" # copy the freshly-built source bundle from the stage files into the target rootfs
on_chroot <<EOF
  set -e # stop immediately if any extraction step fails so we do not leave a half-installed tree
  APP_ROOT="/opt/gymnasticon/app" # keep the application code under /opt/gymnasticon/app to separate it from the bundled runtime
  mkdir -p "\${APP_ROOT}" # ensure the application directory exists before we extract files
  tar -xzf /tmp/gymnasticon-src.tar.gz -C "\${APP_ROOT}" # unpack the repo snapshot directly into the application directory
  chown -R "${GYMNASTICON_USER}:${GYMNASTICON_GROUP}" /opt/gymnasticon # hand ownership of the entire /opt/gymnasticon tree to the default user for easier maintenance
  rm -f /tmp/gymnasticon-src.tar.gz # remove the temporary archive now that the contents are in place to save space
  ln -sf /etc/gymnasticon.json "\${APP_ROOT}/gymnasticon.json" # expose the live config file inside the repo so docs referencing /opt/gymnasticon/gymnasticon.json remain accurate
  ln -sf /etc/gymnasticon.json /opt/gymnasticon/gymnasticon.json # also provide a top-level shortcut for users who expect the legacy path
EOF

on_chroot <<EOF
su ${GYMNASTICON_USER} -c 'export PATH=/opt/gymnasticon/node/bin:\$PATH; cd /opt/gymnasticon/app; CXXFLAGS="-std=gnu++14" npm install --omit=dev' # install production dependencies inside the unpacked repo using the bundled Node toolchain
EOF

install -v -m 644 files/gymnasticon.json "${ROOTFS_DIR}/etc/gymnasticon.json" # seed the default runtime configuration file
install -d -m 755 "${ROOTFS_DIR}/opt/gymnasticon/bin" # create a dedicated bin directory for helper scripts exposed to users
install -v -m 755 files/gymnasticon-wrapper.sh "${ROOTFS_DIR}/opt/gymnasticon/bin/gymnasticon" # drop the commented wrapper that launches the CLI with the bundled Node runtime
install -v -m 644 files/gymnasticon.service "${ROOTFS_DIR}/etc/systemd/system/gymnasticon.service" # ship the main systemd service unit
install -v -m 644 files/gymnasticon-mods.service "${ROOTFS_DIR}/etc/systemd/system/gymnasticon-mods.service" # include the overlay adjustments service
install -v -m 755 files/gymnasticon-wifi-setup.sh "${ROOTFS_DIR}/usr/local/sbin/gymnasticon-wifi-setup.sh" # copy the Wi-Fi bootstrap helper that reads /boot/gymnasticon-wifi.env
install -v -m 644 files/gymnasticon-wifi-setup.service "${ROOTFS_DIR}/etc/systemd/system/gymnasticon-wifi-setup.service" # register the systemd unit that runs the helper before networking
install -v -m 644 files/gymnasticon-wifi.env.example "${ROOTFS_DIR}/boot/gymnasticon-wifi.env.example" # drop a template on the boot partition so users know how to headlessly configure Wi-Fi

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
systemctl enable gymnasticon-wifi-setup.service # run the Wi-Fi bootstrapper on every boot before networking so users never need HDMI/keyboard again

systemctl enable lockrootfs # switch the root filesystem to read-only

dphys-swapfile swapoff # disable swap for better SD longevity
dphys-swapfile uninstall # remove the swap file entirely
systemctl disable dphys-swapfile.service # keep the swap service from coming back
apt-get remove -y --purge logrotate fake-hwclock rsyslog # drop high-write services that cause SD wear

setcap cap_net_raw+eip /opt/gymnasticon/node/bin/node || true # allow the bundled Node runtime to open raw BLE sockets

WIFI_COUNTRY=${WPA_COUNTRY:-US} # fall back to a sane default when no country code is provided

  mkdir -p /etc/systemd/system/getty@tty1.service.d
  cat >/etc/systemd/system/getty@tty1.service.d/override.conf <<'GETTY_OVERRIDE'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin ${FIRST_USER_NAME} --noclear %I \$TERM
GETTY_OVERRIDE
  systemctl daemon-reload

  raspi-config nonint do_wifi_country "${WIFI_COUNTRY}" || true # ensure radios are unblocked on first boot
  rfkill unblock all || true # double-check that Bluetooth/Wi-Fi are free to start

EOF

install -v -m 644 files/motd "${ROOTFS_DIR}/etc/motd" # customize the login banner
install -v -m 644 files/51-garmin-usb.rules "${ROOTFS_DIR}/etc/udev/rules.d/51-garmin-usb.rules" # add udev rules for Garmin ANT+ USB sticks
