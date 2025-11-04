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

# The legacy Buster packages now live on archive.raspbian.org; force pi-gen to use it explicitly
mirror = "http://archive.raspbian.org/raspbian/"
Path("stage0/prerun.sh").write_text(
    '#!/bin/bash -e\n\n'
    'if [ ! -d "${ROOTFS_DIR}" ]; then\n'
    f'\tbootstrap buster "${{ROOTFS_DIR}}" {mirror}\n'
    'fi\n'
)
sources_list = (
    f"deb {mirror} buster main contrib non-free rpi\n"
    f"#deb-src {mirror} buster main contrib non-free rpi\n"
)
Path("stage0/00-configure-apt/files/sources.list").write_text(sources_list)

# Add the APT config tweaks in stage0's prerun so they're present before any package operations
prerun = Path("stage0/prerun.sh")
if "99archive-tweaks" not in prerun.read_text():
    prerun.write_text(
        prerun.read_text()
        + "\nmkdir -p \"${ROOTFS_DIR}/etc/apt/apt.conf.d\"\n"
          "cat >\"${ROOTFS_DIR}/etc/apt/apt.conf.d/99archive-tweaks\" <<'APTCONF'\n"
          "Acquire::Check-Valid-Until \"false\";\n"
          "Acquire::Retries \"5\";\n"
          "Acquire::http::Pipeline-Depth \"0\";\n"
          "Acquire::AllowReleaseInfoChange::Suite \"1\";\n"
          "Acquire::AllowReleaseInfoChange::Codename \"1\";\n"
          "Acquire::AllowReleaseInfoChange::Version \"1\";\n"
          "APTCONF\n"
    )

# Add apt-get update helpers to stage1 and stage2 without overwriting existing prerun.sh
for stage in ("stage1", "stage2"):
    update_dir = Path(stage) / "00-apt-update"
    update_dir.mkdir(parents=True, exist_ok=True)
    run_sh = update_dir / "00-run.sh"
    
    lines = [
        "#!/bin/bash -e",
        "",
        "on_chroot <<'EOF'",
        "set -e",
        "apt-get -o Acquire::Check-Valid-Until=false \\",
        "        -o Acquire::AllowReleaseInfoChange::Suite=true \\",
        "        -o Acquire::AllowReleaseInfoChange::Codename=true \\",
        "        -o Acquire::AllowReleaseInfoChange::Version=true \\",
        "        update",
    ]
    
    if stage == "stage2":
        lines.extend([
            "if ! apt-cache show wpasupplicant >/dev/null 2>&1; then",
            "  echo 'wpasupplicant not found after apt-get update' >&2",
            "  cat /etc/apt/sources.list >&2",
            "  ls -R /etc/apt/sources.list.d >&2 || true",
            "  exit 1",
            "fi",
            "if ! apt-cache show wireless-tools >/dev/null 2>&1; then",
            "  echo 'wireless-tools not found after apt-get update' >&2",
            "  cat /etc/apt/sources.list >&2",
            "  ls -R /etc/apt/sources.list.d >&2 || true",
            "  exit 1",
            "fi",
        ])
    
    lines.append("EOF")
    lines.append("")
    run_sh.write_text("\n".join(lines))
    run_sh.chmod(0o755)

# Also add the apt-get update directly into stage2/02-net-tweaks to ensure it runs
net_tweaks_update = Path("stage2/02-net-tweaks/00-apt-update")
net_tweaks_update.mkdir(parents=True, exist_ok=True)
net_tweaks_run = net_tweaks_update / "00-run.sh"
net_tweaks_run.write_text(
    "#!/bin/bash -e\n"
    "\n"
    "on_chroot <<'EOF'\n"
    "set -e\n"
    "echo '=== Updating apt package cache in 02-net-tweaks ==='\n"
    "apt-get -o Acquire::Check-Valid-Until=false \\\n"
    "        -o Acquire::AllowReleaseInfoChange::Suite=true \\\n"
    "        -o Acquire::AllowReleaseInfoChange::Codename=true \\\n"
    "        -o Acquire::AllowReleaseInfoChange::Version=true \\\n"
    "        update\n"
    "echo '=== Checking for wpasupplicant ==='\n"
    "if ! apt-cache show wpasupplicant >/dev/null 2>&1; then\n"
    "  echo 'ERROR: wpasupplicant not found after apt-get update' >&2\n"
    "  echo '=== Contents of /etc/apt/sources.list ===' >&2\n"
    "  cat /etc/apt/sources.list >&2\n"
    "  echo '=== Contents of /etc/apt/sources.list.d/ ===' >&2\n"
    "  ls -la /etc/apt/sources.list.d/ >&2 || true\n"
    "  exit 1\n"
    "fi\n"
    "echo 'wpasupplicant found in package cache'\n"
    "EOF\n"
)
net_tweaks_run.chmod(0o755)

PY
cp ../config config
cp -a ../stage-gymnasticon stage-gymnasticon
sed -i 's/\r$//' config # strip potential CRLF endings introduced by Windows checkouts so pi-gen parses the config
touch stage2/SKIP_IMAGES
./build-docker.sh