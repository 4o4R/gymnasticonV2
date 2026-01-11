#!/bin/bash
set -euo pipefail

OS_RELEASE_NAME="Unknown" # default placeholder so log messages still make sense if /etc/os-release is missing
OS_RELEASE_VERSION_ID="" # store Debian version numbers (10, 11, 12, …) once detected
OS_RELEASE_CODENAME="" # store Debian codenames (buster, bullseye, bookworm) once detected

detect_os_release() {
    local os_release_file="/etc/os-release" # standard file shipped by Debian/Raspberry Pi OS describing the current image
    if [ -r "$os_release_file" ]; then # only source the file when it exists and is readable (covers extremely minimal images)
        # shellcheck disable=SC1090
        . "$os_release_file" # load NAME / VERSION_ID / VERSION_CODENAME into this shell so we can use them later
        OS_RELEASE_NAME="${NAME:-Unknown}" # capture the friendly OS name for helpful log messages
        OS_RELEASE_VERSION_ID="${VERSION_ID:-}" # remember the numeric release (e.g. 10 for Buster, 12 for Bookworm)
        OS_RELEASE_CODENAME="${VERSION_CODENAME:-}" # remember the codename so we can branch without parsing numbers
    else
        OS_RELEASE_NAME="Unknown" # fall back to placeholders when the metadata file is missing
        OS_RELEASE_VERSION_ID="" # empty string keeps string comparisons simple even with set -u
        OS_RELEASE_CODENAME="" # same as above for the codename
    fi
}

maybe_enable_legacy_apt_mirror() {
    local release_is_buster="false" # assume modern OS until proven otherwise
    if [[ "${OS_RELEASE_CODENAME}" == "buster" || "${OS_RELEASE_VERSION_ID}" == "10" ]]; then # Raspberry Pi OS Legacy reports either codename or version 10
        release_is_buster="true" # flag the detection so the later block runs
    fi

    if [[ "$release_is_buster" != "true" ]]; then # skip mirror surgery when we are already on Bullseye/Bookworm/etc.
        echo "Detected ${OS_RELEASE_NAME} (${OS_RELEASE_CODENAME:-unknown}); legacy apt tweaks not required." # reassure the user that no manual action is needed
        return # exit the helper cleanly without touching any files
    fi

    echo "Detected legacy Raspberry Pi OS (Buster). Updating apt sources to the archive mirror automatically..." # explain exactly what is happening

    local apt_conf_file="/etc/apt/apt.conf.d/99-gymnasticon-archive-tweaks" # dedicated config file so we never clobber user changes
    sudo tee "$apt_conf_file" >/dev/null <<'APTCONF' # create/overwrite the config file while running as root via sudo
Acquire::Check-Valid-Until "false";
Acquire::AllowReleaseInfoChange::Suite "1";
Acquire::AllowReleaseInfoChange::Codename "1";
Acquire::AllowReleaseInfoChange::Version "1";
APTCONF

    local -a sources_files=("/etc/apt/sources.list") # start with the default apt sources file
    if [ -d /etc/apt/sources.list.d ]; then # Raspberry Pi OS usually ships extra snippets in this directory
        while IFS= read -r -d '' extra_list; do # iterate safely over every *.list file using null delimiters
            sources_files+=("$extra_list") # append each discovered file to the array so the loop below rewrites it
        done < <(sudo find /etc/apt/sources.list.d -type f -name '*.list' -print0) # run the search with sudo because the files are root-owned
    fi

    local list_file # declare the loop variable outside the loop to keep shellcheck happy
    for list_file in "${sources_files[@]}"; do # touch every apt sources file we collected
        sudo sed -i 's|deb.debian.org|archive.debian.org|g' "$list_file" # Debian moved Buster packages to archive.debian.org; rewrite the mirror automatically
        sudo sed -i 's|security.debian.org|archive.debian.org|g' "$list_file" # security updates moved as well, so keep them consistent
        sudo sed -i 's|raspbian.raspberrypi.org|archive.raspbian.org|g' "$list_file" # Raspberry Pi’s mirror follows the same archive pattern
    done

    echo "Legacy mirror patch complete. Continuing with package installs..." # keep the user informed so they know the script is still running
}

# Ensure we are not executing from inside /opt/gymnasticon before deleting it (prevents ENOENT from getcwd)
cd / || exit 1

# Cleanup previous installation
if systemctl list-unit-files | grep -q '^gymnasticon.service'; then
    sudo systemctl stop gymnasticon || true
    sudo systemctl disable gymnasticon || true
    sudo rm -f /etc/systemd/system/gymnasticon.service
fi
sudo npm uninstall -g gymnasticon >/dev/null 2>&1 || true
sudo rm -rf /opt/gymnasticon

# Install prerequisites
detect_os_release # populate OS_RELEASE_* variables so the script knows whether it is on Buster, Bullseye, or Bookworm
maybe_enable_legacy_apt_mirror # automatically adjust apt mirrors for legacy Buster images so users do not need to know what "Buster" means
sudo apt-get update # refresh apt metadata using whatever mirrors are now configured (stock mirrors for new OSes, archive mirrors for Buster)
APT_PACKAGES=(
  bluetooth
  bluez
  libbluetooth-dev
  libudev-dev
  libusb-1.0-0-dev
  build-essential
  python3
  pkg-config
  git
  curl
  ca-certificates
) # base dependencies required on every supported distro
if sudo apt-cache show python-is-python3 >/dev/null 2>&1; then
  APT_PACKAGES+=(python-is-python3) # Bullseye/Bookworm provide this virtual package to map python -> python3
else
  echo "Skipping python-is-python3 (package not available on this release)" # Pi Zero W Buster images lack python-is-python3; continue without it
fi
sudo apt-get install -y "${APT_PACKAGES[@]}" # ensure all required system libraries and tools are present for BLE/USB and native builds

NODE_VERSION="${NODE_VERSION:-14.21.3}" # default to the Pi Zero-friendly Node.js LTS release unless the caller overrides it
ARCH="$(uname -m)" # capture the current CPU architecture so we can choose the correct Node installation path

remove_existing_node() {
    if command -v node >/dev/null 2>&1; then # check for any existing Node.js installation
        echo "Detected preinstalled Node.js ($(node -v 2>/dev/null || echo unknown)); replacing with ${NODE_VERSION} to match Gymnasticon requirements." # announce the replacement to avoid surprises
    else
        echo "No preinstalled Node.js detected; installing ${NODE_VERSION} fresh." # clarify when no replacement is needed
    fi

    sudo apt-get purge -y nodejs npm >/dev/null 2>&1 || true # remove conflicting distro/NodeSource Node.js/npm packages
    sudo rm -f /etc/apt/sources.list.d/nodesource.list # drop any previously added NodeSource repo (e.g., 16/18) to prevent version clashes
    sudo apt-get autoremove -y >/dev/null 2>&1 || true # clean up stray dependencies from the removed packages
    sudo apt-get update # refresh apt metadata after repo changes
}

install_node_armv6() {
    local archive="node-v${NODE_VERSION}-linux-armv6l.tar.xz" # Node tarball name for armv6 boards
    local url="https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}/${archive}" # unofficial archive that still publishes armv6 builds
    local tmpdir # temporary staging directory for the download
    tmpdir="$(mktemp -d)" # create the temp directory
    echo "Downloading Node.js ${NODE_VERSION} for armv6l..." # log progress for the user
    curl -fsSL "${url}" -o "${tmpdir}/${archive}" # fetch the tarball quietly but fail on errors
    echo "Installing Node.js into /usr/local..." # announce the install destination
    sudo tar --strip-components=1 -xJf "${tmpdir}/${archive}" -C /usr/local # unpack Node into /usr/local stripping the top-level folder
    rm -rf "${tmpdir}" # clean up the temporary files
}

install_node_default() {
    curl -fsSL https://deb.nodesource.com/setup_14.x | sudo -E bash - # configure the NodeSource repo for the Node 14 line
    sudo apt-get install -y nodejs # install the distro-specific Node.js 14 build (includes npm)
}

ensure_npm() {
    # Teaching note: Debian Bookworm splits npm into its own package, so a plain
    # `apt-get install nodejs` may *not* include npm. We install it explicitly
    # when missing so later `sudo npm ...` steps succeed.
    if command -v npm >/dev/null 2>&1; then
        return # npm already available; nothing to do
    fi
    echo "npm not found; installing the Debian npm package so install steps can continue." # log for transparency
    sudo apt-get install -y npm
}

unblock_bluetooth() {
    if command -v rfkill >/dev/null 2>&1; then # only attempt unblocking when rfkill exists
        sudo rfkill unblock bluetooth || true # clear soft blocks so hciconfig up does not fail with RF-kill errors
    fi
}

remove_existing_node # forcibly replace any preinstalled Node.js (e.g., Node 16/18) with the required Node 14 line

if [ "${ARCH}" = "armv6l" ]; then
    install_node_armv6 # Pi Zero/Zero W path
else
    install_node_default # newer Pis or other architectures use the NodeSource repository
fi
ensure_npm # guarantee npm exists before we run any npm-based steps below

# Ensure node-gyp is compatible with Python 3.11 on Bookworm (npm v6 ships node-gyp v5 which fails with 'rU')
sudo npm install -g node-gyp@9 --unsafe-perm >/dev/null 2>&1 || sudo npm install -g node-gyp@9 --unsafe-perm # install a Python 3.11-safe node-gyp globally
NODE_GYP_BIN="$(sudo npm root -g)/node-gyp/bin/node-gyp.js" # resolve the installed node-gyp path regardless of whether npm's prefix is /usr or /usr/local
# Do NOT persist node_gyp into npm config.
# Some npm versions reject "node_gyp" as a valid config key and error with:
#   "npm ERR! node_gyp is not a valid npm option"
# Instead, pass it as an environment variable at install time.

# Ensure Bluetooth services are enabled and adapters powered before starting Gymnasticon
sudo systemctl enable bluetooth # Persistently enable the BlueZ Bluetooth service
sudo systemctl start bluetooth # Start the Bluetooth service immediately for the current session
unblock_bluetooth # clear any rfkill blocks (common on USB dongles) before bringing adapters up
sudo hciconfig hci0 up || true # Bring the onboard Bluetooth adapter up if present
sudo hciconfig hci1 up || true # Attempt to bring a second USB Bluetooth adapter up when available

# Align adapter identity with Gymnasticon and reduce classic advertising conflicts.
if command -v btmgmt >/dev/null 2>&1; then
    for dev in hci0 hci1; do
        if btmgmt -i "$dev" info >/dev/null 2>&1; then
            sudo btmgmt -i "$dev" power off || true
            sudo btmgmt -i "$dev" name GymnasticonV2 || true
            sudo btmgmt -i "$dev" bredr off || true # disable BR/EDR so LE ads are not overshadowed
            sudo btmgmt -i "$dev" power on || true
        fi
    done
fi

# Expand the root filesystem now (so resize2fs_once.service has already run)
ROOT_DEVICE=$(df --output=source / | tail -n 1)
if command -v resize2fs >/dev/null && [ -n "$ROOT_DEVICE" ]; then
    sudo resize2fs "$ROOT_DEVICE" >/dev/null 2>&1 || true
    sudo systemctl disable --now resize2fs_once.service resize2fs_once.timer >/dev/null 2>&1 || true
    sudo systemctl mask resize2fs_once.service resize2fs_once.timer >/dev/null 2>&1 || true
fi

# Enable autologin on the primary console so the Pi boots straight into a shell.
AUTOLOGIN_DIR="/etc/systemd/system/getty@tty1.service.d"
AUTOLOGIN_USER="${AUTOLOGIN_USER:-pi}"
sudo mkdir -p "$AUTOLOGIN_DIR"
sudo tee "$AUTOLOGIN_DIR/override.conf" >/dev/null <<EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $AUTOLOGIN_USER --noclear %I \$TERM
EOF
sudo systemctl daemon-reload >/dev/null 2>&1 || true
sudo systemctl restart getty@tty1.service >/dev/null 2>&1 || true

# Allow the Node runtime to open raw BLE sockets without sudo (required for bleno/noble)
sudo setcap cap_net_raw+eip "$(command -v node)" || true

# Clone Gymnasticon repository
APP_DIR="/opt/gymnasticon"
sudo mkdir -p "$APP_DIR" # ensure the parent prefix exists before cloning
sudo git clone https://github.com/4o4R/gymnasticonV2.git "$APP_DIR"
cd "$APP_DIR"
sudo env \
    CXXFLAGS="-std=gnu++14" \
    npm_config_node_gyp="${NODE_GYP_BIN}" \
    npm_config_python="/usr/bin/python3" \
    npm install --omit=dev --unsafe-perm --cache /tmp/npm-cache # install production dependencies directly inside the repo (allow scripts under sudo and avoid cache permission issues)
sudo install -d -m 755 /opt/gymnasticon/bin # create a bin directory for helper scripts
sudo install -m 755 "$APP_DIR/deploy/pi-sdcard/stage-gymnasticon/00-install-gymnasticon/files/gymnasticon-wrapper.sh" /opt/gymnasticon/bin/gymnasticon # reuse the wrapper so users can run `gymnasticon` manually
sudo install -m 644 "$APP_DIR/deploy/pi-sdcard/stage-gymnasticon/00-install-gymnasticon/files/gymnasticon.json" /etc/gymnasticon.json # seed the default config on manual installs for parity with the image
sudo ln -sf /etc/gymnasticon.json "$APP_DIR/gymnasticon.json" # expose the config inside the repo tree for documentation consistency
sudo install -d -m 755 /lib/firmware/brcm # make sure the firmware directory exists even on minimal images
if [ -f "$APP_DIR/deploy/firmware/brcm/BCM20702A1-0a5c-21e8.hcd" ]; then
    sudo install -m 644 "$APP_DIR/deploy/firmware/brcm/BCM20702A1-0a5c-21e8.hcd" /lib/firmware/brcm/ # preload the Broadcom BCM20702 patch so CSR-based USB Bluetooth dongles work without Internet
fi
sudo install -m 644 "$APP_DIR/deploy/pi-sdcard/stage-gymnasticon/00-install-gymnasticon/files/btusb.conf" /etc/modprobe.d/btusb.conf # force-reset and disable autosuspend for btusb to reduce patch failures on some dongles

# Configure systemd service
sudo tee /etc/systemd/system/gymnasticon.service > /dev/null <<'SERVICE'
[Unit]
Description=Gymnasticon Bike Bridge
After=bluetooth.service
Requires=bluetooth.service

[Service]
Type=simple
WorkingDirectory=/opt/gymnasticon
ExecStart=/usr/bin/node /opt/gymnasticon/src/app/cli.js --config /etc/gymnasticon.json
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
SERVICE

sudo systemctl daemon-reload
sudo systemctl enable gymnasticon
sudo systemctl start gymnasticon

echo "Gymnasticon installation complete"
