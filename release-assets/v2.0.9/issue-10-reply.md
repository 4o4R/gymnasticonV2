v2.0.9 is out. Your logs show the scan never finished: on this Pi, noble leaves the adapter in an "unknown" state, which made the stop-scan call hang, so autodetect never completed and never printed a result. Fixed in v2.0.9.

Flash `Gymnasticon-modern-v2.0.9.img.xz`, keep the C6 unpaired from everything else, and run `sudo journalctl -u gymnasticon -f`. You'll get one of two outcomes:

- `Autodetect matched ic8 (...)` then `bike connected <mac>` — working.
- `No supported bike found after 30s of scanning (N BLE device(s) seen: ...)` — the bike isn't being seen; paste that line.

The earlier shutdown hang (`stop-sigterm timed out`) was the same root cause and is fixed too.
