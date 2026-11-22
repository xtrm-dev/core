#!/usr/bin/env python3
"""Keep one Tabellone row up while nobody is reading the lane (sat07-coord WORD, 2026-11-09T22:4xZ).

Why it exists: on 2026-11-09 the lane had no reader from 04:40Z to 22:16Z. The deadman did its job and wrote
"WATCHER-COUNT 0 tails on events.log" every two minutes — into events.log, which is the same file nobody was
reading. The alarm was correct and invisible at the same time. This publishes the same fact where both the
operator and the coordinator look, and clears it the moment a reader is back, so the row cannot go stale by
inauguration.

Called from deadman.py's check() so there is one clock and one source of truth for watcher_count().
Idempotent: it PATCHes the doc only when the row has to appear or disappear.

  lane-watchdog.py check         # publish/clear from the process table
  lane-watchdog.py --selftest    # controls for the fetch-failure / absent-doc split
"""
import importlib.util
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

DOC_PATH = "questions/sat07-coord"
ROW_ID = "q-lane-unwatched"
SITE = "velvet-breeze-fbm8"
BASE = f"https://here.now/api/v1/publishes/{SITE}/data/docs"
REC = None  # discovered on first call


def _key():
    return open(os.path.expanduser("~/.herenow/credentials")).read().strip()


def _call(method, url, body=None):
    h = {"Authorization": "Bearer " + _key(), "Accept": "application/json",
         "User-Agent": "lane-watchdog/MMD-3752"}
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode()
        h["Content-Type"] = "application/json; charset=utf-8"
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:300]
    except Exception as e:  # network down: say nothing, the next pass retries
        return 0, str(e)[:200]


def _docs():
    out, cursor = [], None
    while True:
        u = BASE + "?limit=100"
        if cursor:
            u += "&cursor=" + urllib.parse.quote(cursor)
        st, b = _call("GET", u)
        if st != 200:
            return None
        out += b.get("records") or []
        cursor = b.get("nextCursor")
        if not cursor:
            return out


class _ListFetchFailed(Exception):
    """The docs list could not be read: not the same fact as a missing doc."""


def _find(path):
    global REC
    docs = _docs()
    if docs is None:
        docs = _docs()  # one immediate retry: a single 200-less pass is not a missing doc
    if docs is None:
        raise _ListFetchFailed()
    for rec in docs:
        d = rec.get("data") or {}
        if d.get("path") == path:
            doc = d.get("doc")
            if isinstance(doc, str):
                try:
                    doc = json.loads(doc)
                except ValueError:
                    pass
            REC = rec.get("id") or rec.get("rid")
            return REC, doc
    return None, None


def sync(unwatched, detail=""):
    """unwatched=True publishes the row; False removes it. Returns a one-line outcome or ''."""
    try:
        rid, doc = _find(DOC_PATH)
    except _ListFetchFailed:
        return "LANE-WATCHDOG-SKIP list-fetch-failed"
    except Exception as exc:  # noqa: BLE001 - a watchdog must not raise into the deadman
        return f"LANE-WATCHDOG-SKIP {type(exc).__name__}"
    if not isinstance(doc, dict):
        return "LANE-WATCHDOG-SKIP no doc"
    rows = doc.get("rows") or []
    have = next((r for r in rows if r.get("id") == ROW_ID), None)
    if unwatched and have is None:
        rows.insert(0, {
            "id": ROW_ID,
            "ref": "events.log WATCHER-COUNT, deadman every 2 min",
            "by": "board-coord-sat07",
            "q": "Nessuno sta leggendo il registro della corsia: i commenti dei ticket e gli ordini restano in coda finche un lettore non torna. Serve riattaccare il monitor (una coda tail su events.log).",
            "rec": "riattaccare subito il lettore, poi questa riga sparisce da sola",
            "why": detail or "watcher_count=0",
        })
    elif not unwatched and have is not None:
        rows = [r for r in rows if r.get("id") != ROW_ID]
    else:
        return ""
    doc["rows"] = rows
    doc["updatedBy"] = "board-coord-sat07"
    st, _ = _call("PATCH", f"{BASE}/{rid}", {"path": DOC_PATH, "doc": doc})
    verb = "PUBLISHED" if unwatched else "CLEARED"
    return f"LANE-WATCHDOG {verb} {ROW_ID} st={st}"


def _selftest():
    """Three controls: fetch failure (retried once), absent doc, normal doc. No network."""
    global REC
    g = globals()
    real, bad = g["_docs"], []

    def case(name, ok, got=""):
        print(f"{'ok  ' if ok else 'FAIL'} {name}{'' if ok else ' -> ' + repr(got)}")
        if not ok:
            bad.append(name)

    calls = []
    g["_docs"] = lambda: (calls.append(1), None)[1]
    got = sync(True, "selftest")
    g["_docs"] = real
    case("list fetch fails -> retried once, reported as fetch failure",
         got == "LANE-WATCHDOG-SKIP list-fetch-failed" and len(calls) == 2, (got, len(calls)))

    calls = []
    g["_docs"] = lambda: (calls.append(1), [])[1]
    got = sync(True, "selftest")
    g["_docs"] = real
    case("doc absent from a good list -> absent-doc outcome, no retry",
         got == "LANE-WATCHDOG-SKIP no doc" and len(calls) == 1, (got, len(calls)))

    REC = None
    rows = [{"id": ROW_ID + "-other", "q": "keep me"}]
    g["_docs"] = lambda: [{"id": "rec_1", "data": {"path": DOC_PATH,
                                                    "doc": json.dumps({"rows": rows})}}]
    rid, doc = _find(DOC_PATH)
    g["_docs"] = real
    case("normal list -> record and rows found",
         rid == "rec_1" and isinstance(doc, dict) and doc.get("rows") == rows and REC == "rec_1",
         (rid, doc))

    print(f"selftest {'PASS' if not bad else 'FAIL'} {3 - len(bad)}/3")
    return 0 if not bad else 1


if __name__ == "__main__":
    arg = (sys.argv[1] if len(sys.argv) > 1 else "").strip().lower()
    if arg == "--selftest":
        sys.exit(_selftest())
    if arg == "check":
        # standalone: read the process table the same way deadman does
        import subprocess
        out = subprocess.run(["ps", "-eo", "pid,cmd"], capture_output=True, text=True).stdout
        n = sum(1 for l in out.splitlines()
                if l.split(None, 1)[1:] and l.split(None, 1)[1].startswith("tail "))
        print(f"watcher_count={n}")
        print(sync(n == 0, f"watcher_count={n}") or "(row already in the wanted state)")
    else:
        print(sync(arg == "up", "manual"))
