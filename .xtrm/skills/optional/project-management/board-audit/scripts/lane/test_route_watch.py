"""The router's classification of a bare answer, and the parent-question read of a Jira reply.

Regression (MMD-2331 seq 3817): 47 answers were recorded, 46 stamped delivered=file-only, and the operator's YES
to q-publish-w2, q-band4-551 and the w-ISSUE-* answers reached nobody. One layer was this router: the DECISION list
ends with an ACK regex that eats a bare "yes", so an answer to an open question was filed as idle acknowledgement.

Cases:
  1 a bare "yes" on the answers channel                      -> DECISION (answer:yes)
  2 a bare "yes" typed in prose as the answer to a question  -> DECISION (answer-to-question)
  3 a bare "thanks" on an ordinary Jira comment              -> ACK, unchanged
  4 a bare "yes" with no question context (an old row)       -> ACK, unchanged
  5 main(): a bare-yes answers row reaches the outbox        -> ROUTE-DECISION, trigger=answer:yes
  6 a reply under a comment the bot posted as a question     -> the bare yes is a DECISION
  7 a reply under an operator comment                        -> not a question, the yes stays an ACK

Run: python3 -m pytest -q test_route_watch.py   (or python3 test_route_watch.py)
No network, no Jira, no agent host: the module import only needs the settings below.
"""
import importlib.util
import json
import os
import tempfile
import unittest
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
# Neutral settings, set before the import: route-watch.py resolves the lane directory and the two channel paths
# at import time. PM_CONFIG points at a missing file so the operator's own config never leaks in.
os.environ.update({
    "PM_CONFIG": os.path.join(tempfile.gettempdir(), "route-watch-test-no-config.json"),
    "PM_LANE_DIR": tempfile.mkdtemp(prefix="route-watch-test-lane-"),
    "PM_REPO_DIR": "/srv/example-repo", "PM_REPO_SLUG": "example-org/example-repo",
    "PM_REPO_NAME": "example-repo", "PM_JIRA_PROJECT": "PROJ", "PM_SB_PREFIX": "TASK",
    "PM_EPIC": "TASK-1", "PM_CI_WORKFLOW": "ci.yml",
    "PM_OPERATOR_ACCOUNT_ID": "op-1", "PM_OPERATOR_NAME": "Dawid",
})


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


rw = load("route_watch_under_test", os.path.join(HERE, "route-watch.py"))
rj = load("route_jira_under_test", os.path.join(HERE, "route-jira.py"))


def adf(text):
    return {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]}


class Classify(unittest.TestCase):
    def test_1_a_bare_yes_on_the_answers_channel_is_a_decision(self):
        self.assertEqual(rw.classify("", "yes", question=True), ("decision", "answer:yes"))

    def test_2_a_bare_yes_answering_a_question_is_a_decision(self):
        self.assertEqual(rw.classify("yes", None, question=True), ("decision", "answer-to-question"))
        self.assertEqual(rw.classify("Later.", None, question=True), ("decision", "answer-to-question"))

    def test_3_a_bare_thanks_on_an_ordinary_comment_is_still_an_ack(self):
        self.assertEqual(rw.classify("thanks", None), ("info", "ack"))
        self.assertEqual(rw.classify("thanks", None, question=True), ("info", "ack"))

    def test_4_a_bare_yes_without_a_question_is_still_an_ack(self):
        self.assertEqual(rw.classify("yes", None), ("info", "ack"))
        self.assertEqual(rw.classify("", "yes"), ("info", "ack:yes"))


class MainRoutesTheAnswer(unittest.TestCase):
    def setUp(self):
        self.saved = {k: getattr(rw, k) for k in ("CHANNELS", "CURSOR", "OUTBOX")}
        self.addCleanup(lambda: [setattr(rw, k, v) for k, v in self.saved.items()])
        lane = tempfile.mkdtemp(prefix="route-watch-test-run-")
        inbox = os.path.join(lane, "bot-inbox.jsonl")
        answers = os.path.join(lane, "answers-inbox.jsonl")
        open(inbox, "w").close()
        with open(answers, "w") as fh:
            fh.write(json.dumps({"qid": "q-publish-w2", "owner": "operator-waiting",
                                 "at": "2026-11-17T21:08Z", "answer": "yes", "comment": "",
                                 "by": "Dawid", "delivered": "file-only"}) + "\n")
        rw.CHANNELS = {"inbox": inbox, "answers": answers}
        rw.CURSOR = os.path.join(lane, "route-cursor.json")
        rw.OUTBOX = os.path.join(lane, "pending-routes.jsonl")
        # A recorded cursor, not a first run: the first pass takes a baseline and the past is history.
        with open(rw.CURSOR, "w") as fh:
            json.dump({"inbox": 0, "answers": 0}, fh)

    def test_5_a_bare_yes_answers_row_reaches_the_outbox_as_a_decision(self):
        self.assertEqual(rw.main(), 0)
        rows = [json.loads(line) for line in open(rw.OUTBOX) if line.strip()]
        self.assertEqual(len(rows), 1, rows)
        self.assertEqual(rows[0]["trigger"], "answer:yes")
        self.assertEqual(rows[0]["key"], "q-publish-w2")


class JiraReplyUnderAQuestion(unittest.TestCase):
    """A reply carries parentId; the parent is the question the bot asked."""

    def setUp(self):
        self.saved = (rj.jira, rj.OPERATOR_IDS, rj.OPERATOR_NAMES)
        self.addCleanup(lambda: (setattr(rj, "jira", self.saved[0]), setattr(rj, "OPERATOR_IDS", self.saved[1]),
                                 setattr(rj, "OPERATOR_NAMES", self.saved[2])))
        rj.OPERATOR_IDS = {"op-1"}
        rj.OPERATOR_NAMES = {"dawid"}

    def bot_question(self, text="Do we delete the remaining 173 days?"):
        return {"author": {"accountId": "bot-1", "displayName": "xtrm-bot"}, "body": adf(text)}

    def test_6_a_bare_yes_under_a_bot_question_is_a_decision(self):
        parent = self.bot_question()
        rj.jira = SimpleNamespace(call=lambda method, url: (200, parent))
        cm = {"parentId": "18458", "body": adf("yes")}
        self.assertTrue(rj.parent_asks_question("PROJ-706", cm, {}))
        self.assertEqual(rw.classify("yes", None, question=rj.parent_asks_question("PROJ-706", cm, {})),
                         ("decision", "answer-to-question"))

    def test_7_a_reply_under_an_operator_comment_is_not_a_question(self):
        parent = {"author": {"accountId": "op-1", "displayName": "Dawid"}, "body": adf("shall we?")}
        rj.jira = SimpleNamespace(call=lambda method, url: (200, parent))
        cm = {"parentId": "18447"}
        self.assertFalse(rj.parent_asks_question("PROJ-356", cm, {}))
        self.assertEqual(rw.classify("yes", None, question=False), ("info", "ack"))
        self.assertFalse(rj.parent_asks_question("PROJ-356", {"body": adf("yes")}, {}))


class OpenQuestionGate(unittest.TestCase):
    """MMD-5389: a bare answer is routed only while the question is open; a closed one stays noise.

    The sync now writes `question_open` on every answers-inbox row. Without it (a row written before the fix) the
    answer is still forwarded: an unknown state is not a closed question.
    """

    def test_8_a_bare_ok_on_a_closed_question_needs_no_route(self):
        row = {"qid": "q-done", "owner": "operator-waiting", "answer": "ok", "comment": "",
               "delivered": "xtmux:example-repo-xt-claude-manager", "question_open": False}
        self.assertFalse(rw.answer_route_required(row))
        self.assertEqual(rw.classify("", "ok", question=rw.answer_route_required(row)), ("info", "ack:ok"))

    def test_9_a_bare_yes_on_an_open_question_is_routed(self):
        row = {"qid": "q-open", "owner": "operator-waiting", "answer": "yes", "comment": "",
               "delivered": "file-only", "question_open": True}
        self.assertTrue(rw.answer_route_required(row))
        self.assertEqual(rw.classify("", "yes", question=True), ("decision", "answer:yes"))

    def test_10_a_pre_fix_row_with_no_question_state_is_forwarded(self):
        """The 46 file-only answers written before the fix carry no question_open; they are the backlog."""
        row = {"qid": "q-old", "owner": "operator-waiting", "answer": "yes", "comment": "",
               "delivered": "file-only"}
        self.assertTrue(rw.answer_route_required(row))
        row.pop("delivered")
        self.assertTrue(rw.answer_route_required(row), "no recorded state is not a closed question")

    def test_11_a_file_only_delivery_is_routed_even_when_the_question_is_closed(self):
        """For a file_only target the sync sends nothing: the inbox line is the whole delivery, so route it."""
        row = {"qid": "q-manager", "owner": "manager", "answer": "no", "comment": "",
               "delivered": "file-only", "question_open": False}
        self.assertTrue(rw.answer_route_required(row))
        row["delivered"] = "xtmux:example-repo-xt-claude-manager"
        self.assertFalse(rw.answer_route_required(row), "a transport delivery needs no second route")


class MainGateAndOwner(unittest.TestCase):
    """main(): the gate suppresses a closed-question ack, and a routed answer names its asker."""

    def setUp(self):
        self.saved = {k: getattr(rw, k) for k in ("CHANNELS", "CURSOR", "OUTBOX")}
        self.addCleanup(lambda: [setattr(rw, k, v) for k, v in self.saved.items()])
        self.lane = tempfile.mkdtemp(prefix="route-watch-test-gate-")
        inbox = os.path.join(self.lane, "bot-inbox.jsonl")
        self.answers = os.path.join(self.lane, "answers-inbox.jsonl")
        open(inbox, "w").close()
        rw.CHANNELS = {"inbox": inbox, "answers": self.answers}
        rw.CURSOR = os.path.join(self.lane, "route-cursor.json")
        rw.OUTBOX = os.path.join(self.lane, "pending-routes.jsonl")
        with open(rw.CURSOR, "w") as fh:
            json.dump({"inbox": 0, "answers": 0}, fh)

    def write(self, *rows):
        with open(self.answers, "w") as fh:
            for r in rows:
                fh.write(json.dumps(r) + "\n")

    def outbox(self):
        return [json.loads(line) for line in open(rw.OUTBOX) if line.strip()] if os.path.exists(rw.OUTBOX) else []

    def test_12_a_single_ok_with_no_open_question_produces_no_route(self):
        self.write({"qid": "q-closed", "owner": "operator-waiting", "at": "2026-11-18T12:00Z",
                    "answer": "ok", "comment": "", "by": "Dawid",
                    "delivered": "xtmux:example-repo-xt-claude-manager", "question_open": False})
        self.assertEqual(rw.main(), 0)
        self.assertEqual(self.outbox(), [], "a closed-question ack is noise, not a route")

    def test_13_a_bare_yes_to_an_open_question_is_routed_to_the_asker(self):
        self.write({"qid": "q-answers-25", "owner": "MMD-4915-infra-lead-2", "at": "2026-11-18T12:00Z",
                    "answer": "yes", "comment": "", "by": "Dawid",
                    "delivered": "file-only", "question_open": True})
        self.assertEqual(rw.main(), 0)
        rows = self.outbox()
        self.assertEqual(len(rows), 1, rows)
        self.assertEqual(rows[0]["key"], "q-answers-25")
        self.assertEqual(rows[0]["owner"], "MMD-4915-infra-lead-2")
        self.assertEqual(rows[0]["trigger"], "answer:yes")


if __name__ == "__main__":
    unittest.main()
