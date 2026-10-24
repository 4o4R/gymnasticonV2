Final wrap-up @tmulle — **v2.0.8 is fully released** with both images attached (+ SHA256 checksums):

- **`Gymnasticon-modern-v2.0.8.img.xz`** — Pi Zero 2 W / Bookworm *(use this one)*
- **`Gymnasticon-legacy-v2.0.8.img.xz`** — Pi Zero / Buster

**What changed in v2.0.8** (in case you hit it again):
- Autodetect no longer fails silently — if no bike is found it prints `No supported bike found after 30s of scanning (N BLE device(s) seen: ...)`. **0 devices = the radio isn't hearing the bike**; **N devices but no match = a detection gap I can fix**.
- C6/IC8 detection also matches the CSC/FTMS service signature, so it's found even when the console doesn't advertise a name.

**The one thing that matters for the C6:** the bike only accepts one BLE connection and **stops broadcasting while connected**. So before the Pi scans: forget/disconnect the C6 from the Apple Watch and Quest (or turn their Bluetooth off), restart the service, power on the C6 and pedal a few revolutions — then watch `sudo journalctl -u gymnasticon -f` for `Autodetect matched ic8` → `bike connected`. Then pair **`GymnasticonV2`** from the Watch/Quest.

If it still doesn't connect, paste the new "N BLE device(s) seen" line and I'll take it from there.
