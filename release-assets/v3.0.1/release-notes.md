v3.0.1 fixes recovery and deployment edges found after the v3.0 review.

- **Advertising recovery:** retries replace a stalled Bleno binding, including the first adapter. Healthy outputs keep running, and late callbacks cannot stop the replacement.
- **Pi image builds:** capability cleanup runs outside pi-gen's restricted chroot, verifies the result, and reports missing tools or failed operations explicitly.
- **Optional sensors:** cancelled scan acquisition releases state and listeners. Intentional stop cancels discovery/retry work; HR keeps discovering sensors that arrive later.
- **Regression coverage:** real pinned-library recovery probes and Linux capability checks cover the failure boundaries. Installer fixtures reject missing extraction markers before executing commands.

Includes fresh modern (Bookworm) and legacy (Buster) Pi images, the npm package, and SHA256 checksums. Node.js **14.21.3** remains required. Physical Pi boot and radio/bike pairing remain unverified.

[Changes since v3.0](https://github.com/4o4R/gymnasticonV2/compare/v3.0.0...v3.0.1)
