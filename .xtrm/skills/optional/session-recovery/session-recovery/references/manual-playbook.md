# Manual playbook — reconstruct what was open WITHOUT a snapshot

Only for the case the durable snapshot never existed (writer not installed /
history emptied). This is the procedure that reconstructed the 2026-10-04
21:15Z OOM losses by hand; it is slower and error-prone — prefer the snapshot.

## 1. Pick the evidence window

Everything with an mtime between "last known good" (host up-since, last cron)
and "crash time" (container restart timestamps are a good proxy:
`docker inspect --format '{{.Name}} {{.State.StartedAt}}'`).

## 2. Claude Code sessions ("~/.claude/projects")

- Layout: one directory per cwd, `~/.claude/projects/-CWD-with-dashes/`.
- Per session: `<session-uuid>.jsonl` (transcript) + optional
  `<session-uuid>/` (subagents/tool-results tree already scoped per session).
- Which of the Jsonl rows were LIVE: last `timestamp` inside the window; a
  conversation that continued after the crash is resumed, not lost.

Parsing a transcript head — first user prompt + last timestamp (used in the
incident):

```python
import json, os, glob
for d in glob.glob(os.path.expanduser("~/.claude/projects/*/")):
    for f in glob.glob(os.path.join(d, "*.jsonl")):
        m = os.path.getmtime(f)
        if not (start <= m <= end): continue
        first_user = last_ts = None
        for ln in open(f, errors="replace"):
            o = json.loads(ln)
            ts = o.get("timestamp")
            if ts: last_ts = ts
            if first_user is None and o.get("type") == "user" and not o.get("isMeta"):
                c = o.get("message", {}).get("content", "")
                if isinstance(c, list):
                    c = " ".join(x.get("text", "") for x in c if isinstance(x, dict))
                c = str(c).strip()
                if c and not c.startswith("<"):
                    first_user = c[:280]
        print(last_ts, d, f, first_user)
```

Resume with `claude --resume <uuid>` from the project dir; `claude -c` picks
the newest transcript in cwd only.

## 3. Pi sessions ("~/.pi/agent/sessions")

- Layout: `<cwd-with-dashes>/<ISO-timestamp>_<uuid>.jsonl` — the leading
  timestamp is the session's start; sessions are grouped by absolute cwd.
- Same window filter on mtime; first user message lives in an early
  `{"type": "user"}` row with `message.content`; role/content structure
  `message.role` in pi's jsonl rows.

Note: pi sessions whose cwd is an xt worktree usually re-derive from
`xt attach <slug>`; the transcript parse is for running `pi` bare in the same
cwd when needed.

## 4. Runtime processes that were driving the agents

- `~/.claude/jobs/<8-hex>/` — daemon jobs, one dir per still-tracked session;
  mtime correlation identifies which jobs were alive at the crash.
- tmux itself leaves nothing (that is why this exists) — skip trying.

## 5. Cross-check services

The session map is one axis; check containers/OOM flags in the same window
(`/skill:sre-ops`). Names seen in the incident: mmd-questdb,
mmd-tick-ingestor-rust restart at 21:15 with `docker OOMKilled=false` but
kernel-level kill; record the caveat: without kernel logs
(`dmesg`/journalctl), OOM causality can remain UNKNOWN.
