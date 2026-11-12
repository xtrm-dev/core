#!/usr/bin/env python3
"""Lane wrapper around the shared post-guard tool.

The guard itself lives in the project-management skill so that every project that uses jira.py has one
write path (coordinator ruling 2026-11-02: the B396 refusal blocked feedor, econ and infra coordinators, whose
guard existed only in this lane's cache). This wrapper adds nothing but this lane's state paths, so existing
callers keep the same command: post-guard.py <key> <file> --run <WORD> [...].

Prefer passing --run on every call; the run-file is a record, never an input.
"""
import os
import sys

import lanecfg

LANE = lanecfg.lane()
SHARED = str(lanecfg.pm_config.skill_dir("project-management") / "scripts" / "post-guard.py")

os.environ.setdefault("POST_GUARD_OWN_WRITES", os.path.join(LANE, "own-writes.txt"))
os.environ.setdefault("POST_GUARD_RUN_FILE", os.path.join(LANE, "last-run.txt"))
os.environ.setdefault("SUBSTRATE_HOLDER", lanecfg.get("PM_LANE_HOLDER", "board-lane"))

os.execv(sys.executable, [sys.executable, SHARED] + sys.argv[1:])
