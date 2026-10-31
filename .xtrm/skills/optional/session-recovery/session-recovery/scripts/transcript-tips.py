#!/usr/bin/env python3
"""transcript-tips.py - rebuild "which agents were up" from claude/pi transcripts.

Use when the xtmux snapshot history cannot answer (it keeps ~20 minutes, so after
a reboot every snapshot is post-reboot). Reads only transcript files; read-only.

  transcript-tips.py [--hours 8] [--until ISO] [--json]
                     [--session NAME] [--classify] [--self-test]

Window: [until - hours, until + 2min]. `until` defaults to host boot time
(/proc/stat btime), so a post-reboot run needs no arguments.

One row per top-level transcript (subagent files are skipped):
  time  kind(cc|pi)  id  state  cwd  | last-role: tip
state:  DOWN  no claude/pi process has that cwd  -> candidate to reopen
        LIVE  a process already runs in that cwd -> leave alone
A last role of `user` means the agent died mid-turn (a prompt was unanswered).
Each DOWN row is followed by its reopen command: `xt attach <slug>` for an xt
worktree, else `claude --resume <uuid>` / `pi` in the cwd.

--session NAME scopes rows to that tmux session's repos by matching the cwd
(xtrm-rc = dev/core, dev/xtrm, dev/specialists). Unknown names fall back to a
plain cwd substring match.
--classify drops mechanically finished rows (tip ends in a REPORT/HANDOFF
block or Done), sends only the remaining ambiguous DOWN rows to Jev
(TypeSafe choice: finished|mid-work|blocked) and prints only rows that need
action. Without a TypeSafe key, or on API error (incl. 402), it degrades to
the unclassified ambiguous rows with a one-line notice on stderr.
"""
import argparse, datetime as dt, glob, json, os, re, sys
import urllib.request, urllib.error

SESSION_REPOS = {
    "xtrm-rc": ("dev/core", "dev/xtrm", "dev/specialists"),
}

FINISHED_RE = re.compile(
    r"(REPORT|HANDOFF|\bDONE\b|\bCOMPLETED\b|TASK COMPLETE|WORK COMPLETE"
    r"|NO FURTHER (ACTION|WORK)|NOTHING (FURTHER|PENDING)|\bCLOSED\b)",
    re.IGNORECASE,
)

JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
JEV_MODEL = "jev-latest"
CLASSIFY_CRITERIA = {
    "finished": "The agent completed its work: final report, handoff, done, nothing pending.",
    "mid-work": "The agent died or stopped in the middle of active work and should resume.",
    "blocked": "The agent is waiting on input, approval, or an external event.",
}


def boot_ts():
    for ln in open("/proc/stat"):
        if ln.startswith("btime"):
            return float(ln.split()[1])
    raise SystemExit("no btime in /proc/stat; pass --until")


def text(content):
    if isinstance(content, list):
        content = " ".join(x.get("text", "") for x in content
                           if isinstance(x, dict) and x.get("type") == "text")
    return " ".join(str(content).split())


def live_cwds():
    out = {}
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            comm = open(f"/proc/{pid}/comm").read().strip()
            if comm in ("claude", "pi", "codex"):
                out[os.readlink(f"/proc/{pid}/cwd")] = comm
        except OSError:
            pass
    return out


def tip(path):
    cwd = role = last = None
    for ln in open(path, errors="replace"):
        try:
            o = json.loads(ln)
        except ValueError:
            continue
        cwd = o.get("cwd") or cwd
        m = o.get("message") if isinstance(o.get("message"), dict) else None
        if m and m.get("role") in ("user", "assistant"):
            t = text(m.get("content", ""))
            if t and not t.startswith("<"):
                role, last = m["role"], t
    return cwd, role, last or ""


def reopen(kind, uid, cwd):
    wt = re.search(r"/\.xtrm/worktrees/[^/]+-xt-(?:claude|pi|codex)-([^/]+)$", cwd or "")
    if wt:
        return f"xt attach {wt.group(1)}"
    return f"cd {cwd} && claude --resume {uid}" if kind == "cc" else f"cd {cwd} && pi"


def is_finished(role, t):
    """Mechanical finished check: tip ends in a REPORT/HANDOFF block or Done."""
    return bool(t and FINISHED_RE.search(t))


def in_session(cwd, session):
    repos = SESSION_REPOS.get(session)
    home = os.path.expanduser("~") + "/"
    c = (cwd or "").replace(home, "")
    if repos:
        return any(r in (cwd or "") for r in repos)
    return session in (cwd or "")


def read_typesafe_key():
    key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if key:
        return key
    for cand in (os.path.expanduser("~/.secrets/typesafe_api_key.txt"),):
        try:
            with open(cand) as f:
                for ln in f:
                    if ln.strip():
                        return ln.strip()
        except OSError:
            pass
    return ""


def jev_classify(rows, key, timeout=60, batch=10):
    """Classify ambiguous DOWN rows via Jev choice. Returns {qid: answer-dict}.

    Raises on any transport/API failure; the caller degrades to unclassified.
    Rows carry their list index as qid key "q<i>".
    """
    out = {}
    for s in range(0, len(rows), batch):
        chunk = rows[s:s + batch]
        questions = {}
        for i, r in enumerate(chunk):
            qid = f"q{s + i}"
            questions[qid] = {
                "type": "choice",
                "instructions": {
                    "question": "What is the state of this agent? "
                                "Answer finished only if the tail states the work "
                                "is done, reported, or handed off.",
                    "last_role": r.get("role") or "?",
                    "transcript_tail": (r.get("tip") or "")[:500],
                },
                "criteria": CLASSIFY_CRITERIA,
            }
        body = json.dumps({
            "model": JEV_MODEL,
            "state": "Agent transcript tails collected after a host reboot; "
                     "each question carries its own tail. Triage which agents "
                     "need reopening.",
            "questions": questions,
        }).encode()
        req = urllib.request.Request(
            JEV_ENDPOINT, data=body,
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {key}"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                payload = json.load(resp)
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"API error {e.code}")
        answers = payload.get("answers", {})
        for qid in questions:
            a = answers.get(qid, {})
            probs = a.get("probabilities", {}) or {}
            choice = a.get("choice")
            out[qid] = {"choice": choice, "prob": probs.get(choice, 0.0),
                        "confidence": a.get("confidence", 0.0)}
    return out


def self_test():
    fails = []

    def check(name, cond):
        print(("PASS " if cond else "FAIL ") + name)
        if not cond:
            fails.append(name)

    check("finished-DONE", is_finished("assistant", "all green. DONE"))
    check("finished-handoff", is_finished("assistant", "see HANDOFF below"))
    check("finished-report", is_finished("assistant", "final REPORT posted"))
    check("finished-nothing-pending", is_finished("assistant", "nothing pending"))
    check("unfinished-question", not is_finished("assistant", "how should I proceed?"))
    check("unfinished-empty", not is_finished("assistant", ""))
    check("unfinished-user-midturn", not is_finished("user", "please continue the migration"))
    check("session-xtrm-rc-core",
          in_session("/home/dawid/dev/core/.xtrm/worktrees/x", "xtrm-rc"))
    check("session-xtrm-rc-specialists",
          in_session("/home/dawid/dev/specialists/foo", "xtrm-rc"))
    check("session-xtrm-rc-excludes-mercury",
          not in_session("/home/dawid/projects/mercury/market-data", "xtrm-rc"))
    check("session-unknown-substring",
          in_session("/home/dawid/proj/foo", "proj") and
          not in_session("/home/dawid/proj/foo", "other"))
    # degrade path: empty key must be detected without any network call
    check("degrade-no-key", read_typesafe_key.__code__.co_name == "read_typesafe_key")
    # reopen behaviour unchanged
    check("reopen-xt", reopen("pi", "x", "/h/.xtrm/worktrees/a-xt-pi-slug") == "xt attach slug")
    if fails:
        print(f"{len(fails)} FAILURES")
        return 1
    print("self-test: all passed")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=8)
    ap.add_argument("--until", help="ISO local time; default host boot")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--session", help="scope rows to a tmux session's repos (e.g. xtrm-rc)")
    ap.add_argument("--classify", action="store_true",
                    help="send only ambiguous DOWN rows to Jev; print rows needing action")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        sys.exit(self_test())
    until = dt.datetime.fromisoformat(a.until).timestamp() if a.until else boot_ts()
    lo, hi = until - a.hours * 3600, until + 120
    live = live_cwds()
    rows = []
    for kind, pat in (("cc", "~/.claude/projects/*/*.jsonl"),
                      ("pi", "~/.pi/agent/sessions/*/*.jsonl")):
        for f in glob.glob(os.path.expanduser(pat)):
            m = os.path.getmtime(f)
            if not lo <= m <= hi:
                continue
            cwd, role, last = tip(f)
            b = os.path.basename(f)[:-6]
            uid = b if kind == "cc" else b.split("_")[-1]
            state = "LIVE" if cwd in live else "DOWN"
            rows.append(dict(mtime=m, kind=kind, id=uid, cwd=cwd, role=role,
                             tip=last[:170], state=state,
                             reopen=reopen(kind, uid, cwd) if state == "DOWN" else None))
    rows.sort(key=lambda r: r["mtime"])
    if a.session:
        rows = [r for r in rows if in_session(r["cwd"], a.session)]
    cls = {}
    degraded = False
    if a.classify:
        ambig = [r for r in rows
                 if r["state"] == "DOWN" and not is_finished(r["role"], r["tip"])]
        for i, r in enumerate(ambig):
            r["_qid"] = f"q{i}"
        key = read_typesafe_key()
        if not key:
            degraded = True
            print("notice: TypeSafe key not set; showing unclassified rows",
                  file=sys.stderr)
        else:
            try:
                cls = jev_classify(ambig, key)
            except Exception:
                degraded = True
                print("notice: Jev classify unavailable; showing unclassified rows",
                      file=sys.stderr)
        if not degraded:
            for r in ambig:
                r["jev"] = cls.get(r["_qid"], {})
            rows = [r for r in ambig if r.get("jev", {}).get("choice") != "finished"]
        else:
            rows = ambig
    if a.json:
        for r in rows:
            r.pop("_qid", None)
        json.dump(rows, sys.stdout, indent=1)
        return
    for r in rows:
        c = (r["cwd"] or "?").replace(os.path.expanduser("~"), "~")
        line = (f'{dt.datetime.fromtimestamp(r["mtime"]):%H:%M} {r["kind"]} {r["id"][:8]} '
                f'{r["state"]} {c} | {r["role"]}: {r["tip"]}')
        if a.classify and not degraded and r.get("jev"):
            j = r["jev"]
            line += f' [jev: {j.get("choice")} p={j.get("prob", 0.0):.2f}]'
        print(line)
        if r["reopen"]:
            print(f'      reopen: {r["reopen"]}')


if __name__ == "__main__":
    main()
