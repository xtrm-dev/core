"""Tests for pm_config project selection and pm_check clash detection. Run: python3 test_pm_config.py"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import pm_config  # noqa: E402


class Selection(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        (self.root / "alpha" / "sub").mkdir(parents=True)
        (self.root / "beta").mkdir()
        self.cfg = self.root / "pm.json"
        self.old_env = dict(os.environ)
        self.old_cwd = os.getcwd()
        os.environ["PM_CONFIG"] = str(self.cfg)
        for key in [k for k in os.environ if (k.startswith("PM_") or k.startswith("JIRA_")) and k != "PM_CONFIG"]:
            del os.environ[key]  # other tests in the same process may have set them

    def tearDown(self):
        os.chdir(self.old_cwd)
        os.environ.clear()
        os.environ.update(self.old_env)
        self.tmp.cleanup()

    def write(self, data):
        self.cfg.write_text(json.dumps(data))
        pm_config._RAW = None
        pm_config._CACHE = None

    def two(self):
        self.write({"defaults": {"jira_site": "https://example.atlassian.net", "lane_dir": "/shared"},
                    "projects": {"alpha": {"repo_dir": str(self.root / "alpha"), "lane_dir": "/a"},
                                 "beta": {"repo_dir": str(self.root / "beta"), "jira_site": "https://other.example"}}})

    def test_flat_config_is_one_project(self):
        self.write({"lane_dir": "/flat"})
        self.assertEqual(pm_config.get("PM_LANE_DIR"), "/flat")
        self.assertIsNone(pm_config.project())

    def test_env_choice_and_override_of_defaults(self):
        self.two()
        os.environ["PM_PROJECT"] = "beta"
        self.assertEqual(pm_config.get("JIRA_SITE"), "https://other.example")
        self.assertEqual(pm_config.get("PM_LANE_DIR"), "/shared")
        self.assertEqual(pm_config.project(), "beta")

    def test_directory_choice(self):
        self.two()
        os.chdir(self.root / "alpha" / "sub")
        self.assertEqual(pm_config.get("PM_LANE_DIR"), "/a")
        self.assertEqual(pm_config.project(), "alpha")

    def test_longest_directory_match_wins(self):
        self.write({"projects": {"outer": {"repo_dir": str(self.root)},
                                 "inner": {"repo_dir": str(self.root / "alpha")}}})
        os.chdir(self.root / "alpha" / "sub")
        self.assertEqual(pm_config.project(), "inner")

    def test_single_project_needs_no_choice(self):
        self.write({"projects": {"only": {"lane_dir": "/o"}}})
        os.chdir(self.root / "beta")
        self.assertEqual(pm_config.get("PM_LANE_DIR"), "/o")

    def test_ambiguous_stops(self):
        self.two()
        os.chdir(self.root)
        with self.assertRaises(SystemExit) as ctx:
            pm_config.get("PM_LANE_DIR")
        self.assertIn("PM_PROJECT", str(ctx.exception))

    def test_unknown_project_stops(self):
        self.two()
        os.environ["PM_PROJECT"] = "gamma"
        with self.assertRaises(SystemExit):
            pm_config.get("PM_LANE_DIR")

    def test_env_var_beats_profile(self):
        self.two()
        os.environ["PM_PROJECT"] = "alpha"
        os.environ["PM_LANE_DIR"] = "/env"
        self.assertEqual(pm_config.get("PM_LANE_DIR"), "/env")

    def test_equal_directories_stop(self):
        self.write({"projects": {"alpha": {"repo_dir": str(self.root / "alpha")},
                                 "beta": {"repo_dir": str(self.root / "alpha")}}})
        os.chdir(self.root / "alpha" / "sub")
        with self.assertRaises(SystemExit) as ctx:
            pm_config.get("PM_LANE_DIR")
        self.assertIn("same repo_dir", str(ctx.exception))

    def test_malformed_config_names_the_file(self):
        self.cfg.write_text('{"lane_dir": "/x",}')
        pm_config._RAW = pm_config._CACHE = None
        with self.assertRaises(SystemExit) as ctx:
            pm_config.get("PM_LANE_DIR")
        self.assertIn("unreadable", str(ctx.exception))

    def test_cli_get_and_project(self):
        self.two()
        env = {**os.environ, "PM_PROJECT": "alpha"}
        run = lambda *a: subprocess.run([sys.executable, str(HERE / "pm_config.py"), *a], env=env,
                                        capture_output=True, text=True)
        self.assertEqual(run("project").stdout.strip(), "alpha")
        self.assertEqual(run("get", "PM_LANE_DIR").stdout.strip(), "/a")
        self.assertEqual(run("get", "PM_MISSING_X", "dflt").stdout.strip(), "dflt")
        self.assertNotEqual(run("get", "PM_MISSING_X").returncode, 0)

    def test_pm_check_reports_clash(self):
        self.write({"projects": {"a": {"lane_dir": "/same"}, "b": {"lane_dir": "/same"}}})
        out = subprocess.run([sys.executable, str(HERE / "pm_check.py"), "--project", "a"],
                             env={**os.environ}, capture_output=True, text=True).stdout
        self.assertIn("CLASH   lane_dir", out)


class SharedPaths(unittest.TestCase):
    """One answers inbox and one bot inbox for every reader, derived from the state dirs."""

    def setUp(self):
        self.old_env = dict(os.environ)
        self.tmp = tempfile.TemporaryDirectory()
        cfg = pathlib.Path(self.tmp.name) / "pm.json"
        cfg.write_text(json.dumps({"state_dir": "/srv/state", "repo_name": "example-repo"}))
        os.environ["PM_CONFIG"] = str(cfg)
        for k in ("PM_PROJECT", "PM_STATE_DIR", "PM_STATUS_BOARD_STATE_DIR", "PM_ANSWERS_INBOX", "PM_BOT_INBOX"):
            os.environ.pop(k, None)
        pm_config._RAW = pm_config._CACHE = None

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.old_env)
        pm_config._RAW = pm_config._CACHE = None
        self.tmp.cleanup()

    def test_defaults_follow_the_state_dirs(self):
        self.assertEqual(str(pm_config.answers_inbox()), "/srv/state/status_board/answers-inbox.jsonl")
        self.assertEqual(str(pm_config.bot_inbox()), "/srv/state/xtrm-bot-watch/inbox.jsonl")
        os.environ["PM_STATUS_BOARD_STATE_DIR"] = "/srv/sb"
        self.assertEqual(str(pm_config.answers_inbox()), "/srv/sb/answers-inbox.jsonl")
        os.environ["PM_ANSWERS_INBOX"] = "/x/a.jsonl"
        self.assertEqual(str(pm_config.answers_inbox()), "/x/a.jsonl")


if __name__ == "__main__":
    unittest.main()
