Quick follow-up @tmulle — **v2.0.8 is out** with the fix from my last message, and the **modern Raspberry Pi image is attached** to the [release](https://github.com/4o4R/gymnasticonV2/releases/tag/v2.0.8):

- `Gymnasticon-modern-v2.0.8.img.xz` (+ `.sha256`) — for the **Pi Zero 2 W**
- (The legacy Pi Zero/Buster image is still building; I'll attach it separately.)

**Flash `Gymnasticon-modern-v2.0.8.img.xz`, then the sequence that matters for the C6:**

1. Forget/disconnect the C6 from your **Apple Watch and Quest** (or turn their Bluetooth off for the test).
2. `sudo systemctl restart gymnasticon`
3. Power the C6 on and pedal a few revolutions.
4. `sudo journalctl -u gymnasticon -f` — you should now see `Autodetect matched ic8 (...)` then `bike connected <mac>`.
5. Scan from the Watch/Quest and pair **`GymnasticonV2`**, not the C6.

If it still doesn't connect, v2.0.8 now prints a scan-visibility line that tells us exactly what's happening:

- `No supported bike found after 30s of scanning (0 BLE device(s) seen: none)` → the radio isn't hearing the C6 (bike off, or still connected to another device).
- `No supported bike found after 30s of scanning (N BLE device(s) seen: ...)` → it hears devices but none matched — paste that list and I can close the gap.

The C6 must be *free* when the Pi scans — it only accepts one BLE connection at a time and stops broadcasting while connected.
