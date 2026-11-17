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


if __name__ == "__main__":
    unittest.main()
