#!/usr/bin/env python3
"""Deployed-image SHA snapshot, 15-minute cadence, read-only.

Prints one `DEPLOY-CHANGE <container> <old>-><new>` line per container whose running SHA moved since
the previous snapshot, and `DEPLOY-NOW-AUDIT` once if anything moved (the Waiting Production
population is a function of the running SHAs, so any move invalidates the last audit).

`make deploy-status` is the authority (AGENTS.md): the image tag or, for a registry digest, the export
directory name under .deploy/exports/<sha>. Never origin/stable - that was the cycle.py defect this
lane inherited (12 of 16 merge commits were on stable, 1 was in the image).
"""
import json
import os
import re
import subprocess
import sys

import lanecfg

REPO = lanecfg.repo()
LANE = lanecfg.lane()
SNAP = f"{LANE}/deploy-snapshot.json"
LINE = re.compile(r"^([a-z0-9-]+): image=(\S+) started=(\S+)")
EXPORT = re.compile(r"\.deploy/exports/([0-9a-f]{12})")


def snapshot():
    p = subprocess.run(["make", "deploy-status"], cwd=REPO, capture_output=True, text=True, timeout=180)
    if p.returncode != 0:
        print(f"DEPLOY-STATUS-FAIL rc={p.returncode} {p.stderr.strip()[:300]}")
        return None
    out = {}
    for line in p.stdout.splitlines():
        m = LINE.match(line)
        if not m:
            continue
        name, image, started = m.groups()
        tag = image.split(":")[-1]
        sha = tag if re.fullmatch(r"[0-9a-f]{12}", tag) else None
        if sha is None:
            ex = EXPORT.search(line)
            sha = ex.group(1) if ex else "unknown"
        out[name] = {"image": image, "sha": sha, "started": started}
    return out


PROJECT_JOURNAL = lanecfg.epic()

# Alias map: container name -> lower-case ticket/issue refs or words that authorise a deploy move for it.
# A container moved by a planned night is often named in the journal by its loader and its ticket, never
# by the container name. Config key container_aliases.
CONTAINER_ALIASES = lanecfg.data("PM_CONTAINER_ALIASES", {})
# Lower-case refs or words whose presence in a journal entry marks a planned stop/restart. Config key
# deploy_planned_tokens.
PLANNED_TOKENS = tuple(lanecfg.data("PM_DEPLOY_PLANNED_TOKENS", []))
# Common container-name prefix, stripped when matching a journal entry ("<prefix>api" -> "api").
CONTAINER_PREFIX = str(lanecfg.get("PM_CONTAINER_PREFIX", ""))


def journal_context(name, window_hours=3):
    """Recent project-journal entries that mention this container, printed with the alarm.

    On 2026-11-01T08:32Z a feed container vanished and I raised a production alarm; it was a planned
    `make <service>-stop APPLY=1` for a priority pause, recorded in the project journal before it
    happened. The measurement was right and the alarm was wrong, because the context was one
    command away. A deploy move is not news until it has been checked against what the project said it
    would do.
    """
    import datetime
    try:
        p = subprocess.run([lanecfg.sb_bin(), "journal", "show", PROJECT_JOURNAL, "--json"], capture_output=True,
                           text=True, timeout=90, cwd=REPO)
        items = json.loads(p.stdout)["data"]
    except Exception as exc:                                    # noqa: BLE001 - a hint must never break the check
        return [f"  context unavailable ({type(exc).__name__})"]
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=window_hours)
    out = []
    for e in items:
        try:
            at = datetime.datetime.fromtimestamp(int(e.get("createdAt", 0)) / 1000, datetime.timezone.utc)
        except (TypeError, ValueError):
            continue
        if at < cutoff:
            continue
        blob = json.dumps(e.get("semantic") or {}) + json.dumps(e.get("result") or {})
        low = blob.lower()
        # Match the container by name, or by the plans that move it. A planned stop is often written as a
        # window and a verb ("reload stops at the first build boundary"), never as the container's name, which
        # is exactly how the 08:32Z removal read as an alarm: the record said "stops ... restarts ~09:55Z".
        aliases = CONTAINER_ALIASES.get(name, [])
        short = name[len(CONTAINER_PREFIX):] if CONTAINER_PREFIX and name.startswith(CONTAINER_PREFIX) else name
        named = name in blob or short in low or any(a in low for a in aliases)
        planned = (any(t in low for t in PLANNED_TOKENS + tuple(aliases)) and
                  any(v in low for v in ("stop", "pause", "restart", "apply", "boundary", "start", "loader")))
        if named or planned:
            text = " ".join(str(blob).split())
            out.append(f"  context seq {e.get('sequence')} {at.strftime('%H:%MZ')} {e.get('kind')}: {text[:220]}")
    return out or [f"  no {PROJECT_JOURNAL} entry in the last {window_hours}h mentions {name}"]


def main():
    cur = snapshot()
    if cur is None:
        return 1
    try:
        prev = json.load(open(SNAP))["containers"]
    except (OSError, ValueError, KeyError):
        prev = {}
    # COMPARE WHAT ACTUALLY MOVES. Two containers report sha=unknown (a feed handler and a database
    # container, local tags with no resolvable digest), so a swap of either was reported as
    # DEPLOY-UNCHANGED: on 2026-11-05 the 22:18Z feed-handler swap restarted that container at 22:19:06Z and
    # this check printed UNCHANGED, because unknown == unknown. The `started` stamp is the fact that
    # moves for them, so it is used whenever the sha cannot answer. Same for a container appearing or
    # disappearing: the count changed 9 -> 8 on 2026-11-04 and no line ever said so.
    def key_of(v):
        # WHY the start stamp is always part of the key: a container can restart into the SAME image, and that
        # restart is the event a window verification needs. Keying on the sha alone reported
        # DEPLOY-UNCHANGED through the 2026-11-06 22:15Z database restart, because its tag resolves to a sha
        # that did not change; keying on "sha else started" reported the feed handler and missed the database, since
        # only the feed handler's image was unresolvable. Both halves are needed, so both are always present.
        if not v:
            return "absent"
        sha = v.get("sha") or ""
        started = v.get("started") or "?"
        if sha and sha != "unknown":
            return f"{sha}|started:{started}"
        return "started:" + started
    moves = []
    for name in sorted(set(cur) | set(prev)):
        now, was = key_of(cur.get(name)), key_of(prev.get(name))
        if now != was:
            moves.append((name, was, now))
    json.dump({"stamp": subprocess.run(["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"], capture_output=True,
                                       text=True).stdout.strip(), "containers": cur},
              open(SNAP, "w"), indent=1)
    if not prev:
        print(f"DEPLOY-BASELINE containers={len(cur)}")
        for name, v in sorted(cur.items()):
            print(f"  {name} {v['sha']} ({v['started']})")
        return 0
    for name, was, now in moves:
        print(f"DEPLOY-CHANGE {name} {was}->{now}")
        if now == "absent" or was == "absent":
            for line in journal_context(name):
                print(line)
    if len(cur) != len(prev):
        print(f"DEPLOY-COUNT {len(prev)}->{len(cur)} containers")
    if moves:
        print("DEPLOY-NOW-AUDIT")
    else:
        print(f"DEPLOY-UNCHANGED containers={len(cur)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
