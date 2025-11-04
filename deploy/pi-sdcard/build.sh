#!/bin/bash -e

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to build the Raspberry Pi image. Please install Docker Desktop (with WSL2 integration) or the Linux docker engine before rerunning build.sh."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not running. Start Docker (e.g. launch Docker Desktop or run 'sudo service docker start') and try again."
  exit 1
fi

if [ -d "pi-gen" ]; then
  echo "Removing previous pi-gen workspace..." # ensure stale clones don't break new builds
  rm -rf pi-gen # wipe the old pi-gen tree so the clone below starts clean
fi

git clone https://github.com/RPi-Distro/pi-gen
cd pi-gen
git fetch
git fetch --tags
git checkout 2020-02-13-raspbian-buster
python3 - <<'PY' # rewrite the Dockerfile so apt pulls from the Debian archive mirrors and ignores expired Release metadata
from pathlib import Path # use pathlib for concise file IO

dockerfile = Path('Dockerfile') # reference the pi-gen Dockerfile we just checked out
original = dockerfile.read_text() # capture the current file contents
needle = "RUN apt-get -y update && \\\n" # locate the original apt-get command that needs augmentation
replacement = ( # build the new RUN command that rewrites sources.list and disables validity checks before updating
    "RUN sed -i 's|deb.debian.org|archive.debian.org|g' /etc/apt/sources.list && \\\n"
    "    sed -i 's|security.debian.org|archive.debian.org|g' /etc/apt/sources.list && \\\n"
    "    echo 'Acquire::Check-Valid-Until \"false\";' > /etc/apt/apt.conf.d/99no-check-valid-until && \\\n"
    "    apt-get -o Acquire::Check-Valid-Until=false -y update && \\\n"
)
if needle not in original: # bail out early if the Dockerfile structure changes unexpectedly
    raise SystemExit('Expected apt-get stanza not found in Dockerfile')
dockerfile.write_text(original.replace(needle, replacement, 1)) # write the patched Dockerfile back to disk

mirror = "http://legacy.raspbian.org/raspbian/" # canonical archive mirror for oldstable Raspberry Pi OS packages
for path in (Path("stage0/prerun.sh"), Path("stage0/00-configure-apt/files/sources.list")):
    text = path.read_text()
    if "http://raspbian.raspberrypi.org/raspbian/" not in text:
        continue # allow future pi-gen revisions that may already point to the legacy mirror
    path.write_text(text.replace("http://raspbian.raspberrypi.org/raspbian/", mirror))

PY
cp ../config config
cp -a ../stage-gymnasticon stage-gymnasticon
sed -i 's/\r$//' config # strip potential CRLF endings introduced by Windows checkouts so pi-gen parses the config
touch stage2/SKIP_IMAGES
./build-docker.sh
