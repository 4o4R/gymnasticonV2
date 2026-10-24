Hey @tmulle — thanks for the detailed report, this is exactly what I needed to diagnose it. Your logs are actually healthy: the service started, the radio came up (`hciconfig` shows `hci0` **UP RUNNING**), and it is actively scanning for your bike.

**The key thing to understand:** Gymnasticon only starts advertising the `GymnasticonV2` device *after* it connects to your bike. Your log stops at `✓ Noble scan started successfully` — which means the Pi spent its scan window looking for the C6 and never found it. So your Watch/iPad see nothing because the bridge hasn't reached the "advertise" phase yet.

**Most likely cause:** the Bowflex C6 supports only one BLE connection at a time and, like most bikes, **stops broadcasting while (or shortly after) a device is connected to it**. In your earlier message you mentioned hooking the C6 up to your Watch under Medical Devices. If the Watch or the Quest was connected (or had recently connected) to the C6, it quietly stops advertising — and the Pi can't discover it.

**Try this sequence:**

1. On the Apple Watch and Quest, **forget/disconnect the C6** (or turn their Bluetooth off for the test).
2. Restart the service: `sudo systemctl restart gymnasticon`
3. Power the C6 on and pedal a few revolutions so it broadcasts.
4. Watch the log: `sudo journalctl -u gymnasticon -f`
   - You should see `Autodetect matched ic8 (...)` and then `bike connected <mac>`.
5. Now scan for Bluetooth from your Watch/Quest and pair **`GymnasticonV2`** — not the C6.

Small note on the logs: `journalctl -u gynmasticon` (typo in the service name) returns "No entries" — the unit is spelled `gymnasticon`.

I just shipped **[v2.0.8](https://github.com/4o4R/gymnasticonV2/releases/tag/v2.0.8)**, which makes this much easier to diagnose. If it still doesn't connect, the new log line tells us exactly which case you're in:

- `No supported bike found after 30s of scanning (0 BLE device(s) seen: none)` → the Pi isn't hearing *any* advertisements — bike off, or still connected to another device.
- `No supported bike found after 30s of scanning (N BLE device(s) seen: ...)` → the radio hears devices, but none matched a supported profile — a detection gap I can fix. Share the names it lists.

v2.0.8 also detects the C6/IC8 by its CSC/FTMS service signature even when the console doesn't advertise a readable name. Please flash it and share what the new log line says — that tells us whether this is the "bike is connected elsewhere" case or a genuine detection gap.
