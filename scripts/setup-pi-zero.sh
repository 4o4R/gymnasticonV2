#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "scripts/setup-pi-zero.sh is deprecated; running the maintained installer instead."
exec "${REPO_ROOT}/deploy/install.sh"
