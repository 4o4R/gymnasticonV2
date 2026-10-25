#!/usr/bin/env python3
"""Exercise deployment shell commands on Linux without changing the host."""

import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest


REPO = Path(__file__).resolve().parent.parent
STAGE = REPO / "deploy/pi-sdcard/stage-gymnasticon/00-apt-refresh/00-run.sh"
INSTALLER = REPO / "deploy/install.sh"
INSTALL_STAGE = REPO / "deploy/pi-sdcard/stage-gymnasticon/00-install-gymnasticon/01-run.sh"
LOCK_UNIT = REPO / "deploy/pi-sdcard/stage-gymnasticon/00-install-gymnasticon/files/lockrootfs.service"


class DeploymentChecks(unittest.TestCase):
    def setUp(self):
        self.sandbox = tempfile.TemporaryDirectory(prefix="gymnasticon-deploy-check.")
        self.addCleanup(self.sandbox.cleanup)
        self.root = Path(self.sandbox.name)
        for directory in ("bin", "etc/apt/sources.list.d", "etc/apt/apt.conf.d",
                          "etc/systemd/system", "boot/firmware"):
            (self.root / directory).mkdir(parents=True, exist_ok=True)
        self.env = dict(os.environ, PATH=str(self.root / "bin") + ":/usr/bin:/bin",
                        ROOTFS_DIR=str(self.root), DEPLOY_LOG=str(self.root / "actions"))
        self.stub("sudo", 'exec "$@"')
        self.stub("apt-get", 'echo apt-get >> "$DEPLOY_LOG"; exit "${APT_EXIT:-0}"')
        self.stub("apt-cache", 'echo apt-cache >> "$DEPLOY_LOG"')
        self.stub("raspi-config", 'echo overlay >> "$DEPLOY_LOG"; exit "${OVERLAY_EXIT:-0}"')
        self.stub("systemctl", 'echo "systemctl $*" >> "$DEPLOY_LOG"; exit "${SYSTEMCTL_EXIT:-0}"')
        self.stub("audit-reboot", 'echo reboot >> "$DEPLOY_LOG"')

    def stub(self, name, body):
        path = self.root / "bin" / name
        path.write_text("#!/bin/sh\n" + body + "\n")
        path.chmod(0o755)

    def write(self, path, text):
        (self.root / path).write_text(text)

    def release(self, codename, version):
        self.write("etc/os-release", f'NAME=Raspbian\nVERSION_CODENAME={codename}\nVERSION_ID={version}\n')

    def run_shell(self, source, shell="bash"):
        # Remap every system path before running the real script, including rm's
        # target. Commands with external effects are replaced with PATH stubs.
        source = source.replace("/etc/", str(self.root / "etc") + "/")
        source = source.replace("/boot/", str(self.root / "boot") + "/")
        source = source.replace("/sbin/reboot", "audit-reboot")
        return subprocess.run([shell, "-c", source], env=self.env,
                              text=True, capture_output=True, timeout=15)

    def run_stage(self):
        # Run both the stage and its chroot body; this substitutes only chroot's
        # process boundary, so the OS detection and transformations remain real.
        source = 'set -e\non_chroot() { bash -e; }\n' + STAGE.read_text()
        return self.run_shell(source)

    def run_installer_mirror_setup(self):
        # The remaining installer intentionally stops services and installs the
        # app. Execute its actual prerequisite functions without that entrypoint.
        source = INSTALLER.read_text().split("# Ensure we are not executing", 1)[0]
        return self.run_shell(source + "\ndetect_os_release\nmaybe_enable_legacy_apt_mirror\n")

    def run_overlay(self):
        command = next(line[len("ExecStart="):] for line in LOCK_UNIT.read_text().splitlines()
                       if line.startswith("ExecStart="))
        args = shlex.split(command)
        self.assertEqual(args[:2], ["/bin/sh", "-c"])
        return self.run_shell(args[2], shell="sh")

    def actions(self):
        path = self.root / "actions"
        return path.read_text().splitlines() if path.exists() else []

    def assert_ok(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_bookworm_stage_preserves_primary_fallback_and_extra_sources(self):
        self.release("bookworm", "12")
        main = ("deb https://raspbian.mirror.constant.com/raspbian/ bookworm main\n"
                "deb https://raspbian.raspberrypi.org/raspbian/ bookworm main\n")
        extra = "deb https://archive.raspberrypi.org/debian bookworm main\n"
        self.write("etc/apt/sources.list", main)
        self.write("etc/apt/sources.list.d/raspi.list", extra)
        self.assert_ok(self.run_stage())
        self.assertEqual((self.root / "etc/apt/sources.list").read_text(), main)
        self.assertEqual((self.root / "etc/apt/sources.list.d/raspi.list").read_text(), extra)
        self.assertFalse((self.root / "etc/apt/apt.conf.d/99legacy-repos").exists())
        self.assertIn("apt-get", self.actions())

    def test_buster_stage_repairs_old_installer_sources_and_aliases(self):
        self.release("", "10")
        hosts = ["archive.raspbian.org", "raspbian.raspberrypi.org",
                 "raspbian.raspberrypi.com", "mirrordirector.raspbian.org"]
        self.write("etc/apt/sources.list", "deb https://archive.raspbian.org/raspbian/ buster main\n")
        extra = "".join(f"deb http://{host}/raspbian/ buster main\n" for host in hosts)
        extra += "deb https://example.com/custom buster main\n"
        self.write("etc/apt/sources.list.d/old.list", extra)
        self.assert_ok(self.run_stage())
        self.assertEqual((self.root / "etc/apt/sources.list").read_text(),
                         "deb https://legacy.raspbian.org/raspbian/ buster main\n")
        expected = "deb http://legacy.raspbian.org/raspbian/ buster main\n" * len(hosts)
        self.assertEqual((self.root / "etc/apt/sources.list.d/old.list").read_text(),
                         expected + "deb https://example.com/custom buster main\n")
        self.assertTrue((self.root / "etc/apt/apt.conf.d/99legacy-repos").exists())

    def test_stage_propagates_package_refresh_failure(self):
        self.release("bookworm", "12")
        self.write("etc/apt/sources.list", "deb https://example.com/ bookworm main\n")
        self.env["APT_EXIT"] = "100"
        self.assertEqual(self.run_stage().returncode, 100)
        self.assertEqual(self.actions(), ["apt-get"])

    def test_image_install_user_and_group_reach_the_chroot_child(self):
        self.env["FIRST_USER_NAME"] = "image-user"
        self.env.pop("GYMNASTICON_USER", None)
        self.env.pop("GYMNASTICON_GROUP", None)
        setup = INSTALL_STAGE.read_text().split("# Download and extract Node.js", 1)[0]
        child = "sh -c 'printf \"%s:%s\" \"$GYMNASTICON_USER\" \"$GYMNASTICON_GROUP\"'"
        result = self.run_shell(setup + "\n" + child)
        self.assert_ok(result)
        self.assertEqual(result.stdout, "image-user:image-user")

    def test_installer_repairs_sources_left_by_previous_installer(self):
        self.release("buster", "10")
        self.write("etc/apt/sources.list", "deb https://archive.raspbian.org/raspbian/ buster main\n")
        self.write("etc/apt/sources.list.d/old.list", "deb http://mirrordirector.raspbian.org/raspbian/ buster main\n")
        self.assert_ok(self.run_installer_mirror_setup())
        self.assertEqual((self.root / "etc/apt/sources.list").read_text(),
                         "deb https://legacy.raspbian.org/raspbian/ buster main\n")
        self.assertEqual((self.root / "etc/apt/sources.list.d/old.list").read_text(),
                         "deb http://legacy.raspbian.org/raspbian/ buster main\n")

    def test_installer_preserves_bookworm_sources(self):
        self.release("bookworm", "12")
        main = "deb https://raspbian.raspberrypi.org/raspbian/ bookworm main\n"
        self.write("etc/apt/sources.list", main)
        self.assert_ok(self.run_installer_mirror_setup())
        self.assertEqual((self.root / "etc/apt/sources.list").read_text(), main)
        self.assertFalse((self.root / "etc/apt/apt.conf.d/99-gymnasticon-archive-tweaks").exists())

    def test_failed_overlay_preserves_helper_and_does_not_reboot(self):
        self.write("etc/systemd/system/lockrootfs.service", "retain for retry")
        self.env["OVERLAY_EXIT"] = "1"
        self.assertNotEqual(self.run_overlay().returncode, 0)
        self.assertTrue((self.root / "etc/systemd/system/lockrootfs.service").exists())
        self.assertEqual(self.actions(), ["overlay"])

    def test_failed_service_setup_preserves_helper_and_does_not_reboot(self):
        self.write("etc/systemd/system/lockrootfs.service", "retain for retry")
        self.env["SYSTEMCTL_EXIT"] = "1"
        self.assertNotEqual(self.run_overlay().returncode, 0)
        self.assertTrue((self.root / "etc/systemd/system/lockrootfs.service").exists())
        self.assertNotIn("reboot", self.actions())

    def test_no_read_only_flag_skips_overlay_on_both_boot_mounts(self):
        for path in ("boot/no_read_only", "boot/firmware/no_read_only"):
            with self.subTest(path=path):
                self.write(path, "")
                self.assert_ok(self.run_overlay())
                self.assertEqual(self.actions(), [])
                (self.root / path).unlink()

    def test_successful_overlay_finishes_setup_and_reboots(self):
        self.write("etc/systemd/system/lockrootfs.service", "first boot")
        self.assert_ok(self.run_overlay())
        self.assertFalse((self.root / "etc/systemd/system/lockrootfs.service").exists())
        self.assertEqual(self.actions(), ["overlay", "systemctl disable lockrootfs",
                                         "systemctl enable bootfs-ro", "reboot"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
