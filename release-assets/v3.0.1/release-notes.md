v3.0.1 fixes recovery and deployment edges found after the v3.0 review.

- **Advertising recovery:** retries replace a stalled Bleno binding, including the first adapter. Healthy outputs keep running, and late callbacks cannot stop the replacement.
- **Pi image builds:** capability cleanup runs outside pi-gen's restricted chroot, verifies the result, and reports missing tools or failed operations explicitly.
- **Optional sensors:** cancelled scans release state and listeners. Shutdown cancels discovery/retries and closes late connections without disrupting a newer sensor. HR keeps discovering sensors that arrive later and retries failures instead of switching itself off.
- **Pauses and returns:** a telemetry gap reports zero without dropping the app or watch, and the bike is reconnected after 60 seconds. Bike discovery hands its match straight to the client, Keiser keeps the shared scan while accessories come and go, and power smoothing no longer replays the previous ride.
- **Setup:** Wi-Fi credentials are read literally, re-running the installer keeps the existing checkout and configuration, and modern images can enable the overlay without network access.
- **Boot and hotplug:** startup no longer waits for the network, a USB Bluetooth adapter that enumerates late is promoted to the advertising radio, a failed output is rebuilt mid-ride, and a stray promise rejection no longer restarts the service and drops the watch.
- **Regression coverage:** real pinned-library recovery probes and Linux capability checks cover the failure boundaries. Installer fixtures reject missing extraction markers before executing commands.

Includes fresh modern (Bookworm) and legacy (Buster) Pi images, the npm package, and SHA256 checksums. Node.js **14.21.3** remains required. Physical Pi boot and radio/bike pairing remain unverified.

[Changes since v3.0](https://github.com/4o4R/gymnasticonV2/compare/v3.0.0...v3.0.1)
