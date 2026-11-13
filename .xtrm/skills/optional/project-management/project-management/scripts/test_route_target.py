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

    def wt(self, name):
        return REPO + "/.xtrm/worktrees/alpha-xt-claude-" + name

    def test_single_digit_day_manager(self):
        live = [sess("thu3-manager", self.wt("thu3-manager"))]
        self.assertEqual(rt.resolve("manager", live)["address"], "alpha-xt-claude-thu3-manager")

    def test_manager_by_worktree_address(self):
        live = [sess("thu13-manager", self.wt("thu13-manager")),
                sess("EP-1-api-lead", self.wt("EP-1-api-lead"))]
        self.assertEqual(rt.resolve("manager", live)["address"], "alpha-xt-claude-thu13-manager")

    def test_manager_pattern_needs_the_day(self):
        live = [sess("x", self.wt("project-manager"))]   # a worker that merely ends in -manager
        with self.assertRaises(rt.RouteError) as ctx:
            rt.resolve("manager", live)
        self.assertEqual(ctx.exception.code, 3)

    def test_board_helper_and_history_ignored(self):
        live = [sess("alpha-xt-pi-board-helper", REPO + "/.xtrm/worktrees/alpha-xt-pi-board-helper"),
                sess("old-board-helper", REPO + "/.xtrm/worktrees/old-board-helper", state="history_only")]
        self.assertEqual(rt.resolve("board_helper", live)["address"], "alpha-xt-pi-board-helper")

    def test_other_project_does_not_count(self):
        live = [sess("thu13-manager", "/srv/projects/beta/.xtrm/worktrees/beta-xt-claude-thu13-manager",
                     repository="org/beta")]
        with self.assertRaises(rt.RouteError) as ctx:
            rt.resolve("manager", live)
        self.assertEqual(ctx.exception.code, 3)

    def test_repository_slug_counts_outside_repo_dir(self):
        live = [sess("fri14-manager", "/elsewhere/.xtrm/worktrees/alpha-xt-claude-fri14-manager", repository="org/alpha")]
        self.assertEqual(rt.resolve("manager", live)["address"], "alpha-xt-claude-fri14-manager")

    def test_two_managers_refused(self):
        live = [sess("thu13-manager", self.wt("thu13-manager")), sess("fri14-manager", self.wt("fri14-manager"))]
        with self.assertRaises(rt.RouteError) as ctx:
            rt.resolve("manager", live)
        self.assertEqual(ctx.exception.code, 4)

    def test_several_leads_are_listed_and_resolve_refuses(self):
        live = [sess("EP-1-api-lead", self.wt("EP-1-api-lead")), sess("EP-2-ui-lead", self.wt("EP-2-ui-lead")),
                sess("worker-1", self.wt("EP-1-fix-parser"))]
        self.assertEqual(sorted(rt.address(s) for s in rt.matches("lead", live)),
                         ["alpha-xt-claude-EP-1-api-lead", "alpha-xt-claude-EP-2-ui-lead"])
        with self.assertRaises(rt.RouteError) as ctx:
            rt.resolve("lead", live)
        self.assertEqual(ctx.exception.code, 4)
        self.assertIn("name the lead", str(ctx.exception))

    def test_team_groups_every_live_session(self):
        live = [sess("thu13-manager", self.wt("thu13-manager")), sess("EP-1-api-lead", self.wt("EP-1-api-lead")),
                sess("EP-2-ui-lead", self.wt("EP-2-ui-lead")),
                sess("pi", REPO + "/.xtrm/worktrees/alpha-xt-pi-board-helper"),
                sess("w", self.wt("EP-1-fix-parser")), sess("gone", self.wt("old-worker"), state="ended")]
        t = rt.team(live)
        self.assertEqual([r["address"] for r in t["manager"]], ["alpha-xt-claude-thu13-manager"])
        self.assertEqual(len(t["lead"]), 2)
        self.assertEqual([r["address"] for r in t["board_helper"]], ["alpha-xt-pi-board-helper"])
        self.assertEqual([r["address"] for r in t["other"]], ["alpha-xt-claude-EP-1-fix-parser"])

    def test_find_by_name(self):
        live = [sess("EP-1-api-lead", self.wt("EP-1-api-lead")), sess("EP-2-ui-lead", self.wt("EP-2-ui-lead"))]
        self.assertEqual(rt.find("EP-1-api-lead", live)["address"], "alpha-xt-claude-EP-1-api-lead")
        self.assertEqual(rt.find("alpha-xt-claude-EP-2-ui-lead", live)["address"], "alpha-xt-claude-EP-2-ui-lead")
        self.assertIsNone(rt.find("lead", live))      # ends-with on a whole segment, and two would match

    def test_pattern_override_from_config(self):
        os.environ["PM_ROUTE_ROLES"] = json.dumps({"manager": "*wed11-coord"})
        live = [sess("wed11-coord", self.wt("wed11-coord"))]
        self.assertEqual(rt.resolve("manager", live)["address"], "alpha-xt-claude-wed11-coord")

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
