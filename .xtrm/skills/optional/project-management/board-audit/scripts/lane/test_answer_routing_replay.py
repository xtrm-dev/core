"""Replay of the three 2026-11-18 answer-routing failures, against the code after MMD-5389.

The failures (MMD-2331 seq 3817, seq 3896): the operator's answers reached the Status board and their owner never
heard them. Two layers lost them and a third could not notice:
  - the sync stamped answers `delivered: file-only` (the manager is in status_board_file_only) and sent nothing;
  - the lane router classified a bare yes/no as idle acknowledgement, so an answer that needed a route got none;
  - an answer that never became a pending route appeared in no alarm at all.

Each case below is the recorded shape, replayed through the real code: the sync's route_answers(), the router's
main(), and reconcile-answers.py. Verdicts (the same names in the journal result):
  answers:25     ROUTED   the recorded file-only ACK row is routed to the asker; the ledger counts 1 unrouted
                          before the route (file-only-no-route) and 0 after it.
  unenqueued     ALARMED  three answers the sync never appended are a count of 3, never silence.
  answers:49     RETAINED routed as a decision (a challenge is never suppressed), visible as pending=1 until it is
                          delivered, and the close of its question does not drop it from the ledger.
Controls: a single ok with no open question produces no route; a bare yes to an open question is routed to the
asker by name; an unreadable store prints UNMEASURED and never a zero.

No network, no Jira, no here.now: every input is a dict. No operator answer text is used; the challenge comment
is synthetic.
Run: python3 -m pytest -q test_answer_routing_replay.py
"""
import contextlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
PACK = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))   # .../project-management
TMP = tempfile.mkdtemp(prefix="replay-answers-")
# Neutral instance settings, set before the imports read them: status_board_sync.py, route-watch.py and
# reconcile-answers.py all resolve paths and config at import time. PM_CONFIG points at a missing file so the
# operator's own config never leaks in. The previous values are restored after the imports, so a second test
# module in the same process keeps its own environment.
_ENV = {
    "PM_CONFIG": os.path.join(TMP, "no-config.json"),
    "PM_JIRA_PROJECT": "PROJ", "PM_SB_PREFIX": "TASK", "JIRA_SITE": "https://example.atlassian.net",
    "PM_REPO_NAME": "example-repo", "PM_REPO_SLUG": "example-org/example-repo",
    "PM_REPO_DIR": "/srv/example-repo", "PM_EPIC": "TASK-1", "PM_CI_WORKFLOW": "ci.yml",
    "PM_OPERATOR_ACCOUNT_ID": "op-1", "PM_OPERATOR_NAME": "Dawid",
    "PM_STATUS_BOARD_SITE": "example-site", "PM_STATUS_BOARD_SELF_ISSUE": "TASK-1",
    "PM_STATUS_BOARD_STATE_DIR": os.path.join(TMP, "state"),
    "PM_ANSWERS_INBOX": os.path.join(TMP, "state", "answers-inbox.jsonl"),
    "PM_LANE_DIR": os.path.join(TMP, "lane"),
}
_SAVED = {k: os.environ.get(k) for k in _ENV}
os.environ.update(_ENV)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ts = load("status_board_sync_replay",
          os.path.join(PACK, "status-board-keeper", "scripts", "status_board_sync.py"))
rw = load("route_watch_replay", os.path.join(HERE, "route-watch.py"))
ra = load("reconcile_answers_replay", os.path.join(HERE, "reconcile-answers.py"))

for k, v in _SAVED.items():
    if v is None:
        os.environ.pop(k, None)
    else:
        os.environ[k] = v

NOW = datetime(2026, 11, 18, 14, 0, tzinfo=timezone.utc)
SEED = "2026-11-18T00:00:00Z"
ASKER = "MMD-4915-infra-lead-2"
for mod in (ts, ra):
    mod.ANSWER_SEED_AT = SEED
    if hasattr(mod, "SEED_AT"):
        mod.SEED_AT = SEED


def store(*answers, questions=None):
    """{path: doc} in the shape read_store() returns. `questions` maps owner -> rows."""
    out = {"answers/" + qid: doc for qid, doc in answers}
    for owner, rows in (questions or {}).items():
        out["questions/" + owner] = {"from": owner, "rows": rows, "updatedAt": "2026-11-18T13:00Z"}
    return out


def answer(qid, at, ans="yes", comment=""):
    return qid, {"answer": ans, "comment": comment, "at": at, "by": "Dawid"}


def question(qid, by=ASKER):
    return {"id": qid, "by": by, "q": "an operator question", "why": "test", "at": "2026-11-18T11:00Z"}


def inbox_row(qid, at, ans="yes", comment="", owner="operator-waiting", delivered="file-only",
              question_open=None):
    """One answers-inbox line. `question_open` is absent in the rows written before MMD-5389."""
    row = {"qid": qid, "owner": owner, "at": at, "answer": ans, "comment": comment, "by": "Dawid",
           "delivered": delivered, "run": "2026-11-18T08:06:00Z"}
    if question_open is not None:
        row["question_open"] = question_open
    return row


def route_row(qid, idx, delivered=False):
    return {"id": "answers:%d" % idx, "channel": "answers", "key": qid, "cid": None, "author": "Dawid",
            "at": "2026-11-18T12:32:48Z", "trigger": "answer:no", "text": "",
            "seen_at": "2026-11-18T12:35:00Z", "delivered": delivered}


class Base(unittest.TestCase):
    def setUp(self):
        self.lane = tempfile.mkdtemp(prefix="replay-lane-")
        self.inbox_path = os.path.join(self.lane, "answers-inbox.jsonl")
        self.outbox_path = os.path.join(self.lane, "pending-routes.jsonl")
        self.bot_inbox = os.path.join(self.lane, "bot-inbox.jsonl")
        open(self.bot_inbox, "w").close()
        self.saved = {k: getattr(rw, k) for k in ("CHANNELS", "CURSOR", "OUTBOX")}
        self.addCleanup(lambda: [setattr(rw, k, v) for k, v in self.saved.items()])
        rw.CHANNELS = {"inbox": self.bot_inbox, "answers": self.inbox_path}
        rw.CURSOR = os.path.join(self.lane, "route-cursor.json")
        rw.OUTBOX = self.outbox_path
        with open(rw.CURSOR, "w") as fh:
            json.dump({"inbox": 0, "answers": 0}, fh)
        # main() resolves the answers inbox at call time, so the environment is the only honest way to keep a
        # test away from the host's real inbox (`PM_ANSWERS_INBOX` is read on every call).
        self._env_inbox = os.environ.get("PM_ANSWERS_INBOX")
        os.environ["PM_ANSWERS_INBOX"] = self.inbox_path
        self.addCleanup(self._restore_inbox_env)

    def _restore_inbox_env(self):
        if self._env_inbox is None:
            os.environ.pop("PM_ANSWERS_INBOX", None)
        else:
            os.environ["PM_ANSWERS_INBOX"] = self._env_inbox

    def write(self, path, rows):
        with open(path, "w") as fh:
            for r in rows:
                fh.write(json.dumps(r) + "\n")

    def outbox(self):
        if not os.path.exists(self.outbox_path):
            return []
        return [json.loads(line) for line in open(self.outbox_path) if line.strip()]

    def route(self):
        """(exit code, stdout) of one router pass over the answers inbox already written."""
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = rw.main()
        return rc, out.getvalue()

    def reconcile(self, rows, inbox=None, outbox=None, routed=()):
        return ra.reconcile(rows, inbox if inbox is not None else self.inbox(), 
                            self.outbox() if outbox is None else outbox, routed, now=NOW)

    def inbox(self):
        if not os.path.exists(self.inbox_path):
            return []
        return [json.loads(line) for line in open(self.inbox_path) if line.strip()]


class CaseAnswers25(Base):
    """answers:25 arrived on the board and never was routed: the row said delivered=file-only and a bare yes
    looked like an ack."""

    def test_the_recorded_file_only_ack_row_is_routed_to_the_asker(self):
        rows = store(answer("q-answers-25", "2026-11-18T08:05:00Z"),
                     questions={ASKER: [question("q-answers-25")]})
        self.write(self.inbox_path, [inbox_row("q-answers-25", "2026-11-18T08:05:00Z")])
        summary, lines = self.reconcile(rows)
        self.assertEqual((summary["answers"], summary["unrouted"]), (1, 1), summary)
        self.assertIn("reason=file-only-no-route", lines[0], lines)
        self.assertIn("question=open", lines[0], lines)
        self.assertIn("asker=" + ASKER, lines[0], lines)

        rc, out = self.route()
        self.assertEqual(rc, 0)
        self.assertIn("ROUTE-DECISION", out)
        # The recorded row carries the document name as owner (the asker was never recorded); the route exists, so
        # route-backlog.py alarms it and the alarm above names the asker. Every answer from now on carries the
        # asker itself (see Controls.test_positive_*).
        self.assertEqual([(r["key"], r["owner"], r["trigger"]) for r in self.outbox()],
                         [("q-answers-25", "operator-waiting", "answer:yes")])
        summary, lines = self.reconcile(rows)
        self.assertEqual((summary["unrouted"], lines), (0, []), summary)


class CaseUnenqueued(Base):
    """Three answers the sync never appended to the inbox: no route, no alarm, no trace."""

    def test_three_unenqueued_answers_are_a_count_and_never_silence(self):
        qids = ["q-unenqueued-%d" % n for n in (1, 2, 3)]
        rows = store(*[answer(q, "2026-11-18T13:00:00Z") for q in qids],
                     questions={ASKER: [question(q) for q in qids]})
        summary, lines = self.reconcile(rows, inbox=[], outbox=[], routed=())
        self.assertEqual((summary["answers"], summary["unrouted"], summary["routed"]), (3, 3, 0), summary)
        self.assertEqual(sorted(l.split(" id=")[1].split()[0] for l in lines), qids)
        for line in lines:
            self.assertIn("reason=never-enqueued", line)
            self.assertIn("no inbox row", line)

    def test_the_same_three_are_not_alarmed_before_the_grace_window(self):
        """A fresh answer has not failed yet: the sync runs every 5 minutes (SUCCESS is 15)."""
        rows = store(*[answer("q-fresh-%d" % n, "2026-11-18T13:55:00Z") for n in (1, 2, 3)],
                     questions={ASKER: [question("q-fresh-%d" % n) for n in (1, 2, 3)]})
        summary, lines = self.reconcile(rows, inbox=[], outbox=[], routed=())
        self.assertEqual((summary["young"], summary["unrouted"], lines), (3, 0, []), summary)


class CaseAnswers49(Base):
    """answers:49 was a challenge (a negative with a question in it) that sat unread in the alarm until a close
    removed its question row."""

    CHALLENGE = "a challenge, with a question? (synthetic text)"

    def test_a_challenge_is_a_decision_even_after_its_question_row_is_gone(self):
        row = inbox_row("q-answers-49", "2026-11-18T12:32:48Z", ans="no", comment=self.CHALLENGE)
        self.assertTrue(rw.answer_route_required(row))
        self.assertEqual(rw.classify(self.CHALLENGE, "no"), ("decision", "answer:no"))
        self.assertEqual(rw.classify(self.CHALLENGE, "no", question=False), ("decision", "answer:no"),
                         "a negative with text is never an acknowledgement")

    def test_the_close_does_not_drop_the_route_from_the_ledger(self):
        rows = store(answer("q-answers-49", "2026-11-18T12:32:48Z", ans="no", comment=self.CHALLENGE),
                     questions={})   # the close removed the row: open_q is empty
        pending = [route_row("q-answers-49", 49)]
        summary, lines = self.reconcile(rows, inbox=[inbox_row("q-answers-49", "2026-11-18T12:32:48Z",
                                                              ans="no", comment=self.CHALLENGE)],
                                        outbox=pending)
        self.assertEqual((summary["unrouted"], summary["pending"], summary["routed"]), (0, 1, 1), summary)
        self.assertEqual(lines, [])
        summary, _ = self.reconcile(rows, inbox=[], outbox=[route_row("q-answers-49", 49, delivered=True)])
        self.assertEqual((summary["unrouted"], summary["pending"]), (0, 0), summary)

    def test_an_unrouted_challenge_after_the_close_is_still_alarmed(self):
        rows = store(answer("q-answers-49", "2026-11-18T12:32:48Z", ans="no", comment=self.CHALLENGE),
                     questions={})
        summary, lines = self.reconcile(rows, inbox=[], outbox=[])
        self.assertEqual(summary["unrouted"], 1, summary)
        self.assertIn("question=closed", lines[0])
        self.assertIn("reason=never-enqueued", lines[0])


class Controls(Base):
    def test_negative_a_single_ok_with_no_open_question_produces_no_route(self):
        rows = store(answer("q-closed", "2026-11-18T12:00:00Z", ans="ok"), questions={})
        self.write(self.inbox_path, [inbox_row("q-closed", "2026-11-18T12:00:00Z", ans="ok",
                                               delivered="xtmux:example-repo-xt-claude-manager",
                                               question_open=False)])
        rc, out = self.route()
        self.assertEqual(rc, 0)
        self.assertEqual(self.outbox(), [], out)
        self.assertNotIn("ROUTE-DECISION", out)
        summary, lines = self.reconcile(rows)
        self.assertEqual((summary["unrouted"], lines), (0, []), summary)

    def test_positive_a_bare_yes_to_an_open_question_is_routed_to_the_asker(self):
        """Through the sync first: its inbox row carries question_open and the asker, then the route names it."""
        saved = (ts.INBOX, ts.deliver, ts.DRY)
        self.addCleanup(lambda: (setattr(ts, "INBOX", saved[0]), setattr(ts, "deliver", saved[1]),
                                 setattr(ts, "DRY", saved[2])))
        ts.INBOX, ts.DRY = self.inbox_path, False
        ts.deliver = lambda owner, text, *a, **kw: "xtmux:example-repo-xt-claude-%s" % owner
        live = {p: (None, doc) for p, doc in
                store(answer("q-open", "2026-11-18T13:50:00Z"),
                      questions={ASKER: [question("q-open")]}).items()}
        state = {}
        self.assertEqual(ts.route_answers(live, state), 1)
        entry = self.inbox()[0]
        self.assertIs(entry["question_open"], True)
        self.assertEqual(state["routed_answer_ids"], ["q-open"])
        rc, out = self.route()
        self.assertEqual(rc, 0)
        self.assertEqual([(r["key"], r["owner"], r["trigger"]) for r in self.outbox()],
                         [("q-open", ASKER, "answer:yes")])
        self.assertIn("--to " + ASKER, out)

    def test_a_file_only_owner_with_no_recorded_delivery_needs_a_route(self):
        """The lane reads status_board_file_only itself: for such an owner the inbox line IS the delivery."""
        saved = ra.FILE_ONLY
        self.addCleanup(setattr, ra, "FILE_ONLY", saved)
        ra.FILE_ONLY = {"manager"}
        rows = store(answer("q-manager", "2026-11-18T08:05:00Z"), questions={})
        entry = inbox_row("q-manager", "2026-11-18T08:05:00Z", owner="manager")
        entry.pop("delivered", None)
        summary, lines = self.reconcile(rows, inbox=[entry], outbox=[])
        self.assertEqual(summary["unrouted"], 1, summary)
        self.assertIn("reason=file-only-no-route", lines[0])
        ra.FILE_ONLY = set()
        summary, lines = self.reconcile(rows, inbox=[entry], outbox=[])
        self.assertEqual((summary["unrouted"], lines), (0, []), summary)

    def test_read_store_fails_closed_on_a_record_it_cannot_place(self):
        """One record without a path is a store we cannot enumerate: UNMEASURED, not a smaller count."""
        class Resp:
            def __init__(self, body):
                self.body = body

            def read(self):
                return self.body

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        key = os.path.join(self.lane, "credentials")
        with open(key, "w") as fh:
            fh.write("k")
        saved = (ra.urllib.request.urlopen, ra.KEY_FILE, ra.StoreUnreadable)
        self.addCleanup(lambda: (setattr(ra.urllib.request, "urlopen", saved[0]),
                                 setattr(ra, "KEY_FILE", saved[1])))
        ra.KEY_FILE = key
        body = json.dumps({"records": [{"data": {"doc": json.dumps({"answer": "yes"})}}]}).encode()
        ra.urllib.request.urlopen = lambda req, timeout=0: Resp(body)
        with self.assertRaises(ra.StoreUnreadable):
            ra.read_store()
        body = json.dumps({"records": [{"data": {"path": "answers/q-1",
                                                 "doc": json.dumps({"answer": "yes", "at": "2026-11-18T12:00Z"})}}],
                           "nextCursor": None}).encode()
        ra.urllib.request.urlopen = lambda req, timeout=0: Resp(body)
        self.assertEqual(sorted(ra.read_store()), ["answers/q-1"])

    def test_an_ack_clear_the_alarm_and_needs_a_destination(self):
        """An alarm that cannot be cleared is noise: a hand delivery is recorded as a delivered route."""
        rows = store(answer("q-answers-25", "2026-11-18T08:05:00Z"),
                     questions={ASKER: [question("q-answers-25")]})
        saved = (ra.read_store, ra.STATE_FILE, ra.OUTBOX)
        self.addCleanup(lambda: (setattr(ra, "read_store", saved[0]), setattr(ra, "STATE_FILE", saved[1]),
                                 setattr(ra, "OUTBOX", saved[2])))
        ra.read_store = lambda: rows
        ra.STATE_FILE = os.path.join(self.lane, "state.json")
        ra.OUTBOX = self.outbox_path
        # Hermetic: main() must read this test's inbox, never the host's.
        self.assertEqual(str(ra.lanecfg.pm_config.answers_inbox()), self.inbox_path)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = ra.main([])
        self.assertEqual(rc, 1, out.getvalue())
        self.assertIn("unrouted=1", out.getvalue())
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(ra.main(["--ack", "q-answers-25"]), 3)
        self.assertEqual(self.outbox(), [], "an ack without a destination writes nothing")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(ra.main(["--ack", "q-answers-25", "--to", ASKER]), 0)
        self.assertEqual([(r["key"], r["to"], r["delivered"]) for r in self.outbox()],
                         [("q-answers-25", ASKER, True)])
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(ra.main([]), 0)
        self.assertIn("unrouted=0", out.getvalue())

    def test_an_unreadable_store_reports_unmeasured_and_never_zero(self):
        def boom():
            raise ra.StoreUnreadable("list failed: HTTP 503")
        saved = (ra.read_store, ra.read_jsonl, ra.STATE_FILE, ra.OUTBOX)
        self.addCleanup(lambda: (setattr(ra, "read_store", saved[0]), setattr(ra, "read_jsonl", saved[1]),
                                 setattr(ra, "STATE_FILE", saved[2]), setattr(ra, "OUTBOX", saved[3])))
        ra.read_store = boom
        ra.STATE_FILE = os.path.join(self.lane, "state.json")
        ra.OUTBOX = self.outbox_path
        self.assertEqual(str(ra.lanecfg.pm_config.answers_inbox()), self.inbox_path)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = ra.main([])
        text = out.getvalue()
        self.assertEqual(rc, 2, text)
        self.assertIn("result=UNMEASURED", text)
        self.assertIn("unrouted=UNMEASURED", text)
        self.assertNotIn("unrouted=0", text)


class Window(Base):
    """The reconcile window: four disjoint buckets, the history skip, the line cap and the lookback clamp.

    Each assertion fails when its rule is removed: the partition test dies if history or young stop being
    buckets, the history test dies if the skip goes, the cap test dies if MAX_LINES stops applying.
    """

    def setUp(self):
        super().setUp()
        saved = ra.SEED_AT
        self.addCleanup(setattr, ra, "SEED_AT", saved)
        ra.SEED_AT = "2026-11-01T00:00:00Z"   # the history case is older than the module seed
        self.saved_lookback = ra.LOOKBACK_H

    def tearDown(self):
        ra.LOOKBACK_H = self.saved_lookback

    def mixed(self):
        """One answer per bucket: an accounted one, an unrouted one, a young one and a history one."""
        rows = store(answer("q-routed", "2026-11-18T13:00:00Z"),
                     answer("q-lost", "2026-11-18T13:00:00Z"),
                     answer("q-fresh", "2026-11-18T13:59:00Z"),
                     answer("q-old", "2026-11-16T10:00:00Z"),
                     questions={ASKER: [question(q) for q in ("q-routed", "q-lost", "q-fresh", "q-old")]})
        inbox = [inbox_row("q-routed", "2026-11-18T13:00:00Z",
                           delivered="xtmux:example-repo-xt-claude-" + ASKER)]
        return rows, inbox

    def test_the_four_buckets_partition_the_population(self):
        rows, inbox = self.mixed()
        summary, lines = self.reconcile(rows, inbox=inbox)
        self.assertEqual(summary["answers"], 4, summary)
        self.assertEqual((summary["routed"], summary["unrouted"], summary["young"], summary["history"]),
                         (1, 1, 1, 1), summary)
        self.assertEqual(summary["answers"],
                         summary["routed"] + summary["unrouted"] + summary["young"] + summary["history"])
        self.assertEqual([l.split(" id=")[1].split()[0] for l in lines], ["q-lost"], lines)

    def test_an_answer_older_than_the_watermark_but_inside_the_lookback_is_alarmed(self):
        """The pre-fix backlog: marked routed, delivered nowhere, newer than 24 h — it must still alarm."""
        rows = store(answer("q-new", "2026-11-18T13:50:00Z"),
                     answer("q-backlog", "2026-11-18T08:05:00Z"),
                     questions={ASKER: [question("q-new"), question("q-backlog")]})
        inbox = [inbox_row("q-new", "2026-11-18T13:50:00Z", delivered="xtmux:example-repo-xt-claude-x")]
        summary, lines = self.reconcile(rows, inbox=inbox)
        self.assertEqual((summary["history"], summary["unrouted"]), (0, 1), summary)
        self.assertIn("id=q-backlog", lines[0])

    def test_an_answer_older_than_the_watermark_and_the_lookback_is_history(self):
        rows, inbox = self.mixed()
        summary, lines = self.reconcile(rows, inbox=inbox)
        self.assertEqual(summary["history"], 1, summary)
        self.assertFalse([l for l in lines if "q-old" in l], lines)
        ra.LOOKBACK_H = 72      # the same answer is now inside the lookback: the skip must let it through
        summary, lines = self.reconcile(rows, inbox=inbox)
        self.assertEqual((summary["history"], summary["unrouted"]), (0, 2), summary)
        self.assertTrue([l for l in lines if "q-old" in l], lines)

    def test_the_line_cap_keeps_the_count_exact(self):
        qids = ["q-lost-%02d" % n for n in range(25)]
        rows = store(*[answer(q, "2026-11-18T13:00:00Z") for q in qids],
                     questions={ASKER: [question(q) for q in qids]})
        summary, lines = self.reconcile(rows, inbox=[], outbox=[])
        self.assertEqual(summary["unrouted"], 25, summary)
        self.assertEqual(len(lines), ra.MAX_LINES + 1, len(lines))
        self.assertEqual(len([l for l in lines if l.startswith("ANSWER-UNROUTED ")]), ra.MAX_LINES)
        self.assertIn("suppressed=5", lines[-1])

    def test_a_short_lookback_is_clamped_to_the_grace_and_a_bad_value_falls_back(self):
        saved = ra.lanecfg.get
        self.addCleanup(setattr, ra.lanecfg, "get", saved)
        ra.lanecfg.get = lambda name, default=None, **kw: "0.1"
        hours, note = ra._lookback()
        self.assertEqual(hours, ra.GRACE_MIN / 60.0)
        self.assertIn("below the 15 min grace", note)
        ra.lanecfg.get = lambda name, default=None, **kw: "not-a-number"
        self.assertEqual(ra._lookback()[0], ra.DEFAULT_LOOKBACK_H)
        self.assertIn("not a number", ra._lookback()[1])
        ra.lanecfg.get = lambda name, default=None, **kw: ""
        self.assertEqual(ra._lookback(), (ra.DEFAULT_LOOKBACK_H, ""))


if __name__ == "__main__":
    unittest.main()
