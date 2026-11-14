"""Tests for pm_session (session kit and common goal). Run: python3 test_pm_session.py"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import pm_config  # noqa: E402
import pm_session  # noqa: E402

PRD = """# Product definition

The product is one server that answers questions about markets. This file states what it must do.

## Section
- detail
"""


class Kit(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.old = dict(os.environ)
        for k in [k for k in os.environ if k.startswith(("PM_", "JIRA_", "SUBSTRATE_", "XTMUX_"))]:
            del os.environ[k]
        os.environ["PM_SB_BIN"] = "/nonexistent/sb"
        self.repo = self.root / "repo"
        (self.repo / "docs").mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        (self.repo / "docs" / "PRD.md").write_text(PRD)
        self.write_config({"repo_dir": str(self.repo), "goal_doc": "docs/PRD.md", "epic": "SB-1",
                           "jira_epic": "PROJ-9", "goal_refs": ["https://example.com/roadmap"]})

    def write_config(self, data):
        (self.root / "pm.json").write_text(json.dumps(data))
        os.environ["PM_CONFIG"] = str(self.root / "pm.json")
        pm_config._RAW = pm_config._CACHE = None

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.old)
        pm_config._RAW = pm_config._CACHE = None
        self.tmp.cleanup()

    def test_goal_points_at_every_source(self):
        text = "\n".join(pm_session.goal_lines())
        self.assertIn("COMMON GOAL", text)
        self.assertIn(str(self.repo / "docs" / "PRD.md"), text)
        self.assertIn("one server that answers questions about markets", text)
        self.assertIn("Substrate epic: SB-1", text)
        self.assertIn("Jira epic: PROJ-9", text)
        self.assertIn("also: https://example.com/roadmap", text)

    def test_missing_goal_document_is_named(self):
        self.write_config({"repo_dir": str(self.repo), "goal_doc": "docs/GONE.md"})
        self.assertIn("MISSING", "\n".join(pm_session.goal_lines()))

    def test_no_goal_configured_says_who_sets_it(self):
        self.write_config({"repo_dir": str(self.repo)})
        self.assertIn("none configured", pm_session.goal_lines()[0])

    def test_statement_skips_title_and_stops_at_blank(self):
        self.assertEqual(pm_session.statement(self.repo / "docs" / "PRD.md"),
                         "The product is one server that answers questions about markets. "
                         "This file states what it must do.")

    def test_init_writes_issue_and_excludes_both_files(self):
        out = pm_session.init("lead", "SB-7", self.repo)
        self.assertEqual((self.repo / ".substrate-issue").read_text().strip(), "SB-7")
        self.assertEqual((self.repo / ".pm-role").read_text().strip(), "lead")
        exclude = (self.repo / ".git" / "info" / "exclude").read_text().split()
        self.assertIn(".pm-role", exclude)
        self.assertIn(".substrate-issue", exclude)
        self.assertEqual(len(out), 2)

    def test_init_skips_the_role_file_when_the_launch_gives_it(self):
        os.environ["XTMUX_AGENT_ROLE"] = "lead"
        out = pm_session.init("lead", None, self.repo)
        self.assertFalse((self.repo / ".pm-role").exists())
        self.assertIn("comes from the launch", out[0])

    def test_kit_reports_launch_role_and_warns_without_issue(self):
        os.environ["XTMUX_AGENT_ROLE"] = "manager"
        lines = pm_session.kit(self.repo)
        self.assertEqual(lines[0], "role: manager (from launch, launched as manager)")
        self.assertTrue(any(line.startswith("KIT: no bound issue") for line in lines))

    def test_kit_complete_with_issue_env(self):
        os.environ["XTMUX_AGENT_ROLE"] = "worker"
        os.environ["SUBSTRATE_ISSUE_REF"] = "SB-7"
        self.assertIn("kit: complete", pm_session.kit(self.repo))


if __name__ == "__main__":
    unittest.main()
