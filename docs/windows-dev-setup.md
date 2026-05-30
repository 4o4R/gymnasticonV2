# Windows Development Setup

Windows is supported for source editing, tests, and bot-mode development. Raspberry Pi OS or Linux is still the recommended runtime environment for Bluetooth and ANT+ hardware testing.

## Requirements

- Windows 10 or 11.
- PowerShell running as Administrator for the setup script.
- Git for Windows.
- Visual Studio Code.
- nvm-windows.

Gymnasticon targets Node.js 14.21.3 so native dependencies remain compatible with Raspberry Pi Zero / Zero W.

## Automated Setup

From an Administrator PowerShell:

```powershell
cd path\to\gymnasticonV2
.\scripts\setup-windows-dev.ps1
```

The script installs:

- nvm-windows if it is not already present.
- Node.js 14.21.3.
- Python and Visual C++ build tools used by `node-gyp`.
- Project dependencies.

After the script finishes, verify:

```powershell
node --version
npm --version
npm test
```

Expected Node version:

```text
v14.21.3
```

## Manual Node Selection

If Node 14 is already installed through nvm-windows:

```powershell
nvm use 14.21.3
npm install
npm test
```

`npm install` runs `scripts/check-node-version.cjs` and fails fast if the active Node version is outside `>=14.21.3 <15`. Set `GYMNASTICON_ALLOW_UNSUPPORTED_NODE=1` only for deliberate compatibility testing.

## VSCode

Open VSCode from the same shell after selecting Node 14:

```powershell
nvm use 14.21.3
code .
```

Available debug configurations include:

- Bot Mode
- Auto-detect
- Run Tests

Use Bot Mode first. It simulates fixed power and cadence without requiring bike hardware.

## Native Build Failures

Native modules depend on the active Node version, Python, and Visual C++ build tools. If `npm install` fails:

1. Confirm Node 14.21.3 is active.
2. Reopen PowerShell as Administrator.
3. Install or repair Visual Studio Build Tools with the C++ workload.
4. Re-run the setup script.

Useful checks:

```powershell
node --version
npm --version
npm config get python
```

For Raspberry Pi or Linux installations, use the main installer instead of reproducing the Windows toolchain:

```bash
curl -sSL https://raw.githubusercontent.com/4o4R/gymnasticonV2/main/deploy/install.sh | bash
```

## WSL

Use WSL2 for Raspberry Pi image builds. Keep the repository inside the WSL filesystem, not under `/mnt/c`, because `pi-gen` writes many small files and the Windows filesystem bridge is slow.

- [Build a Raspberry Pi image](build-sd-image.md)
