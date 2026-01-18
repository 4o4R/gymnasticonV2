# Quick Fix: hcitool Scan Failure (Input/output error)

## Problem
```
Set scan parameters failed: Input/output error
Error: hcitool scan ended without finding device
```

When noble scan fails and tries to fall back to hcitool, hcitool also fails with "Input/output error".

## Root Cause
When noble tries to use hci0 and fails, it doesn't properly clean up/reset the adapter state. When hcitool then tries to use the same adapter, it finds it in a conflicted state and can't set scan parameters.

## Solution
Reset the adapter before attempting hcitool scan:

```bash
sudo hciconfig hci0 reset
```

This clears any stuck state left by noble.

## What Changed
**File**: `src/util/ble-scan.js`

Added adapter reset in `scanWithHcitool()`:
```javascript
// Reset adapter before scanning to clear any stuck state from noble
const resetCmd = `${sudoPrefix}hciconfig ${adapter} reset`;
try {
  execSync(resetCmd, { stdio: 'ignore', timeout: 2000 });
} catch (e) {
  console.log(`[ble-scan] ⚠ Adapter reset failed: ${e.message}`);
}
```

This ensures the adapter is clean before hcitool tries to scan.

## Deploy This Fix

```bash
cd /opt/gymnasticon
git pull origin main
npm install --omit=dev
timeout 30 node src/app/cli.js --bike=keiser 2>&1
```

Then pedal the bike immediately when you see the scan start.

