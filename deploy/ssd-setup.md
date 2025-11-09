## Manual SSD Prep for Gymnasticon Image

When you clone or flash `gymnasticon-raspberrypi.img.xz` to an SSD/microSD from Windows you can pre-populate the Pi's boot partition so it already knows your Wi‑Fi SSID/password and has SSH turned on.  Here’s a simple workflow that keeps line endings (CRLF on Windows) compatible with Raspberry Pi OS and avoids needing to re-flash after first boot.

### 1. Mount the boot partition
1. Attach the flashed SD/SSD to your Windows workstation (or macOS/Linux) and mount the `boot` partition that becomes visible as a removable volume.
2. Note the drive letter (for example `E:`) so the rest of the commands can point there.

### 2. Create `wpa_supplicant.conf`
1. Create a file named `wpa_supplicant.conf` on the `boot` partition with the following contents (replace `YourSSID`/`YourPassword`, keep the indentation/spaces as shown):
   ```conf
   ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev
   update_config=1
   country=US

   network={
       ssid="YourSSID"
       psk="YourPassword"
       key_mgmt=WPA-PSK
   }
   ```
2. **Windows tip:** Some editors strip line endings to LF. After you save, open the file with Notepad and `Save As` to force CRLF line endings, or run `dos2unix` on Linux/macOS to convert back from CRLF if you forget. Pi OS expects Unix line endings, so any CRLF → LF mismatches can prevent Wi-Fi from connecting.

### 3. Enable SSH access
1. Create an empty file named `ssh` (no extension) on the same `boot` partition. Windows Explorer may append `.txt`, so use PowerShell/Command Prompt:
   ```ps1
   New-Item -Path E:\ssh -ItemType File
   ```
2. This causes Raspberry Pi OS to enable the OpenSSH server on boot.
3. Optional: to set a custom `pi` password without logging in first, create a file named `userconf` with a single line in the format `pi:<hashedpassword>` (use `hassl` or `raspi-config` on another Pi to generate this hash). Otherwise the default credentials remain `pi` / `raspberry`—change them on first boot via `passwd`.

### 4. Verify `config` files trigger on first boot
1. Make sure the files (`wpa_supplicant.conf`, `ssh`, optional `userconf`) have been saved to the boot partition before ejecting the drive.
2. Safely unmount/eject from Windows so that the files are fully written—Windows sometimes caches small files, especially when editing text.

### 5. Reduce first‑boot friction
- The installer now runs `resize2fs` automatically and disables the `resize2fs_once.service`, so you should no longer see the “Failed to start LSB: Resize the root filesystem” message on first boot.
- We also enable `tty1` autologin for the `pi` user so your SSD boots straight to the shell without waiting for a login prompt. If you prefer a different user, set `AUTOLOGIN_USER=<username>` before running the installer or adjust the override file at `/etc/systemd/system/getty@tty1.service.d/override.conf` after boot.

### 5. Troubleshooting startup LEDs and boot output
- If the green LED blinks in repeating patterns, bring the SSD back to your monitor/keyboard/HDMI and watch the boot messages; our systemd service now forwards logs to the console so you can read exactly where it failed (network, Node version guard, Bluetooth).
- Use `journalctl -u gymnasticon -b` over SSH once you have network to diagnose lingering issues.

With these pre-flight steps you can flash the SSD once and have Gymnasticon automatically connect to your network and be ready for SSH administration when the Pi first boots.
