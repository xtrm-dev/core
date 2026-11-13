"""Tests for scripts/pm_question.py (XTRM-763). No network, no sb: a fake here.now and a fake journal."""
import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import pm_config  # noqa: E402
import pm_question as pq  # noqa: E402

REAL_JOURNAL_ENTRIES = pq.journal_entries
Q = "Vuoi che proceda con il merge?"


class FakeHn:
    docs = {}
    writes = 0

    def find(self, path):
        d = FakeHn.docs.get(path)
        return ("rid-1", json.loads(json.dumps(d)), "2026-11-13T00:00:00Z") if d is not None else None

    def write(self, path, rid, doc):
        FakeHn.writes += 1
        FakeHn.docs[path] = doc


@pytest.fixture
def fake(tmp_path, monkeypatch):
    cfg = tmp_path / "pm.json"
    cfg.write_text(json.dumps({"state_dir": str(tmp_path / "state"), "tabellone_site": "s"}))
    monkeypatch.setenv("PM_CONFIG", str(cfg))
    monkeypatch.setenv("SUBSTRATE_HOLDER", "p-xt-claude-alpha-coord")
    monkeypatch.delenv("PM_QUESTION_OWNER", raising=False)
    pm_config._RAW = pm_config._CACHE = None
    FakeHn.docs, FakeHn.writes = {}, 0
    journal = []
    monkeypatch.setattr(pq, "Hn", FakeHn)
    monkeypatch.setattr(pq, "journal_append", lambda ref, kind, sem: journal.append((ref, kind, sem)))
    monkeypatch.setattr(pq, "journal_entries", lambda ref, kind, limit=40: [
        {"semantic": s} for r, k, s in journal if r == ref and k == kind])
    yield journal
    pm_config._RAW = pm_config._CACHE = None


def run(*argv):
    return pq.main(list(argv))


def test_add_writes_blocker_and_row_once(fake, capsys):
    assert run("add", "--ref", "EP-1", "--q", Q, "--rec", "yes, now", "--why", "window at 09:00") == 0
    qid = pq.qid_of(Q)
    assert fake == [("EP-1", "blocker", {"for": "operator", "qid": qid, "q": Q, "rec": "yes, now", "why": "window at 09:00"})]
    doc = FakeHn.docs["questions/alpha-coord"]
    (row,) = doc["rows"]
    assert row["id"] == qid and row["ref"] == "EP-1" and row["rec"] == "yes, now" and row["at"].endswith("Z")
    assert doc["from"] == "alpha-coord" and doc["updatedBy"] == "pm-question"
    run("add", "--ref", "EP-1", "--q", Q, "--rec", "yes, now")          # again: same row, no second blocker
    assert len(FakeHn.docs["questions/alpha-coord"]["rows"]) == 1 and len(fake) == 1


def test_add_keeps_other_rows(fake):
    FakeHn.docs["questions/alpha-coord"] = {"from": "alpha-coord", "rows": [{"id": "q-other", "q": "other open question"}]}
    run("add", "--ref", "EP-1", "--q", Q, "--rec", "r")
    assert [r["id"] for r in FakeHn.docs["questions/alpha-coord"]["rows"]] == ["q-other", pq.qid_of(Q)]


def test_refresh_restamps_and_needs_a_row(fake, capsys):
    assert run("refresh", "--q", Q) == 1 and "no row" in capsys.readouterr().err
    run("add", "--ref", "EP-1", "--q", Q, "--rec", "r")
    FakeHn.docs["questions/alpha-coord"]["rows"][0]["at"] = "2020-01-01T00:00:00Z"
    run("refresh", "--q", Q, "--rec", "new rec")
    row = FakeHn.docs["questions/alpha-coord"]["rows"][0]
    assert row["at"] > "2026" and row["rec"] == "new rec" and len(fake) == 1


def test_close_writes_decision_and_removes_row(fake):
    run("add", "--ref", "EP-1", "--q", Q, "--rec", "r")
    run("close", "--ref", "EP-1", "--q", Q, "--answer", "go")
    assert FakeHn.docs["questions/alpha-coord"]["rows"] == []
    assert fake[-1] == ("EP-1", "decision", {"answers": pq.qid_of(Q), "answer": "go"})


def test_dry_run_writes_nothing(fake, capsys):
    run("add", "--ref", "EP-1", "--q", Q, "--rec", "r", "--dry-run")
    assert fake == [] and FakeHn.writes == 0 and "DRY" in capsys.readouterr().out


def test_owner_resolution(fake, monkeypatch):
    assert pq.owner_of("p-xt-claude-alpha-coord") == "alpha-coord"
    assert pq.owner_of("p-xt-claude-beta-coord-3") == "beta-coord-3"
    monkeypatch.setenv("PM_QUESTION_OWNER", "custom")
    assert pq.owner_of("anything") == "custom"


def test_add_requires_fields(fake):
    with pytest.raises(SystemExit):
        run("add", "--q", Q)


def test_read_rows_caches_for_five_minutes(fake):
    calls = []
    fetch = lambda p: calls.append(p) or ("r", {"rows": [{"id": "x"}]}, "u")
    assert pq.read_rows("alpha-coord", fetch=fetch, now=1000.0)[0] == [{"id": "x"}]
    pq.read_rows("alpha-coord", fetch=fetch, now=1100.0)
    assert len(calls) == 1
    pq.read_rows("alpha-coord", fetch=fetch, now=1000.0 + pq.DOC_TTL + 1)
    assert len(calls) == 2
    pq.invalidate("alpha-coord")
    pq.read_rows("alpha-coord", fetch=fetch, now=1100.0)
    assert len(calls) == 3


def test_tail_is_used_for_journal_reads(fake, monkeypatch):
    seen = []
    monkeypatch.setattr(pq, "sb_json", lambda args, timeout=8: seen.append(args) or {"data": []})
    monkeypatch.setattr(pq, "journal_entries", REAL_JOURNAL_ENTRIES)
    pq.journal_entries("EP-1", "blocker")
    assert seen and "--tail" in seen[0] and "--limit" not in seen[0]


def test_placeholders_are_rejected(fake, capsys):
    with pytest.raises(SystemExit):
        run("add", "--ref", "EP-1", "--q", Q, "--rec", "<your recommendation>")
    with pytest.raises(SystemExit):
        run("add", "--ref", "<issue-ref>", "--q", Q, "--rec", "r")


def test_id_collision_with_another_question_is_refused(fake, capsys):
    run("add", "--ref", "EP-1", "--q", Q, "--rec", "r", "--id", "q-fixed")
    assert run("add", "--ref", "EP-1", "--q", "A different question?", "--rec", "r", "--id", "q-fixed") == 1
    assert "another question" in capsys.readouterr().err
    assert FakeHn.docs["questions/alpha-coord"]["rows"][0]["q"] == Q


def test_add_and_close_drop_the_caches(fake):
    pq.cache_file("alpha-coord").parent.mkdir(parents=True, exist_ok=True)
    for f in (pq.cache_file("alpha-coord"), pq.blockers_file("alpha-coord")):
        f.write_text("{}")
    run("add", "--ref", "EP-1", "--q", Q, "--rec", "r")
    assert not pq.cache_file("alpha-coord").exists() and not pq.blockers_file("alpha-coord").exists()


def test_oversize_doc_fails_before_the_journal_write(fake, capsys):
    FakeHn.docs["questions/alpha-coord"] = {"rows": []}
    orig = FakeHn.write

    def big(self, path, rid, doc):
        raise RuntimeError("doc would reach limit")
    FakeHn.write = big
    try:
        assert run("add", "--ref", "EP-1", "--q", Q, "--rec", "r") == 1
    finally:
        FakeHn.write = orig
    assert fake == []   # row first: no orphan blocker


# ---------------------------------------------------------------- real Hn client against a stub urlopen
REAL_HN = pq.Hn


class FakeResp:
    def __init__(self, status, body):
        self.status, self._b = status, json.dumps(body).encode()

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def hn(fake, monkeypatch, tmp_path):
    key = tmp_path / "key"
    key.write_text("SECRETKEY123\n")
    monkeypatch.setenv("PM_TABELLONE_KEY_FILE", str(key))
    monkeypatch.setenv("PM_TABELLONE_SITE", "site-x")
    pm_config._RAW = pm_config._CACHE = None
    monkeypatch.setattr(pq, "Hn", REAL_HN)
    calls, pages = [], {}

    def urlopen(req, timeout=0):
        calls.append((req.get_method(), req.full_url, req.headers.get("Authorization"), timeout))
        if req.get_method() == "GET":
            return FakeResp(200, pages["next" if "cursor=" in req.full_url else "first"])
        return FakeResp(200, {})
    monkeypatch.setattr(pq.urllib.request, "urlopen", urlopen)
    return calls, pages


def test_hn_find_pages_and_sends_the_key_only_in_the_header(hn):
    calls, pages = hn
    rec = {"id": "rec1", "updatedAt": "u", "data": {"path": "questions/alpha-coord", "doc": {"rows": [{"id": "x"}]}}}
    pages["first"] = {"records": [{"id": "r0", "data": {"path": "workers/a", "doc": {}}}], "nextCursor": "c1"}
    pages["next"] = {"records": [rec]}
    rid, doc, upd = pq.Hn(tries=1, timeout=8).find("questions/alpha-coord")
    assert rid == "rec1" and doc["rows"] == [{"id": "x"}]
    assert [c[0] for c in calls] == ["GET", "GET"] and calls[0][2] == "Bearer SECRETKEY123" and calls[0][3] == 8
    assert all("SECRETKEY123" not in c[1] for c in calls)


def test_hn_write_posts_new_patches_existing_and_caps_size(hn):
    calls, _ = hn
    h = pq.Hn()
    h.write("questions/alpha-coord", None, {"rows": []})
    h.write("questions/alpha-coord", "rec1", {"rows": []})
    assert [c[0] for c in calls] == ["POST", "PATCH"] and calls[1][1].endswith("/rec1")
    with pytest.raises(RuntimeError, match="16384"):
        h.write("questions/alpha-coord", "rec1", {"rows": [{"q": "x" * 17000}]})
    assert len(calls) == 2   # the oversize doc never reached the network


def test_hn_error_body_never_leaks_the_key(hn, monkeypatch):
    import io
    import urllib.error

    def boom(req, timeout=0):
        raise urllib.error.HTTPError(req.full_url, 400, "bad", {}, io.BytesIO(b"echo SECRETKEY123 echo"))
    monkeypatch.setattr(pq.urllib.request, "urlopen", boom)
    h = pq.Hn(tries=1)
    st, body = h.call("GET", h.base)
    assert st == 400 and "SECRETKEY123" not in body and "<KEY>" in body
