#!/bin/bash
set -euo pipefail # Stop immediately if anything fails so we do not leave Wi-Fi half-configured.

LOG_TAG="[gymnasticon-wifi]" # Prefix every log line so users can spot this helper in journalctl output.
CONFIG_FILE="/boot/gymnasticon-wifi.env" # Users edit this file on the boot partition before powering the Pi.
DEFAULT_WIFI_COUNTRY="${DEFAULT_WIFI_COUNTRY:-US}" # Fallback regulatory domain if the user does not provide one.
WPA_SUPPLICANT_PATH="/etc/wpa_supplicant/wpa_supplicant.conf" # Location Raspberry Pi OS reads for Wi-Fi settings.

log() {
  echo "${LOG_TAG} $*" # Tiny helper to print readable status messages.
}

sanitize_env_file() {
  local sanitized # Temporary filename to hold the CRLF-normalized copy.
  sanitized="$(mktemp)" # Create a short-lived file in /tmp that only root can access.
  tr -d '\r' < "$CONFIG_FILE" > "$sanitized" # Drop Windows-style carriage returns so Bash can parse KEY=VALUE lines.
  echo "$sanitized" # Return the sanitized filename to the caller via stdout.
}

escape_wpa_value() {
  # WPA supplicant needs quotes escaped so SSIDs/PSKs with spaces or quotes still parse correctly.
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

load_user_overrides() {
  if [ -r "$CONFIG_FILE" ]; then # Only attempt to load the file when the user actually provided one.
    local sanitized_file # Keep track of the CRLF-stripped temp file so we can delete it later.
    sanitized_file="$(sanitize_env_file)" # Create a copy without carriage returns so `.` parsing behaves.
    # shellcheck disable=SC1090
    . "$sanitized_file" # Source the KEY=VALUE pairs so WIFI_SSID/WIFI_PSK/WIFI_COUNTRY populate in this shell.
    rm -f "$sanitized_file" # Clean up the temporary file immediately now that we are done with it.
    log "Loaded Wi-Fi overrides from $CONFIG_FILE" # Friendly confirmation for the user’s install log.
  else
    log "No $CONFIG_FILE found on /boot; continuing with baked-in defaults." # Explain why we fall back to defaults.
  fi
}

apply_country_and_rfkill() {
  local target_country="${WIFI_COUNTRY:-$DEFAULT_WIFI_COUNTRY}" # Use the user-supplied country or the safe default.
  if [ -z "$target_country" ]; then # Guard against the very-unlikely case where both values are blank.
    target_country="US" # Never pass an empty string into raspi-config or rfkill logs will be confusing.
  fi
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

write_wpa_supplicant() {
  if [ -z "${WIFI_SSID:-}" ]; then # Users might only want to set the country and use Ethernet, so SSID is optional.
    log "WIFI_SSID not provided; leaving ${WPA_SUPPLICANT_PATH} untouched." # Explain why we are not writing a network block.
    return # Exit early because there is nothing else to configure.
  fi

  local passphrase="$WIFI_PSK" # Pull the passphrase into a predictable variable for readability.
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
# Managed by gymnasticon-wifi-setup.sh. Edit /boot/gymnasticon-wifi.env to change these values.
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

main() {
  log "Starting Wi-Fi bootstrap helper..." # Opening line so journals show when the service kicks off.
  load_user_overrides # Pull in any values the user supplied on the boot volume.
  apply_country_and_rfkill # Always set the regulatory domain so radios unblock automatically.
  write_wpa_supplicant # Optionally create wpa_supplicant.conf when the user provided SSID/PSK.
  log "Wi-Fi bootstrap helper finished." # Closing line for easy grepping.
}

main "$@" # Call main to keep the script structure easy to expand later.
