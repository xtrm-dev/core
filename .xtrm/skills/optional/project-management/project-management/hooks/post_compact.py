#!/usr/bin/env python3
"""SessionStart(startup|compact) hook for project-management manager and lead sessions.

    python3 post_compact.py --mode startup   SessionStart matcher `startup`: role line and pointers only.
    python3 post_compact.py [--mode compact] SessionStart matcher `compact`: the post-compaction resume steps.

Stdout becomes session context. Acts only for role manager or lead (scripts/pm_role.py) and only in a session of a
configured project (pm_config: PM_PROJECT, or the cwd inside a project's repo_dir/match_dirs). No project: silent.
A config error: one warning line, then the steps without the project's issue.

Compact mode prints: role line; the bound issue (.substrate-issue; an unbound manager gets manager_issue, else
epic; an unbound lead is told to bind its own epic) with `sb issue renew --ttl-ms <claim_ttl_ms>`; goal refresh,
timers, workers, journal; the references to re-read (refread_files); a stale-checkout check against the
upstream default branch; then the text of the file in setting post_compact_extra, verbatim.
With setting post_compact_nudge true and TMUX_PANE set, it types post_compact_nudge_text into the pane after 12 s
so the session does not idle (compact mode only). Unset TMUX_PANE to run it by hand without the keystroke.

Never exits non-zero; errors go to the hook state dir (pm_hook_common.cache_dir).log.
"""
from __future__ import annotations

import os
import pathlib
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pm_hook_common as common  # noqa: E402

HOOK = "post_compact"
DEFAULT_NUDGE = "/project-management continue: follow the POST-COMPACTION RESUME steps, then your next scheduled item"
NUDGE_DELAY_S = 12


def parse_mode(argv: list[str]) -> str:
    mode = "compact"
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--mode" and i + 1 < len(argv):
            mode, i = argv[i + 1], i + 2
            continue
        if arg.startswith("--mode="):
            mode = arg.split("=", 1)[1]
        i += 1
    return mode if mode in ("startup", "compact") else "compact"


def step0(role: str, ref: str | None) -> str:
    env = os.environ.get
    return (
        "0. You are a %s. Read the references, then, based on your assigned task and who you are "
        "(SUBSTRATE_HOLDER=%s, SUBSTRATE_ISSUE_REF=%s, XTRM_DISPATCHER_NAME=%s, XTRM_SESSION_NAME=%s), apply only "
        "the layer that is yours: manager (manager.md), lead (lead.md), worker (worker.md), reviewer or board helper. "
        "Use specialists for heavy work (/using-specialists) and subagents or the advisor for critical decisions. "
        "Pointers: /using-xtrm (doctrine, continuity), /project-management (managers and leads: Substrate+Jira, "
        "launching, windows, reaping; references/handover.md for hand-offs), /using-specialists, /multiplexing."
        % (role, common.holder(), ref or "<none>", env("XTRM_DISPATCHER_NAME") or "<none>",
           env("XTRM_SESSION_NAME") or "<none>"))


def step1(role: str, ref: str | None, cwd: str, scope_ok: bool) -> str:
    h, ttl = common.holder(), common.claim_ttl_ms()
    if ref:
        # A manager's claim lives on manager_issue when the project sets one (the bound issue may be the epic, which
        # carries no claim); everyone else renews the issue bound to the worktree.
        cref = ref
        if role == "manager" and scope_ok:
            mref, source = common.manager_ref()
            if mref and source.startswith("manager_issue"):
                cref = mref
        return ("1. Work item %s: sb issue resume %s; sb journal latest %s --kind handoff; renew the claim: "
                "sb issue renew %s --holder %s --ttl-ms %d. Claim again only if renew reports the lease expired "
                "(claim-expired or no-claim): sb issue claim %s --holder %s --ttl-ms %d."
                % (ref, ref, ref, cref, h, ttl, cref, h, ttl))
    if role == "manager":
        mref, source = common.manager_ref() if scope_ok else (None, "")
        if mref:
            return ("1. No bound issue (.substrate-issue absent in %s). The manager issue from the project config, "
                    "%s, is %s: bind it (echo %s > .substrate-issue), then sb issue resume %s; sb journal latest %s "
                    "--kind handoff; sb issue renew %s --holder %s --ttl-ms %d. Claim again only if renew reports the "
                    "lease expired (claim-expired or no-claim): sb issue claim %s --holder %s --ttl-ms %d."
                    % (cwd, source, mref, mref, mref, mref, mref, h, ttl, mref, h, ttl))
        return ("1. No bound issue (.substrate-issue absent in %s), and the project config gives no manager_issue "
                "(PM_MANAGER_ISSUE) or epic (PM_EPIC). Find your issue in the latest handoff, write it as the only "
                "line of .substrate-issue here (echo <ref> > .substrate-issue), then sb issue resume <ref> and "
                "sb issue renew <ref> --holder %s --ttl-ms %d; claim again only if renew reports the lease expired: "
                "sb issue claim <ref> --holder %s --ttl-ms %d." % (cwd, h, ttl, h, ttl))
    return ("1. No bound issue (.substrate-issue absent in %s). A lead binds its own epic: find the epic ref in the "
            "handoff or with sb issue list --status in_progress, write it as the only line of .substrate-issue in "
            "this worktree (echo <epic-ref> > .substrate-issue), then sb issue resume <epic-ref> and "
            "sb issue claim <epic-ref> --holder %s --ttl-ms %d; renew it later with sb issue renew <epic-ref> "
            "--holder %s --ttl-ms %d." % (cwd, h, ttl, h, ttl))


def goal_step(cwd: str) -> str:
    gf = ""
    try:
        line = (pathlib.Path(cwd) / ".goal-file").read_text().splitlines()[0].strip()
        gf = os.path.expanduser(line)
    except (OSError, IndexError):
        pass
    if gf and os.path.isfile(gf):
        stamp = time.strftime("%m-%dT%H:%MZ", time.gmtime(os.path.getmtime(gf)))
        return ("2. GOAL REFRESH. Goal file: %s (last written %s). Compare it with the journal since then "
                "(sb journal since <ref> <seq>): tasks finished? next work clearer? If yes, rewrite it now: update the "
                "delta in its source file, rebuild (/goal-prompt, <=4000 chars incl. '/goal '), store as a handoff "
                "entry, then self-inject at idle: goal-prompt scripts/self-inject.sh --goal %s --delay 25 (run in "
                "background; types '/goal ', pastes the body, Enter twice). If the /goal is gone, re-set it the same "
                "way. If nothing changed, keep it and say so in one line." % (gf, stamp, gf))
    return ("2. GOAL REFRESH. No .goal-file here (one line: path to your goal body file; git-excluded). Find your goal "
            "in the latest handoff entry. If tasks in the last /goal are finished or the next work is clearer, rewrite "
            "it (/goal-prompt, <=4000 chars), store it as a handoff entry, write .goal-file, and self-inject at idle "
            "with goal-prompt scripts/self-inject.sh --goal <file> --delay 25 (background; '/goal ' then body, Enter "
            "twice). If the /goal is gone, re-set it the same way.")


def references_line(role: str) -> str:
    files = common.refread_files(role)
    if not files:
        return ""
    return ("REFERENCES: re-read in full now, before the next merge, launch or dispatch: %s. The action gate "
            "(hooks/action_gate.py) blocks gated actions until each one is Read in full." % ", ".join(files))


def git(cwd: str, *args, timeout=10) -> str | None:
    try:
        r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout.strip() if r.returncode == 0 else None


def stale_check(cwd: str) -> list[str]:
    """Generic: compares HEAD and the local default branch with origin's default branch after a fetch."""
    if git(cwd, "rev-parse", "--git-dir", timeout=5) is None:
        return []
    git(cwd, "fetch", "-q", "origin")
    default = (git(cwd, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD", timeout=5) or "")
    default = default[len("origin/"):] if default.startswith("origin/") else default
    if not default:
        for cand in ("main", "master"):
            if git(cwd, "rev-parse", "-q", "--verify", "origin/" + cand, timeout=5) is not None:
                default = cand
                break
    out = []
    if default:
        head = git(cwd, "rev-list", "--count", "HEAD..origin/" + default, timeout=5) or "?"
        local = git(cwd, "rev-list", "--count", "%s..origin/%s" % (default, default), timeout=5) or "?"
        out.append("STALE CHECK: HEAD is %s commits behind origin/%s; local %s is %s behind. Fetch before reading "
                   "files here; branch new work from origin/%s, never from the local branch."
                   % (head, default, default, local, default))
    if os.path.isfile(os.path.join(cwd, "DEPLOY.md")):
        out.append("DEPLOY.md exists here: read it before any deploy, migrate, rollback, job target or window plan.")
    return out


def extra_text() -> str:
    path = common.setting("PM_POST_COMPACT_EXTRA", None)
    if not path:
        return ""
    try:
        return pathlib.Path(os.path.expanduser(str(path))).read_text()
    except OSError as exc:
        common.log_error(HOOK, "extra", exc)
        return ""


def nudge(pane: str, text: str) -> None:
    script = ('sleep %d; tmux send-keys -t "$0" -l "$1"; sleep 1; tmux send-keys -t "$0" Enter; sleep 3; '
              'tmux send-keys -t "$0" Enter' % NUDGE_DELAY_S)
    subprocess.Popen(["sh", "-c", script, pane, text], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)


def run(argv: list[str], out=None) -> None:
    out = out or sys.stdout
    mode = parse_mode(argv)
    payload = common.read_payload()
    cwd = str(payload.get("cwd") or os.getcwd())
    scope, why = common.project_scope(cwd)
    if scope == "none":
        return
    role = common.role()
    if role not in common.GATED_ROLES:
        return
    lines = []
    if scope == "error":
        lines.append("PM HOOK WARNING: project config not resolved (%s); the steps below omit the project's issue."
                     % why.strip())
    ref = common.bound_ref(cwd)
    name = os.path.basename(cwd.rstrip("/")) or cwd
    now = time.strftime("%H:%MZ", time.gmtime())
    refs = references_line(role)
    if mode == "startup":
        lines += ["SESSION START (%s, %s). Read this before your first dispatch:" % (name, now), step0(role, ref)]
        if refs:
            lines.append(refs)
        out.write("\n".join(lines) + "\n")
        return
    lines += [
        "POST-COMPACTION RESUME (%s, %s). Do these in order:" % (name, now),
        step0(role, ref),
        step1(role, ref, cwd, scope == "ok"),
        goal_step(cwd),
        "3. Re-check timers: CronList (crons survive compaction), re-arm expired Monitors, systemctl --user list-timers.",
        "4. If you run workers (manager or lead): list panes (tmux list-panes -s), resume any worker that compacted and "
        "went idle (send: sb issue resume <ref>, renew the claim, report), reap workers whose issue closed (kill-pane "
        "by id).",
        "5. Journal with sb journal append <ref> --kind <k> --semantic '{\"summary\":\"...\"}' (positional text is "
        "dropped).",
    ]
    if refs:
        lines.append(refs)
    lines += stale_check(cwd)
    out.write("\n".join(lines) + "\n")
    extra = extra_text()
    if extra:
        out.write(extra if extra.endswith("\n") else extra + "\n")
    out.flush()
    pane = os.environ.get("TMUX_PANE")
    if pane and common.setting_bool("PM_POST_COMPACT_NUDGE", False):
        nudge(pane, str(common.setting("PM_POST_COMPACT_NUDGE_TEXT", DEFAULT_NUDGE)))


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    try:
        run(argv)
    except BaseException as exc:  # never break a session start on a hook bug
        common.log_error(HOOK, " ".join(argv), exc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
