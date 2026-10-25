#!/bin/bash
set -euo pipefail # Stop immediately if anything fails so we do not leave Wi-Fi half-configured.

LOG_TAG="[gymnasticon-wifi]" # Prefix every log line so users can spot this helper in journalctl output.
BOOT_DIR="/boot" # Raspberry Pi OS Buster mounts the FAT boot partition here.
[ -d /boot/firmware ] && BOOT_DIR="/boot/firmware" # Bookworm uses /boot/firmware instead.
CONFIG_FILE="${BOOT_DIR}/gymnasticon-wifi.env" # Users edit this file on the boot partition before powering the Pi.
DEFAULT_WIFI_COUNTRY="${DEFAULT_WIFI_COUNTRY:-US}" # Fallback regulatory domain if the user does not provide one.
WPA_SUPPLICANT_PATH="/etc/wpa_supplicant/wpa_supplicant.conf" # Location Raspberry Pi OS reads for Wi-Fi settings.
NETWORK_MANAGER_PATH="/etc/NetworkManager/system-connections/gymnasticon-wifi.nmconnection" # Bookworm profile path.

log() {
  echo "${LOG_TAG} $*" # Tiny helper to print readable status messages.
}

trim_value() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

escape_wpa_value() {
  # WPA supplicant needs quotes escaped so SSIDs/PSKs with spaces or quotes still parse correctly.
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

load_user_overrides() {
  if [ ! -r "$CONFIG_FILE" ]; then
    log "No Wi-Fi override file found; leaving existing credentials in place."
    return
  fi
  local line key value quote character decoded number=0
  while IFS= read -r line || [ -n "$line" ]; do
    number=$((number + 1))
    line="$(trim_value "${line%$'\r'}")"
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" != *=* ]]; then
      log "Invalid Wi-Fi setting at line $number; expected KEY=value."
      return 1
    fi
    key="$(trim_value "${line%%=*}")"
    key="${key#export }"
    case "$key" in
      WIFI_COUNTRY|WIFI_SSID|WIFI_PSK|WIFI_PSK_FILE) ;;
      *) log "Unsupported Wi-Fi setting at line $number."; return 1 ;;
    esac
    value="$(trim_value "${line#*=}")"
    quote="${value:0:1}"
    if [[ "$quote" == \" || "$quote" == \' ]]; then
      if [ "${#value}" -lt 2 ] || [ "${value: -1}" != "$quote" ]; then
        log "Unclosed quoted Wi-Fi value at line $number."
        return 1
      fi
      value="${value:1:${#value}-2}"
      if [ "$quote" = '"' ]; then
        decoded=""
        while [ -n "$value" ]; do
          character="${value:0:1}"; value="${value:1}"
          if [[ "$character" == \\ && "${value:0:1}" == [\"\$\`\\] ]]; then
            character="${value:0:1}"; value="${value:1}"
          fi
          decoded+="$character"
        done
        value="$decoded"
      fi
    fi
    # Values are data, including spaces, $, backticks, and command substitutions.
    printf -v "$key" '%s' "$value"
  done < "$CONFIG_FILE"
  log "Loaded Wi-Fi overrides."
}

apply_country_and_rfkill() {
  local target_country="${WIFI_COUNTRY:-$DEFAULT_WIFI_COUNTRY}" # Use the user-supplied country or the safe default.
  if [ -z "$target_country" ]; then # Guard against the very-unlikely case where both values are blank.
    target_country="US" # Never pass an empty string into raspi-config or rfkill logs will be confusing.
  fi
  if [[ ! "$target_country" =~ ^[[:alpha:]]{2}$ ]]; then
    log "WIFI_COUNTRY must contain exactly two letters."
    return 1
  fi
  WIFI_COUNTRY="${target_country^^}"
  target_country="$WIFI_COUNTRY"
  if raspi-config nonint do_wifi_country "$target_country"; then # Ask Raspberry Pi OS to persist the regulatory domain.
    log "Set Wi-Fi country to ${target_country} so the radio firmware unblocks automatically." # Success message.
  else
    log "raspi-config failed to set Wi-Fi country (expected on non-Pi images); continuing anyway." # Non-fatal warning.
  fi
  if rfkill unblock all; then # The country change normally unblocks Wi-Fi, but rfkill can still block it, so force unblock.
    log "rfkill reports Wi-Fi/Bluetooth are unblocked." # Note the positive outcome for debugging.
  else
    log "rfkill command failed; check that the rfkill utility exists on this image." # Another non-fatal warning.
  fi
}

write_network_manager_profile() {
  local passphrase="$1"
  local profile_tmp
  profile_tmp="$(mktemp)"

  if ! nmcli --offline connection add \
    type wifi \
    con-name gymnasticon-wifi \
    ifname wlan0 \
    ssid "$WIFI_SSID" \
    wifi-sec.key-mgmt wpa-psk \
    wifi-sec.psk "$passphrase" \
    connection.autoconnect yes \
    ipv4.method auto \
    ipv6.method auto > "$profile_tmp" 2>/dev/null; then
    rm -f "$profile_tmp"
    return 1
  fi

  install -d -m 700 "$(dirname "$NETWORK_MANAGER_PATH")"
  install -m 600 "$profile_tmp" "$NETWORK_MANAGER_PATH"
  rm -f "$profile_tmp"
  if systemctl is-active --quiet NetworkManager.service; then
    if ! nmcli connection reload >/dev/null 2>&1; then
      log "Unable to reload the Wi-Fi profile in NetworkManager."
      return 1
    fi
  fi
  log "Created a NetworkManager profile for the SSID specified in ${CONFIG_FILE}."
}

write_wpa_supplicant() {
  if [ -z "${WIFI_SSID:-}" ]; then # Users might only want to set the country and use Ethernet, so SSID is optional.
    log "WIFI_SSID not provided; leaving ${WPA_SUPPLICANT_PATH} untouched." # Explain why we are not writing a network block.
    return # Exit early because there is nothing else to configure.
  fi

  local passphrase="${WIFI_PSK:-}" # Pull the optional passphrase into a predictable variable for readability.
  if [ -n "${WIFI_PSK_FILE:-}" ] && [ -r "${WIFI_PSK_FILE:-}" ]; then # Allow users to keep the password in a separate file.
    passphrase="$(tr -d '\r' < "$WIFI_PSK_FILE")" # Load and sanitize the file just like we did for the env file.
    log "Loaded Wi-Fi passphrase from ${WIFI_PSK_FILE}." # Confirm which path supplied the secret.
  fi

  if [ -z "$passphrase" ]; then # Abort if we still do not have a password; open networks are rare and we avoid misconfiguring.
    log "WIFI_SSID provided but WIFI_PSK is empty; skip writing ${WPA_SUPPLICANT_PATH} to avoid an unusable config." # Clear error.
    return # Give the user a chance to fix their env file without bricking Wi-Fi.
  fi

  local escaped_ssid # WPA files need escaped strings so keep these in separate variables.
  local escaped_psk
  escaped_ssid="$(escape_wpa_value "$WIFI_SSID")" # Protect quotes/backslashes in the SSID.
  escaped_psk="$(escape_wpa_value "$passphrase")" # Protect quotes/backslashes in the password.

  cat > "$WPA_SUPPLICANT_PATH" <<EOF # Overwrite the system config so the Pi joins the requested network on next boot.
# Managed by gymnasticon-wifi-setup.sh. Edit ${CONFIG_FILE} to change these values.
ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev
update_config=1
country=${WIFI_COUNTRY:-$DEFAULT_WIFI_COUNTRY}

network={
    ssid="${escaped_ssid}"
    psk="${escaped_psk}"
    key_mgmt=WPA-PSK
}
EOF
  chmod 600 "$WPA_SUPPLICANT_PATH" # Lock down the file so casual users cannot read the password.
  chown root:root "$WPA_SUPPLICANT_PATH" # Ensure the file matches the standard ownership expected by wpa_supplicant.
  log "Updated ${WPA_SUPPLICANT_PATH} with the SSID specified in ${CONFIG_FILE}." # Final confirmation for the journal.
}

write_wifi_configuration() {
  if [ -z "${WIFI_SSID:-}" ]; then
    log "WIFI_SSID not provided; leaving system Wi-Fi configuration untouched."
    return
  fi

  local passphrase="${WIFI_PSK:-}"
  if [ -n "${WIFI_PSK_FILE:-}" ]; then
    if [ ! -r "$WIFI_PSK_FILE" ]; then
      log "Unable to read WIFI_PSK_FILE."
      return 1
    fi
    passphrase="$(tr -d '\r' < "$WIFI_PSK_FILE")"
  fi
  if [ -z "$passphrase" ]; then
    log "WIFI_PSK is required when WIFI_SSID is set."
    return 1
  fi
  if command -v nmcli >/dev/null 2>&1 && [ -d /etc/NetworkManager ]; then
    if ! write_network_manager_profile "$passphrase"; then
      log "Unable to configure Wi-Fi with NetworkManager; existing network services were not restarted."
      return 1
    fi
  else
    write_wpa_supplicant
  fi
}

main() {
  log "Starting Wi-Fi bootstrap helper..." # Opening line so journals show when the service kicks off.
  load_user_overrides # Pull in any values the user supplied on the boot volume.
  apply_country_and_rfkill # Always set the regulatory domain so radios unblock automatically.
  write_wifi_configuration # Create a Bookworm NetworkManager or legacy wpa_supplicant profile.
  log "Wi-Fi bootstrap helper finished." # Closing line for easy grepping.
}

main "$@" # Call main to keep the script structure easy to expand later.
