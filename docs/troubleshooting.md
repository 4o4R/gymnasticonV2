# Troubleshooting: Native build (gyp) and VSCode debugging issues

This page collects concrete steps and explanations for two common problems you're seeing:

1. The Python/gyp error ("invalid mode: 'rU' while trying to load binding.gyp") when npm/node-gyp tries to build native modules.
2. VSCode launching the wrong Node binary (debug terminal using the Node in Program Files instead of the nvm-managed Node 14).

---

## 1) The `rU` / gyp / node-gyp error (why it happens)

Symptoms seen in your log:

- A Python traceback ending with `ValueError: invalid mode: 'rU' while trying to load binding.gyp`
- `gyp ERR! configure error` and `node-gyp` failing during `npm install`

Why this happens:

- The gyp codebase historically used the file open mode `"rU"` (universal newline mode). That was supported in Python 2 but removed/unsupported in some Python 3 versions. If `node-gyp` is executed with Python 3 that doesn't accept `rU`, the script fails while trying to read binding.gyp.
- Many old native build toolchains (and some older `node-gyp` versions) expect Python 2.7.
- Some npm packages bundle/expect specific `node-gyp` versions; npm itself may invoke its bundled `node-gyp`.

How to fix (Windows, step-by-step):

1. Install Python 2.7 (if not already installed). The setup script attempts this; if it failed, install manually:

```powershell
# Download and run the MSI (run as Admin)
$msi = "$env:TEMP\python-2.7.18.amd64.msi"
Invoke-WebRequest -Uri "https://www.python.org/ftp/python/2.7.18/python-2.7.18.amd64.msi" -OutFile $msi
Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /quiet /norestart ADDLOCAL=ALL" -Wait
```

2. Point npm/node-gyp to the Python 2.7 binary (temporary for the session):

```powershell
# For the current PowerShell session
$env:npm_config_python = 'C:\Python27\python.exe'

# Persist across sessions
npm config set python "C:\Python27\python.exe"
```

3. Ensure a compatible node-gyp is available. For Node 14 it's safest to use node-gyp v6.x or v7.x. Install it globally:

```powershell
npm install -g node-gyp@6.1.0
```

4. Tell npm to use the global node-gyp (optional, but avoids some npm-bundled node-gyp mismatches):

```powershell
# Replace the path below if your global node-gyp is installed elsewhere
$globalNodeGyp = (Get-Command node-gyp).Source
npm config set node_gyp $globalNodeGyp
# Or set the env var for the session:
$env:npm_config_node_gyp = $globalNodeGyp
```

5. Clean and reinstall dependencies with verbose logs so you can inspect failures:

```powershell
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
Remove-Item package-lock.json -ErrorAction SilentlyContinue
npm install --verbose 2>&1 | Tee-Object npm-install.log
```

6. If you still see `rU` errors, confirm the Python binary used by node-gyp is actually Python 2.7:

```powershell
# This prints the Python version node-gyp will use
& $env:npm_config_python --version
# If that prints a Python 3.x, update npm config to the correct python path
```

Notes and alternatives:

- Upgrading `node-gyp` / `gyp` to versions that work with Python 3 is possible, but it depends on dependent packages and prebuild availability. On Windows, the simplest cross-compatible path is to install Python 2.7 and use a node-gyp v6.x.
- For Windows, Visual C++ Build Tools are also required. The setup script installs those. If the automatic installer fails, manual installation from Microsoft is a fallback.

---

## 2) VSCode launching the wrong Node binary for debugging

Symptoms seen:

- VSCode debug output shows `C:\Program Files\nodejs\node.exe` being used rather than the nvm-managed Node 14 installed under `%APPDATA%\nvm\v14.x.x`.

Cause:

- VSCode debug uses either the system `node` in PATH or a configured `runtimeExecutable`. Because you have multiple Node versions installed (Program Files vs nvm), the Program Files node was being picked up.

Fixes applied and recommended steps:

1. The workspace `.vscode/launch.json` has been updated so the Bot Mode debug configuration uses the nvm-managed Node binary explicitly:

```jsonc
"runtimeExecutable": "C:/Users/James/AppData/Roaming/nvm/v14.21.3/node.exe"
```

If your nvm-windows version or Node 14 patch version differs, change that path accordingly.

2. If you prefer not to hard-code the absolute path, you can instead ensure the desired node is first in your PATH before launching VSCode. For example in PowerShell:

```powershell
nvm use 14.21.3
# then start code from this shell so VSCode inherits the PATH
code .
```

3. Close and reopen VSCode after switching Node versions with `nvm use` so the debug adapter picks up the correct node.

4. The debug config also sets `npm_config_python` for the debug session so native builds and npm calls inside debug will resolve the Python path if set.

---

## Quick checklist for you to run now

1. In an elevated PowerShell (Administrator) run these commands:

```powershell
# Ensure node 14 is selected
nvm use 14.21.3

# Ensure Python 2.7 is set for npm/node-gyp
npm config set python "C:\Python27\python.exe"
# (optional) point npm to the global node-gyp if installed
$globalNodeGyp = (Get-Command node-gyp).Source
npm config set node_gyp $globalNodeGyp

# Clean and reinstall deps with a log
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
Remove-Item package-lock.json -ErrorAction SilentlyContinue
npm install --verbose 2>&1 | Tee-Object npm-install.log
```

2. Inspect `npm-install.log` for the first failing native module and paste the last ~200 lines here if it still fails.

3. Start VSCode from the same shell where you ran `nvm use 14.21.3` (this helps ensure PATH is consistent):

```powershell
code .
```

4. Run the `Debug Gymnasticon (Bot Mode)` launch configuration (F5).

---

## USB Bluetooth dongle firmware (Kinivo BTD-400 / BCM20702A1)

Some USB Bluetooth adapters (Kinivo BTD-400, Plugable BT-USB4LE, etc.) use Broadcom's BCM20702A1 radio. Linux requires a small firmware patch file before it creates `hci1`. If the file is missing you will see boot logs similar to:

```
Bluetooth: hci1: BCM: firmware Patch file not found, tried: brcm/BCM20702A1-0a5c-21e8.hcd
```

Gymnasticon bundles that patch so even offline installs have it:

- `deploy/firmware/brcm/BCM20702A1-0a5c-21e8.hcd` is baked into the SD image and copied during the one-line installer (`/lib/firmware/brcm/...` on the Pi).
- On boot the kernel loads it automatically and the adapter appears as `hci1` when you run `hciconfig -a`.

**If you still do not see `hci1`:**

1. `lsusb` should list the dongle (e.g., `0a5c:21e8 Broadcom Corp.`). If it is missing, the hub/OTG cable is not providing power/data.
2. `sudo dmesg | grep -i hci1` should no longer show the “Patch file not found” error. If it does, verify the firmware file exists at `/lib/firmware/brcm/`.
3. After the firmware loads run `sudo hciconfig -a`; you should now see both `hci0` (onboard) and `hci1` (USB). Gymnasticon will automatically dedicate one adapter to heart-rate scanning once both are present.
