#!/usr/bin/env python3
"""pm-question: one call files an operator question in Substrate AND on the Status board (XTRM-763).

    pm_question.py add     --ref <ref> --q <text> --rec <text> [--why <text>] [--url <u>] [--id <qid>] [--owner <doc>]
    pm_question.py refresh --q <text> | --id <qid> [--rec ..] [--why ..] [--owner <doc>]
    pm_question.py close   --ref <ref> --q <text> | --id <qid> [--answer <text>] [--owner <doc>]

add      journal entry kind=blocker on <ref> (semantic {summary, for: operator, qid, q, rec, why}) and the
         row {id, ref, by, q, rec, why, at} in Status board doc questions/<owner> (rule 15).
refresh  re-stamps the row ``at`` (and q/rec/why when given). Needs no journal write.
close    journal entry kind=decision (semantic {summary, answers: qid, answer}) and removes the row.

Every journal entry carries ``semantic.summary`` (Substrate requires it; XTRM-771).

The row id is ``qid_of(q)`` (hash of the text) unless --id is given; the Stop hook
(hooks/operator-questions.py) uses the same function, so the command it prints files the same row it looked for.
Settings come from pm_config (PM_STATUS_BOARD_SITE, PM_STATUS_BOARD_KEY_FILE, PM_STATE_DIR); the key is never printed.
No Jira writes: the @operator Jira comment stays the board helper's job. After ``add`` the coordinator hands the
board helper the exact question text and the ticket key; the board helper posts it with post-guard.py --mention-first.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import pm_config  # noqa: E402
import pm_role  # noqa: E402

BY = "pm-question"
MAX_DOC_BYTES = 16 * 1024
DOC_TTL = 300  # seconds: the Stop hook reads here.now at most once per 5 minutes
Q_MAX = 1000


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(value) -> float | None:
    """Epoch seconds of an ISO stamp with minute or second precision (``...T12:56Z``), else None."""
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?", str(value or ""))
    if not m:
        return None
    y, mo, d, h, mi, s = (int(x or 0) for x in m.groups())
    try:
        return datetime(y, mo, d, h, mi, s, tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


def qid_of(text: str) -> str:
    """Stable question id: hash of the normalised text."""
    norm = re.sub(r"[^\w]+", " ", str(text).lower()).strip()
    return "q-" + hashlib.sha1(norm.encode("utf-8")).hexdigest()[:8]


def state_root() -> pathlib.Path:
    return pm_config.state_dir() / "operator-questions"


RUNTIME_PREFIX_RE = re.compile(r"^.*?-xt-[a-z]+-(?=.)")


def owner_of(ident: str, role: str | None = None) -> str:
    """Status board doc name (``questions/<owner>``) of a manager or lead session.

    Order: PM_QUESTION_OWNER; ``manager`` when the session's role is manager, whatever its name (one doc that
    outlives the day, so the next manager inherits the open questions); else the session name without its
    ``<repo>-xt-<runtime>-`` worktree prefix (a lead: its own name). ``role`` is the session's role from
    pm_role (callers pass ``pm_role.current()``); when omitted, the name alone decides (pm_role name patterns).
    The answer router sends an answer to the live session of that name, else to the live manager.
    """
    explicit = pm_config.get("PM_QUESTION_OWNER")
    if explicit:
        return str(explicit)
    name = RUNTIME_PREFIX_RE.sub("", ident or "")
    if role is None:
        role = pm_role.by_name(ident, name) if ident else None
    return "manager" if role == "manager" else name


# ---------------------------------------------------------------- here.now data API
class Hn:
    """Minimal here.now data-docs client; mirrors status_board_sync.hn_call/hn_list (read path and row writes)."""

    def __init__(self, tries=3, timeout=20):
        self.tries, self.timeout = tries, timeout
        self.site = pm_config.get("PM_STATUS_BOARD_SITE", required=True)
        self.key_file = os.path.expanduser(pm_config.get("PM_STATUS_BOARD_KEY_FILE", "~/.herenow/credentials"))
        self.base = "https://here.now/api/v1/publishes/%s/data/docs" % self.site
        self._key = None

    def key(self) -> str:
        if self._key is None:
            with open(self.key_file) as fh:
                self._key = fh.read().strip()
        return self._key

    def scrub(self, text: str) -> str:
        return text.replace(self.key(), "<KEY>") if self._key and len(self._key) > 4 else text

    def call(self, method, url, body=None, idem=None, tries=None, timeout=None):
        tries, timeout = tries or self.tries, timeout or self.timeout
        headers = {"Authorization": "Bearer " + self.key(), "User-Agent": "pm-question", "Accept": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
        if idem:
            headers["Idempotency-Key"] = idem
        for attempt in range(tries):
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    raw = r.read()
                    return r.status, (json.loads(raw) if raw else None)
            except urllib.error.HTTPError as e:
                raw = self.scrub(e.read().decode("utf-8", "replace"))
                if e.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                    time.sleep(min(5.0, float(e.headers.get("Retry-After") or 2 * (attempt + 1))))
                    continue
                return e.code, raw[:300]
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                if attempt < tries - 1:
                    time.sleep(2 * (attempt + 1))
                    continue
                return "ERR", self.scrub(str(e))[:300]
        return "ERR", "exhausted"

    def find(self, path: str):
        """(record id, doc, updatedAt) of the doc at ``path``, or None. The API has no path filter: page through."""
        cursor = None
        while True:
            url = self.base + "?limit=100" + ("&cursor=" + urllib.parse.quote(cursor) if cursor else "")
            st, body = self.call("GET", url)
            if st != 200:
                raise RuntimeError("here.now list failed: %s %s" % (st, body))
            for rec in body.get("records") or []:
                data = rec.get("data") or {}
                if data.get("path") == path:
                    doc = data.get("doc")
                    if isinstance(doc, str):
                        doc = json.loads(doc)
                    return rec.get("id"), doc or {}, rec.get("updatedAt") or ""
            cursor = body.get("nextCursor")
            if not cursor:
                return None

    def write(self, path: str, rid, doc: dict):
        if len(json.dumps({"path": path, "doc": doc}, ensure_ascii=False).encode("utf-8")) >= MAX_DOC_BYTES:
            raise RuntimeError("doc %s would reach %d bytes; close answered rows first" % (path, MAX_DOC_BYTES))
        if rid:
            st, body = self.call("PATCH", "%s/%s" % (self.base, rid), {"doc": doc})
        else:
            st, body = self.call("POST", self.base, {"path": path, "doc": doc}, idem=str(uuid.uuid4()))
        if st not in (200, 201):
            raise RuntimeError("here.now write failed: %s %s" % (st, body))


def doc_path(owner: str) -> str:
    return "questions/%s" % owner


def cache_file(owner: str) -> pathlib.Path:
    return state_root() / ("doc-%s.json" % re.sub(r"[^A-Za-z0-9._-]", "_", owner))


def log_error(where: str, exc) -> None:
    try:
        root = state_root()
        root.mkdir(parents=True, exist_ok=True)
        with open(root / "errors.log", "a", encoding="utf-8") as fh:
            fh.write("%s pm-question (%s) %r\n" % (utc_now(), where, exc))
    except Exception:
        pass


def read_rows(owner: str, fetch=None, now=None, force=False) -> tuple[list, str] | None:
    """Rows of questions/<owner> and the doc's updatedAt; cached DOC_TTL seconds under the state dir.

    A failed read is cached too (same TTL), so an outage costs one short attempt per 5 minutes.
    ``fetch`` (tests) replaces the here.now read. Returns None when the read failed (caller fails open).
    """
    now = time.time() if now is None else now
    cf = cache_file(owner)
    if not force:
        try:
            c = json.loads(cf.read_text())
            if now - float(c["at"]) < DOC_TTL:
                return None if c.get("failed") else (c["rows"], c.get("updatedAt", ""))
        except (OSError, ValueError, KeyError):
            pass
    result, entry = None, {"at": now, "failed": True}
    try:
        found = (fetch or (lambda p: Hn(tries=1, timeout=8).find(p)))(doc_path(owner))
        rows, upd = ((found[1].get("rows") or []), found[2]) if found else ([], "")
        result, entry = (rows, upd), {"at": now, "rows": rows, "updatedAt": upd}
    except (OSError, RuntimeError, ValueError, SystemExit) as exc:
        log_error("read_rows", exc)
    try:
        cf.parent.mkdir(parents=True, exist_ok=True)
        cf.write_text(json.dumps(entry))
    except OSError:
        pass
    return result


def blockers_file(owner: str) -> pathlib.Path:
    return state_root() / ("blockers-%s.json" % re.sub(r"[^A-Za-z0-9._-]", "_", owner))


def gate_questions_file(owner: str) -> pathlib.Path:
    """Cache of the action gate's open-question scan (hooks/action_gate.py) for one owner."""
    return state_root() / ("gate-questions-%s.json" % re.sub(r"[^A-Za-z0-9._-]", "_", owner))


def invalidate(owner: str) -> None:
    """Drop the doc and blocker caches of one coordinator (the CLI calls it after every write)."""
    for f in (cache_file(owner), blockers_file(owner), gate_questions_file(owner)):
        try:
            f.unlink()
        except OSError:
            pass


# ---------------------------------------------------------------- substrate journal
def sb_bin() -> str:
    return pm_config.get("PM_SB_BIN") or shutil.which("sb") or "sb"


def sb_json(args: list[str], timeout=8):
    r = subprocess.run([sb_bin(), *args, "--json"], capture_output=True, text=True, timeout=timeout)
    try:
        return json.loads(r.stdout)
    except ValueError:
        return None


def journal_entries(ref: str, kind: str, limit=40) -> list[dict]:
    """The newest ``limit`` entries of a kind (``--limit`` alone returns the oldest)."""
    out = sb_json(["journal", "show", ref, "--kind", kind, "--tail", str(limit)])
    return (out or {}).get("data") or [] if isinstance(out, dict) else []


SUMMARY_MAX = 20000  # sb journal append refuses a longer summary and writes nothing


def journal_append(ref: str, kind: str, semantic: dict) -> None:
    """Append one entry. ``semantic.summary`` is required by Substrate: a caller that left it out gets one built
    from the entry itself, so no entry is ever written without it (XTRM-771)."""
    summary = str(semantic.get("summary") or "").strip()
    if not summary:
        summary = "%s: %s" % (kind, semantic.get("q") or semantic.get("answer") or semantic.get("qid") or kind)
    semantic = {**semantic, "summary": summary[:SUMMARY_MAX]}
    r = subprocess.run([sb_bin(), "journal", "append", ref, "--kind", kind,
                        "--semantic", json.dumps(semantic, ensure_ascii=False)],
                       capture_output=True, text=True, timeout=15)
    if r.returncode != 0:
        raise RuntimeError("sb journal append failed: %s" % (r.stderr or r.stdout).strip()[:300])


# ---------------------------------------------------------------- commands
def _row_index(rows: list, qid: str) -> int:
    return next((i for i, r in enumerate(rows) if isinstance(r, dict) and r.get("id") == qid), -1)


def _save(owner: str, mutate, dry: bool) -> str:
    """Re-read the doc fresh, apply ``mutate(rows)`` -> note, write it back."""
    hn = Hn()
    found = hn.find(doc_path(owner))
    rid, doc = (found[0], found[1]) if found else (None, {"from": owner})
    rows = list(doc.get("rows") or [])
    note = mutate(rows)
    doc = {**doc, "from": doc.get("from") or owner, "rows": rows, "updatedAt": utc_now(), "updatedBy": BY}
    if dry:
        return "DRY: would write %s (%d rows): %s" % (doc_path(owner), len(rows), note)
    hn.write(doc_path(owner), rid, doc)
    invalidate(owner)
    return "%s %s (%d rows)" % (note, doc_path(owner), len(rows))


def cmd_add(a) -> str:
    qid = a.id or qid_of(a.q)
    by = os.environ.get("SUBSTRATE_HOLDER") or os.environ.get("XTRM_SESSION_NAME") or BY
    row = {"id": qid, "ref": a.ref, "by": by, "q": a.q[:Q_MAX], "rec": a.rec[:Q_MAX], "why": (a.why or "")[:Q_MAX],
           "at": utc_now()}
    if a.url:
        row["url"] = a.url

    def mutate(rows):
        i = _row_index(rows, qid)
        if i >= 0:
            if rows[i].get("q") and rows[i]["q"] != row["q"]:
                raise RuntimeError("row id %s already holds another question; pick another --id" % qid)
            rows[i] = {**rows[i], **{k: v for k, v in row.items() if v not in ("", None)}}
            return "refreshed row %s in" % qid
        rows.append(row)
        return "added row %s to" % qid

    msgs = [_save(a.owner, mutate, a.dry_run)]  # row first: a failed write leaves no blocker, and a retry is clean
    if not a.dry_run:
        known = [e for e in journal_entries(a.ref, "blocker") if (e.get("semantic") or {}).get("qid") == qid]
        if not known:
            journal_append(a.ref, "blocker", {"summary": "Operator question %s: %s" % (qid, row["q"]), "for": "operator",
                                              "qid": qid, "q": row["q"], "rec": row["rec"], "why": row["why"]})
            msgs.append("journal blocker on %s" % a.ref)
        msgs.append("next: hand the board helper an @operator Jira comment on the row's ticket with this exact text "
                    "(it posts it with post-guard.py --mention-first): %s" % row["q"])
    return "; ".join(msgs)


def cmd_refresh(a) -> str:
    qid = a.id or qid_of(a.q or "")

    def mutate(rows):
        i = _row_index(rows, qid)
        if i < 0:
            raise RuntimeError("no row %s in %s; use add" % (qid, doc_path(a.owner)))
        for k, v in (("q", a.q), ("rec", a.rec), ("why", a.why), ("url", a.url)):
            if v:
                rows[i][k] = v[:Q_MAX]
        rows[i]["at"] = utc_now()
        return "refreshed row %s in" % qid

    return _save(a.owner, mutate, a.dry_run)


def cmd_close(a) -> str:
    qid = a.id or qid_of(a.q or "")
    msgs = []
    if a.ref and not a.dry_run:
        answer = a.answer or "answered by the operator"
        journal_append(a.ref, "decision", {"summary": "Operator answer to %s: %s" % (qid, answer),
                                           "answers": qid, "answer": answer})
        msgs.append("journal decision on %s" % a.ref)

    def mutate(rows):
        i = _row_index(rows, qid)
        if i >= 0:
            rows.pop(i)
            return "removed row %s from" % qid
        return "row %s was not in" % qid

    msgs.append(_save(a.owner, mutate, a.dry_run))
    return "; ".join(msgs)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="pm-question", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("add", "refresh", "close"):
        s = sub.add_parser(name)
        s.add_argument("--ref", help="Substrate issue ref the blocker/decision entry goes on")
        s.add_argument("--q", help="the question, in plain words")
        s.add_argument("--rec", help="your recommendation")
        s.add_argument("--why", help="why the operator is needed, by when")
        s.add_argument("--url", help="link to the artifact")
        s.add_argument("--id", help="row id (default: hash of --q)")
        s.add_argument("--answer", help="close: the operator's answer")
        s.add_argument("--owner", help="Status board doc owner (default: this session's coordinator name)")
        s.add_argument("--dry-run", action="store_true", help="read only; print what would be written")
    return p


def main(argv=None) -> int:
    a = build_parser().parse_args(argv)
    if not (a.id or a.q):
        sys.exit("pm-question: --q or --id is required")
    if a.cmd == "add" and not (a.ref and a.q and a.rec):
        sys.exit("pm-question add: --ref, --q and --rec are required")
    for name in ("ref", "rec", "q"):
        v = getattr(a, name, None) or ""
        if re.fullmatch(r"<[^<>]+>", v.strip()):
            sys.exit("pm-question: --%s is still a placeholder (%s); fill it in" % (name, v.strip()))
    if a.cmd == "close" and not a.ref and not a.dry_run:
        print("pm-question: no --ref, so no decision entry is written (row only)", file=sys.stderr)
    ident = os.environ.get("SUBSTRATE_HOLDER") or os.environ.get("XTRM_SESSION_NAME") or ""
    role = pm_role.current()
    a.owner = a.owner or (owner_of(ident, role) if ident or role == "manager" else None)
    if not a.owner:
        sys.exit("pm-question: no coordinator name (SUBSTRATE_HOLDER unset); pass --owner")
    try:
        print({"add": cmd_add, "refresh": cmd_refresh, "close": cmd_close}[a.cmd](a))
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as e:
        print("pm-question: %s" % e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
