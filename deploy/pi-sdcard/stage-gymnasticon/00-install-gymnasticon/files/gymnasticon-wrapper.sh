#!/bin/bash
# This wrapper mirrors the "gymnasticon" command that npm would normally create
# but points it at the copy of Node and the repo that live under /opt/gymnasticon.
set -euo pipefail # fail loudly so debugging from a read-only console is easier
PREFERRED_NODE="/opt/gymnasticon/node/bin/node" # bundled Node runtime shipped in the image
APP_ENTRY="/opt/gymnasticon/app/src/app/cli.js" # main CLI entry point inside the unpacked repo
if [ -x "$PREFERRED_NODE" ]; then # prefer the bundled runtime when it exists (Pi images)
  NODE_BIN="$PREFERRED_NODE" # use the pinned Node binary to avoid ABI mismatches
else
  NODE_BIN="$(command -v node)" # fall back to whatever node the platform already exposes (manual installs)
fi
if [ -z "$NODE_BIN" ]; then # bail out when no Node runtime can be resolved at all
  echo "[gymnasticon wrapper] unable to locate a node binary" >&2 # steer users toward reinstalling Node
  exit 1
fi
if [ ! -f "$APP_ENTRY" ]; then # guard against partially installed application folders
  echo "[gymnasticon wrapper] missing CLI entrypoint at $APP_ENTRY" >&2 # steer users toward rebuilding the image when files are missing
  exit 1
fi
exec "$NODE_BIN" "$APP_ENTRY" "$@" # replace the wrapper shell with the actual Node process so signals flow correctly
