"""Tests for pm_role (role file > launch role > name patterns > worker). Run: python3 test_pm_role.py"""
import json
import os
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import pm_config  # noqa: E402
import pm_role  # noqa: E402


class Role(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.old = dict(os.environ)
        for k in [k for k in os.environ if (k.startswith("PM_") or k.startswith("JIRA_"))]:
            del os.environ[k]
        os.environ["PM_CONFIG"] = str(self.root / "pm.json")
        pm_config._RAW = pm_config._CACHE = None
        self.wt = self.root / "wt"
        (self.wt / "sub").mkdir(parents=True)
        (self.wt / ".git").write_text("gitdir: x\n")

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.old)
        pm_config._RAW = pm_config._CACHE = None
        self.tmp.cleanup()

    def test_file_beats_name(self):
        pm_role.write("manager", self.wt / "sub")
        self.assertEqual((self.wt / ".pm-role").read_text().strip(), "manager")
        self.assertEqual(pm_role.resolve("whatever-lead", self.wt / "sub"), "manager")

    def test_any_name_works_with_a_file(self):
        pm_role.write("lead", self.wt)
        self.assertEqual(pm_role.resolve("MMD-4416", self.wt), "lead")

    def test_name_fallback_and_suffixes(self):
        for name, role in (("thu3-manager", "manager"), ("acme-manager", "manager"), ("thu13-manager-2", "manager"),
                           ("EP-1-api-lead", "lead"), ("old-coord", "lead"), ("acme-board-helper", "board_helper"),
                           ("EP-9-fix", "worker")):
            self.assertEqual(pm_role.resolve(name, self.root / "nowhere"), role, name)

    def test_config_names_a_legacy_manager(self):
        (self.root / "pm.json").write_text(json.dumps({"route_roles": {"manager": "*wed11-coord"}}))
        pm_config._RAW = pm_config._CACHE = None
        self.assertEqual(pm_role.resolve("wed11-coord", self.root / "nowhere"), "manager")
        self.assertEqual(pm_role.resolve("MMD-1-options-coord", self.root / "nowhere"), "lead")

    def test_invalid_file_falls_back(self):
        (self.wt / ".pm-role").write_text("captain\n")
        self.assertEqual(pm_role.resolve("x-lead", self.wt), "lead")

    def test_launch_role_needs_no_file(self):
        for launch, role in (("manager", "manager"), ("lead", "lead"), ("board-audit-runner", "board_helper")):
            self.assertEqual(pm_role.source("anything", self.wt, launch), (role, "launch"), launch)

    def test_worker_launch_keeps_a_legacy_name_role(self):
        # worker is not mapped: a coordinator launched as worker before the split keeps its name-pattern role
        self.assertEqual(pm_role.source("old-coord", self.root / "nowhere", "worker"), ("lead", "name"))
        self.assertEqual(pm_role.source("PROJ-7-fix", self.root / "nowhere", "worker"), ("worker", "default"))

    def test_file_overrides_launch_role(self):
        pm_role.write("manager", self.wt)  # a manager launched under an older role reports worker
        self.assertEqual(pm_role.source("wed11-coord", self.wt, "worker"), ("manager", "file"))

    def test_unmapped_launch_role_falls_to_name(self):
        self.assertEqual(pm_role.source("acme-lead", self.root / "nowhere", "project-manager"), ("lead", "name"))
        self.assertEqual(pm_role.source("x", self.root / "nowhere", "project-manager"), ("worker", "default"))

    def test_config_maps_a_launch_role(self):
        (self.root / "pm.json").write_text(json.dumps({"launch_roles": {"chief": "manager", "bad": "captain"}}))
        pm_config._RAW = pm_config._CACHE = None
        self.assertEqual(pm_role.by_launch("chief"), "manager")
        self.assertIsNone(pm_role.by_launch("bad"))
        self.assertEqual(pm_role.by_launch("lead"), "lead")

    def test_current_reads_the_launch_env(self):
        os.environ["CLAUDE_PROJECT_DIR"] = str(self.root / "nowhere")
        os.environ["XTMUX_AGENT_ROLE"] = "lead"
        os.environ.pop("SUBSTRATE_HOLDER", None)
        self.assertEqual(pm_role.current_source(), ("lead", "launch"))

    def test_write_rejects_unknown_role(self):
        with self.assertRaises(ValueError):
            pm_role.write("captain", self.wt)

    def test_write_excludes_the_file_from_git(self):
        import subprocess
        repo = self.root / "repo"
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        pm_role.write("lead", repo)
        self.assertIn(".pm-role", (repo / ".git" / "info" / "exclude").read_text())
        status = subprocess.run(["git", "-C", str(repo), "status", "--porcelain"], capture_output=True, text=True).stdout
        self.assertNotIn(".pm-role", status)
        pm_role.write("manager", repo)   # idempotent
        self.assertEqual((repo / ".git" / "info" / "exclude").read_text().count(".pm-role"), 1)


if __name__ == "__main__":
    unittest.main()
