The `0 BLE device(s) seen: none` line is the answer: in that 30s scan the Pi's radio received no advertisements at all — not the C6, not your phone/watch, nothing. That's a radio/scan issue, not detection, so switching from autodetect to a fixed bike type won't help (it uses the same scan).

Confirm the radio directly on the Pi:

    sudo timeout 10 hcitool lescan

- If it also lists nothing → the Pi's BLE radio isn't scanning; that's BlueZ/adapter, not Gymnasticon.
- If it lists devices → it's a noble integration issue; paste the output.

Things to try:

    sudo systemctl restart bluetooth
    sudo systemctl restart gymnasticon

or reset the adapter:

    sudo hciconfig hci0 down && sudo hciconfig hci0 up && sudo systemctl restart gymnasticon

Note the log keeps reporting noble's adapter state as "unknown" — that's the Zero 2 W's onboard BLE being finicky. The reliable route is a USB BLE dongle; Gymnasticon uses the onboard radio for the bike and the dongle for advertising.
