"""Tests for route_target role resolution (no agent host needed). Run: python3 test_route_target.py"""
import json
import os
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import pm_config  # noqa: E402
import route_target as rt  # noqa: E402

REPO = "/srv/projects/alpha"


def sess(name, cwd, state="working", repository=None):
    return {"name": name, "cwd": cwd, "state": state, "repository": repository, "sessionId": name + "-id",
            "tmux": {"paneId": "%1"}}


class Resolve(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = dict(os.environ)
        cfg = pathlib.Path(self.tmp.name) / "pm.json"
        cfg.write_text(json.dumps({"repo_dir": REPO, "repo_slug": "org/alpha"}))
        os.environ["PM_CONFIG"] = str(cfg)
        for k in ("PM_PROJECT", "PM_ROUTE_ROLES", "PM_REPO_DIR", "PM_REPO_SLUG"):
            os.environ.pop(k, None)
        pm_config._RAW = pm_config._CACHE = None

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.old)
        pm_config._RAW = pm_config._CACHE = None
        self.tmp.cleanup()

    def test_lead_by_worktree_address(self):
        live = [sess("thu13-lead-coord", REPO + "/.xtrm/worktrees/alpha-xt-claude-thu13-lead-coord"),
                sess("MMD-1-options-coord", REPO + "/.xtrm/worktrees/alpha-xt-claude-MMD-1-options-coord")]
        t = rt.resolve("lead", live)
        self.assertEqual(t["address"], "alpha-xt-claude-thu13-lead-coord")

    def test_board_helper_and_history_ignored(self):
        live = [sess("alpha-xt-pi-board-helper", REPO + "/.xtrm/worktrees/alpha-xt-pi-board-helper"),
                sess("old-board-helper", REPO + "/.xtrm/worktrees/old-board-helper", state="history_only")]
        self.assertEqual(rt.resolve("board_helper", live)["address"], "alpha-xt-pi-board-helper")

    def test_other_project_does_not_count(self):
        live = [sess("x-lead-coord", "/srv/projects/beta/.xtrm/worktrees/beta-xt-claude-x-lead-coord",
                     repository="org/beta")]
        with self.assertRaises(rt.RouteError) as ctx:
            rt.resolve("lead", live)
        self.assertEqual(ctx.exception.code, 3)

    def test_repository_slug_counts_outside_repo_dir(self):
        live = [sess("y-lead-coord", "/elsewhere/.xtrm/worktrees/alpha-xt-claude-y-lead-coord", repository="org/alpha")]
        self.assertEqual(rt.resolve("lead", live)["address"], "alpha-xt-claude-y-lead-coord")

    def test_two_leads_refused(self):
        live = [sess("a-lead-coord", REPO + "/.xtrm/worktrees/alpha-xt-claude-a-lead-coord"),
                sess("b-lead-coord", REPO + "/.xtrm/worktrees/alpha-xt-claude-b-lead-coord")]
        with self.assertRaises(rt.RouteError) as ctx:
            rt.resolve("lead", live)
        self.assertEqual(ctx.exception.code, 4)

    def test_pattern_override_from_config(self):
        os.environ["PM_ROUTE_ROLES"] = json.dumps({"lead": "*wed11-coord"})
        live = [sess("wed11-coord", REPO + "/.xtrm/worktrees/alpha-xt-claude-wed11-coord")]
        self.assertEqual(rt.resolve("lead", live)["address"], "alpha-xt-claude-wed11-coord")

    def test_unknown_role(self):
        with self.assertRaises(rt.RouteError) as ctx:
            rt.resolve("nobody", [])
        self.assertEqual(ctx.exception.code, 2)

    def test_host_unreachable(self):
        os.environ["XTRM_AGENT_HOST_URL"] = "http://127.0.0.1:9"
        with self.assertRaises(rt.RouteError) as ctx:
            rt.sessions()
        self.assertEqual(ctx.exception.code, 5)


if __name__ == "__main__":
    unittest.main()
