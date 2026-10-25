#!/usr/bin/env python3
"""Check the real Linux capability flow without touching a system executable."""

import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest


REPO = Path(__file__).resolve().parent.parent
STAGE = REPO / "deploy/pi-sdcard/stage-gymnasticon/00-install-gymnasticon/01-run.sh"
RUNTIME = "/opt/gymnasticon/node/bin/node"
CAPS = (1 << 12) | (1 << 13)  # CAP_NET_ADMIN and CAP_NET_RAW.
BEGIN = "# Keep file capabilities off Node so the service's ambient caps survive exec."
END = "\nWIFI_COUNTRY="

# Run once with the copied, Node-equivalent interpreter, then exec an ordinary
# child ELF. This is the capability transition used by Node's hciconfig helpers.
PROBE = """
import json, os, sys
status = dict(line.split(':', 1) for line in open('/proc/self/status'))
print(json.dumps({key: status[key].strip() for key in
                 ('Uid', 'CapEff', 'CapPrm', 'CapAmb', 'NoNewPrivs')}), flush=True)
if len(sys.argv) > 1:
    os.execv(sys.argv[1], [sys.argv[1], '-I', '-c', sys.argv[2]])
"""


def capability_setup(stage):
    source = stage.read_text()
    if BEGIN in source:
        start = source.index(BEGIN) + len(BEGIN)
        end = source.find(END, start)
        if end < 0:
            raise ValueError("Cannot identify the end of the Node capability setup")
        return source[start:end]
    # Also accept the previous producer so a red run exercises its real command
    # and fails on the resulting capabilities, rather than a missing boundary.
    commands = [line for line in source.splitlines()
                if line.lstrip().startswith("setcap ") and RUNTIME in line]
    if len(commands) != 1:
        raise ValueError("Cannot identify the image stage's Node capability setup")
    return commands[0]


class ServiceCapabilities(unittest.TestCase):
    def setUp(self):
        self.sandbox = tempfile.TemporaryDirectory(prefix="gymnasticon-service-caps.")
        self.addCleanup(self.sandbox.cleanup)
        self.root = Path(self.sandbox.name)
        self.root.chmod(0o755)  # The probe runs as the image's unprivileged user.
        self.runtime = self.root / "node-equivalent"
        self.child = self.root / "ordinary-child"
        for destination in (self.runtime, self.child):
            shutil.copyfile(Path("/usr/bin/python3").resolve(), destination)
            destination.chmod(0o755)

    def run_flow(self):
        result = subprocess.run([
            "setpriv", "--reuid=1000", "--regid=1000", "--clear-groups",
            "--inh-caps=+net_admin,+net_raw", "--ambient-caps=+net_admin,+net_raw",
            "--no-new-privs", str(self.runtime), "-I", "-c", PROBE,
            str(self.child), PROBE,
        ], text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        records = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(len(records), 2, "both the runtime and its child must execute")
        for name, record in zip(("runtime", "child"), records):
            self.assertEqual(record["Uid"].split(), ["1000"] * 4)
            self.assertEqual(record["NoNewPrivs"], "1")
            for key in ("CapEff", "CapPrm", "CapAmb"):
                self.assertEqual(int(record[key], 16) & CAPS, CAPS,
                                 f"{name} lost NET_ADMIN/NET_RAW: {records}")

    def test_canonical_service_grants_both_ambient_capabilities_with_nnp(self):
        settings = dict(line.split("=", 1) for line in
                        (REPO / "deploy/gymnasticon.service").read_text().splitlines()
                        if "=" in line and not line.startswith("#"))
        self.assertEqual(set(settings["AmbientCapabilities"].split()),
                         {"CAP_NET_RAW", "CAP_NET_ADMIN"})
        self.assertEqual(settings["NoNewPrivileges"], "true")

    def test_plain_elf_preserves_capabilities_across_child_exec(self):
        self.run_flow()

    def test_image_setup_removes_stale_filecaps_and_preserves_child_capabilities(self):
        subprocess.run(["setcap", "cap_net_raw+eip", str(self.runtime)], check=True)
        setup = capability_setup(STAGE).replace(RUNTIME, shlex.quote(str(self.runtime)))
        # Only the capability block is executed, with its sole runtime
        # target redirected to our copy. The installer itself is never run.
        self.assertNotIn("/opt/", setup, "unmapped system path in capability setup")
        result = subprocess.run(["bash", "-e", "-c", setup], text=True,
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.run_flow()
        remaining = subprocess.check_output(["getcap", str(self.runtime)], text=True)
        self.assertEqual(remaining.strip(), "", "stale executable capabilities remain")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage-file", type=Path, default=STAGE,
                        help="image stage to exercise (also supports red runs against the old stage)")
    options, unittest_args = parser.parse_known_args()
    STAGE = options.stage_file.resolve()
    if sys.platform != "linux" or os.geteuid() != 0:
        parser.error("run as root on Linux; this check needs real ambient and file capabilities")
    missing = [tool for tool in ("setpriv", "setcap", "getcap", "bash") if not shutil.which(tool)]
    if missing:
        parser.error("missing tools: " + ", ".join(missing) + " (install util-linux and libcap2-bin)")
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines())
    if int(status["CapBnd"], 16) & CAPS != CAPS:
        parser.error("root's capability bounding set must include CAP_NET_ADMIN and CAP_NET_RAW")
    if not Path("/usr/bin/python3").is_file():
        parser.error("/usr/bin/python3 is required as the temporary ELF interpreter")
    with Path("/usr/bin/python3").open("rb") as binary:
        if binary.read(4) != b"\x7fELF":
            parser.error("/usr/bin/python3 must be a native ELF executable")
    unittest.main(argv=[sys.argv[0], "-v", *unittest_args])
