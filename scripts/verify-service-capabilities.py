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
SETFCAP = 1 << 31
BEGIN = "# Keep file capabilities off Node so the service's ambient caps survive exec."
END = "\n# Systemd helper:"

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
    chroot_start = source.index("on_chroot <<'CHROOT_EOF'")
    chroot_end = source.index("\nCHROOT_EOF\n", chroot_start)
    if BEGIN in source:
        start = source.index(BEGIN) + len(BEGIN)
        in_chroot = chroot_start < start < chroot_end
        end = source.find("\nWIFI_COUNTRY=" if in_chroot else END, start)
        if end < 0:
            raise ValueError("Cannot identify the end of the Node capability setup")
        return source[start:end], in_chroot
    # Also accept the previous producer so a red run exercises its real command
    # and fails on the resulting capabilities, rather than a missing boundary.
    commands = [line for line in source.splitlines()
                if line.lstrip().startswith("setcap ") and RUNTIME in line]
    if len(commands) != 1:
        raise ValueError("Cannot identify the image stage's Node capability setup")
    start = source.index(commands[0])
    return commands[0], chroot_start < start < chroot_end


class ServiceCapabilities(unittest.TestCase):
    def setUp(self):
        self.sandbox = tempfile.TemporaryDirectory(prefix="gymnasticon-service-caps.")
        self.addCleanup(self.sandbox.cleanup)
        self.root = Path(self.sandbox.name)
        self.root.chmod(0o755)  # The probe runs as the image's unprivileged user.
        self.runtime = self.root / RUNTIME.lstrip("/")
        self.runtime.parent.mkdir(parents=True)
        self.child = self.root / "ordinary-child"
        for destination in (self.runtime, self.child):
            shutil.copyfile(Path("/usr/bin/python3").resolve(), destination)
            destination.chmod(0o755)

    def run_setup(self, drop_setfcap=False, env=None):
        setup, in_chroot = capability_setup(STAGE)
        if in_chroot:
            setup = setup.replace(RUNTIME, shlex.quote(str(self.runtime)))
        # This is pi-gen's actual child capability boundary. Dropping a cap in
        # on_chroot must not affect the host that clears the runtime's metadata.
        capsh = shlex.quote(shutil.which("capsh"))
        python = shlex.quote(sys.executable)
        script = f"on_chroot() {{ {capsh} --drop=cap_setfcap -- -e; }}\n"
        script += "on_chroot <<'PI_GEN_CAPABILITY_CHECK'\n"
        script += (f"{python} -c \"s=dict(l.split(':',1) for l in "
                   "open('/proc/self/status')); "
                   f"assert not int(s['CapBnd'],16) & {SETFCAP}\"\n")
        script += "PI_GEN_CAPABILITY_CHECK\n"
        if in_chroot or drop_setfcap:
            script += "on_chroot <<'NODE_CAPABILITY_SETUP'\n" + setup + "\nNODE_CAPABILITY_SETUP\n"
        else:
            script += setup
        environment = dict(os.environ, ROOTFS_DIR=str(self.root))
        environment.update(env or {})
        return subprocess.run(["/bin/bash", "-e", "-c", script], env=environment,
                              text=True, capture_output=True, timeout=10)

    def capability_tools(self, getcap=None, setcap=None):
        directory = self.root / "tools"
        directory.mkdir(exist_ok=True)
        for name, body in (("getcap", getcap), ("setcap", setcap)):
            destination = directory / name
            if destination.exists():
                destination.unlink()
            if body is None:
                destination.symlink_to(shutil.which(name))
            elif body:
                destination.write_text("#!/bin/sh\n" + body + "\n")
                destination.chmod(0o755)
        return {"PATH": str(directory)}

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
        for _ in range(2):  # The second run must also accept a plain executable.
            result = self.run_setup()
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.run_flow()
        remaining = subprocess.check_output(["getcap", str(self.runtime)], text=True)
        self.assertEqual(remaining.strip(), "", "stale executable capabilities remain")

    def test_pi_gen_chroot_cannot_remove_stale_filecaps(self):
        subprocess.run(["setcap", "cap_net_raw+eip", str(self.runtime)], check=True)
        result = self.run_setup(drop_setfcap=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("CAP_SETFCAP", result.stderr)
        self.assertIn("cap_net_raw", subprocess.check_output(["getcap", str(self.runtime)], text=True))

    def test_setup_rejects_missing_runtime(self):
        self.runtime.unlink()
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Node runtime is missing", result.stderr)

    def test_setup_rejects_missing_tools(self):
        for name in ("getcap", "setcap"):
            with self.subTest(tool=name):
                result = self.run_setup(env=self.capability_tools(**{name: ""}))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Required capability tool is missing: " + name, result.stderr)

    def test_setup_rejects_failed_capability_reads(self):
        for status in (0, 1):
            with self.subTest(status=status):
                # getcap can print an error and still return zero (e.g. ENOENT).
                env = self.capability_tools(getcap=f'echo "read denied" >&2; exit {status}')
                result = self.run_setup(env=env)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Cannot read Node file capabilities", result.stderr)

    def test_setup_rejects_failed_or_ineffective_removal(self):
        subprocess.run(["setcap", "cap_net_raw+eip", str(self.runtime)], check=True)
        for status, message in ((1, "Cannot remove"), (0, "remain after removal")):
            with self.subTest(status=status):
                result = self.run_setup(env=self.capability_tools(setcap=f"exit {status}"))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage-file", type=Path, default=STAGE,
                        help="image stage to exercise (also supports red runs against the old stage)")
    options, unittest_args = parser.parse_known_args()
    STAGE = options.stage_file.resolve()
    if sys.platform != "linux" or os.geteuid() != 0:
        parser.error("run as root on Linux; this check needs real ambient and file capabilities")
    missing = [tool for tool in ("setpriv", "setcap", "getcap", "capsh", "bash") if not shutil.which(tool)]
    if missing:
        parser.error("missing tools: " + ", ".join(missing) + " (install util-linux and libcap2-bin)")
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines())
    if int(status["CapBnd"], 16) & (CAPS | SETFCAP) != CAPS | SETFCAP:
        parser.error("root's capability bounding set must include CAP_NET_ADMIN, CAP_NET_RAW and CAP_SETFCAP")
    if not Path("/usr/bin/python3").is_file():
        parser.error("/usr/bin/python3 is required as the temporary ELF interpreter")
    with Path("/usr/bin/python3").open("rb") as binary:
        if binary.read(4) != b"\x7fELF":
            parser.error("/usr/bin/python3 must be a native ELF executable")
    unittest.main(argv=[sys.argv[0], "-v", *unittest_args])
