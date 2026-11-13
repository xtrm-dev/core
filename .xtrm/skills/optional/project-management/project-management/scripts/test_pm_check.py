"""Tests for pm_check --hooks (wiring detection, snippet, no settings file) and the role line. Run: python3 test_pm_check.py"""
import contextlib
import io
import json
import os
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import pm_check  # noqa: E402
import pm_config  # noqa: E402


class Hooks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.old = dict(os.environ)
        for k in [k for k in os.environ if k.startswith(("PM_", "JIRA_", "SUBSTRATE_", "XTRM_", "CLAUDE_"))]:
            del os.environ[k]
        os.environ["PM_CONFIG"] = str(self.root / "pm.json")
        os.environ["CLAUDE_CONFIG_DIR"] = str(self.root / "claude")
        pm_config._RAW = pm_config._CACHE = None

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.old)
        pm_config._RAW = pm_config._CACHE = None
        self.tmp.cleanup()

    def run_hooks(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = pm_check.check_hooks()
        return code, out.getvalue()

    def test_no_settings_file_reports_all_missing(self):
        code, out = self.run_hooks()
        self.assertEqual(code, 1)
        self.assertIn("absent", out)
        self.assertEqual(out.count("MISSING hook"), len(pm_check.HOOKS))
        self.assertIn('"Stop"', out)

    def test_unreadable_settings_does_not_crash(self):
        (self.root / "claude").mkdir()
        (self.root / "claude" / "settings.json").write_text("{not json")
        code, out = self.run_hooks()
        self.assertEqual(code, 1)
        self.assertIn("UNREADABLE", out)

    def test_full_snippet_counts_as_wired_and_file_is_not_written(self):
        (self.root / "claude").mkdir()
        path = self.root / "claude" / "settings.json"
        text = json.dumps(pm_check.hooks_snippet(pm_check.HOOKS, pack="/opt/pack"))
        path.write_text(text)
        code, out = self.run_hooks()
        self.assertEqual(code, 0, out)
        self.assertIn("all 9 pack hooks wired", out)
        self.assertEqual(path.read_text(), text)

    def test_partial_wiring_and_argument_match(self):
        settings = {"hooks": {"Stop": [{"hooks": [{"type": "command",
                                                   "command": "python3 /x/hooks/operator-questions.py --event stop"}]}],
                              "UserPromptSubmit": [{"hooks": [{"type": "command",
                                                               "command": "python3 /x/hooks/operator-questions.py"}]}]}}
        wired = dict(zip([(n, e, a) for n, e, _m, a in pm_check.HOOKS], pm_check.wired_hooks(settings)))
        self.assertTrue(wired[("operator-questions.py", "Stop", "--event stop")])
        self.assertFalse(wired[("operator-questions.py", "UserPromptSubmit", "--event prompt")])
        self.assertFalse(wired[("post_compact.py", "SessionStart", "--mode compact")])

    def test_snippet_groups_by_event_and_matcher(self):
        block = pm_check.hooks_snippet(pm_check.HOOKS, pack="/p")["hooks"]
        self.assertEqual([g.get("matcher") for g in block["SessionStart"]], ["compact", "startup", None])
        self.assertEqual(len(block["UserPromptSubmit"][0]["hooks"]), 2)
        self.assertEqual(block["PreToolUse"][0]["hooks"][0]["command"],
                         "python3 /p/project-management/hooks/action_gate.py --event pre")


class RoleLine(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.wt = pathlib.Path(self.tmp.name) / "wt"
        self.wt.mkdir()
        (self.wt / ".git").write_text("gitdir: x\n")
        self.old = dict(os.environ)
        for k in [k for k in os.environ if k.startswith(("PM_", "SUBSTRATE_", "XTRM_", "CLAUDE_"))]:
            del os.environ[k]
        os.environ["PM_CONFIG"] = str(pathlib.Path(self.tmp.name) / "pm.json")
        os.environ["CLAUDE_PROJECT_DIR"] = str(self.wt)
        pm_config._RAW = pm_config._CACHE = None

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.old)
        pm_config._RAW = pm_config._CACHE = None
        self.tmp.cleanup()

    def test_sources(self):
        self.assertEqual(pm_check.role_line(), ("worker", "default"))
        os.environ["SUBSTRATE_HOLDER"] = "proj-xt-claude-api-lead"
        self.assertEqual(pm_check.role_line(), ("lead", "name"))
        (self.wt / ".pm-role").write_text("manager\n")
        self.assertEqual(pm_check.role_line(), ("manager", "file"))


if __name__ == "__main__":
    unittest.main()
