"""Tests for post-guard.py, with a mocked Jira HTTP layer. No network, no Jira, no credentials.

Run: python3 -m unittest skills/optional/project-management/project-management/scripts/test_post_guard.py

The three --reply-to controls, each test red when its control is removed:
  1. test_reply_posts_parent_id_and_reads_it_back          -> the parentId in the POST and on the read-back
  2. test_reply_to_a_comment_of_another_issue_is_refused   -> the foreign-ticket refusal, before any write
  3. test_reply_to_a_missing_comment_is_refused_with_the_id -> the unknown-id refusal, with the id in the text
Plus: the flat post still carries no parentId and --mention-first is unchanged, and the guard states that
--reply-to conflicts with --update.

Regression: c16823 (2026-11-03) — the operator asked that a comment answering another comment attach
to it, as a threaded reply, instead of starting a flat entry in the list.
"""
import importlib.util
import io
import json
import os
import re
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
# Neutral instance settings, set before the import: post-guard.py reads them at module load through pm_config.
# PM_CONFIG points at a file that does not exist, so a real config on this host never leaks into the test.
os.environ.update({
    "PM_CONFIG": os.path.join(tempfile.gettempdir(), "post-guard-test-no-config.json"),
    "JIRA_SITE": "https://example.invalid",
    "PM_JIRA_PROJECT": "PROJ",
    "PM_SB_PREFIX": "SB",
    "PM_REPO_SLUG": "example-org/example-repo",
    "PM_OPERATOR_EMAIL": "operator@example.invalid",
    "PM_OPERATOR_ACCOUNT_ID": "acct-operator",
    "PM_OPERATOR_NAME": "Operator",
})
spec = importlib.util.spec_from_file_location("post_guard", os.path.join(HERE, "post-guard.py"))
pg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pg)

KEY = "PROJ-198"
ISSUE_ID = "11846"
OTHER_KEY = "PROJ-552"
OTHER_ID = "12423"


def comment(cid, issue_id=ISSUE_ID, text="a comment", parent=None, author="Operator"):
    return {"id": str(cid),
            "self": f"https://example.invalid/rest/api/3/issue/{issue_id}/comment/{cid}",
            "parentId": parent,
            "author": {"displayName": author, "accountId": "acct-1"},
            "body": {"type": "doc", "version": 1,
                     "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]}}


class FakeJira:
    """The reads post-guard makes, plus one POST path. Every write is recorded in .posts."""

    def __init__(self, existing=(), on_issue=(16823,), updated="2026-11-02T10:00:00.000+0000",
                 drop_parent=False, bulk_status=200):
        self.existing = {str(c["id"]): c for c in existing}
        self.on_issue = [str(c) for c in on_issue]
        self.updated = updated
        # drop_parent models a Jira that accepted the POST but stored the comment flat: the read-back must fail.
        self.drop_parent = drop_parent
        self.bulk_status = bulk_status
        self.posts = []
        self.post_paths = []
        self.next_id = 17000
        self.calls = []

    # -- routing -------------------------------------------------------------------------------------
    def call(self, method, path, body=None):
        self.calls.append((method, path, body))
        route = path.split("?")[0]
        if method == "GET" and re.fullmatch(r"/rest/api/3/issue/[^/]+", route):
            key = route.rsplit("/", 1)[1]
            if key == KEY:
                return 200, {"id": ISSUE_ID, "key": KEY,
                             "fields": {"status": {"name": "In Progress"}, "labels": ["substrate:SB-1"],
                                        "updated": self.updated}}
            if key == OTHER_ID:
                return 200, {"id": OTHER_ID, "key": OTHER_KEY,
                             "fields": {"status": {"name": "In Progress"}, "labels": [], "updated": self.updated}}
            return 404, {"errorMessages": ["no such ticket"]}
        if method == "GET" and re.fullmatch(r"/rest/api/3/issue/[^/]+/comment", route):
            newest_first = sorted(self.on_issue, key=int, reverse=True)[:5]
            return 200, {"comments": [self.existing[c] for c in newest_first if c in self.existing]}
        if method == "GET" and re.fullmatch(r"/rest/api/3/issue/[^/]+/comment/\d+", route):
            key, cid = route.split("/issue/", 1)[1].split("/comment/")
            found = self.existing.get(cid)
            # Jira scopes this route by ticket: a comment of another ticket reads as absent here.
            if found and key == KEY and str(cid) in self.on_issue:
                return 200, found
            return 404, {"errorMessages": ["Non e stato trovato nessun commento con l'ID dato"]}
        if method == "POST" and route == "/rest/api/3/comment/list":
            if self.bulk_status != 200:
                return self.bulk_status, {"errorMessages": ["bulk read unavailable"]}
            ids = [str(i) for i in (body or {}).get("ids", [])]
            values = [self.existing[i] for i in ids if i in self.existing]
            return 200, {"values": values, "total": len(values)}
        if method == "POST" and re.fullmatch(r"/rest/api/3/issue/[^/]+/comment", route):
            self.post_paths.append(route)
            self.posts.append(body)
            cid = str(self.next_id)
            self.next_id += 1
            created = {"id": cid,
                       "self": f"https://example.invalid/rest/api/3/issue/{ISSUE_ID}/comment/{cid}",
                       "parentId": None if self.drop_parent else (body or {}).get("parentId"),
                       "author": {"displayName": "xtrm-bot", "accountId": "acct-bot"},
                       "body": (body or {}).get("body")}
            self.existing[cid] = created
            self.on_issue.append(cid)
            return 201, created
        raise AssertionError(f"unexpected call {method} {path}")


class ReplyToTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="post-guard-test-")
        self.text = os.path.join(self.dir, "comment.txt")
        self.write("A short answer to the question above.")
        self.env = mock.patch.dict(os.environ, {"SUBSTRATE_HOLDER": "SB-3665-reply-to",
                                                "POST_GUARD_RUN_FILE": ""}, clear=False)
        self.env.start()
        os.environ.pop("POST_GUARD_RUN_FILE", None)
        os.environ.pop("POST_GUARD_OWN_WRITES", None)

    def tearDown(self):
        self.env.stop()

    def write(self, text):
        with open(self.text, "w", encoding="utf-8") as fh:
            fh.write(text)

    def run_guard(self, fake, *extra):
        argv = ["post-guard.py", KEY, self.text, "--run", "B999", *extra]
        out = io.StringIO()
        with mock.patch.object(pg.J, "call", fake.call), mock.patch.object(sys, "argv", argv):
            with redirect_stdout(out):
                rc = pg.main()
        return rc, out.getvalue()

    # -- control 1: the parentId is sent and proven on the read-back ---------------------------------
    def test_reply_posts_parent_id_and_reads_it_back(self):
        target = comment(16823, text="the question")
        fake = FakeJira(existing=[target], on_issue=[16823])
        rc, out = self.run_guard(fake, "--reply-to", "16823")
        self.assertEqual(rc, 0, out)
        self.assertEqual(len(fake.posts), 1, out)
        self.assertEqual(fake.posts[0]["parentId"], 16823)
        self.assertIn("reply: parentId=16823 target=16823 ok_parent=True", out)

    def test_reply_accepts_the_c_prefixed_id_the_project_writes(self):
        fake = FakeJira(existing=[comment(16823)], on_issue=[16823])
        rc, out = self.run_guard(fake, "--reply-to", "c16823")
        self.assertEqual(rc, 0, out)
        self.assertEqual(fake.posts[0]["parentId"], 16823)

    def test_a_reply_jira_stored_flat_fails_the_read_back(self):
        # The read-back is the control that catches a parentId the API accepted but did not store.
        fake = FakeJira(existing=[comment(16823)], on_issue=[16823], drop_parent=True)
        rc, out = self.run_guard(fake, "--reply-to", "16823")
        self.assertEqual(len(fake.posts), 1, out)
        self.assertEqual(fake.posts[0]["parentId"], 16823, "the POST still carried the parentId")
        self.assertEqual(rc, 5, out)
        self.assertIn("ok_parent=False", out)

    def test_a_reply_is_read_back_by_its_own_id_not_by_the_comment_list(self):
        fake = FakeJira(existing=[comment(16823)], on_issue=[16823])
        rc, out = self.run_guard(fake, "--reply-to", "16823")
        self.assertEqual(rc, 0, out)
        reads = [path for method, path, _ in fake.calls if method == "GET" and "/comment/" in path]
        self.assertEqual(len(reads), 2, fake.calls)  # the target before the write, the reply after it

    # -- control 2: a comment of another ticket is refused before the write -------------------------
    def test_reply_to_a_comment_of_another_issue_is_refused(self):
        foreign = comment(16823, issue_id=OTHER_ID, text="not on this ticket")
        fake = FakeJira(existing=[foreign], on_issue=[])
        rc, out = self.run_guard(fake, "--reply-to", "16823")
        self.assertEqual(rc, 10, out)
        self.assertEqual(fake.posts, [], "a refused reply must write nothing")
        self.assertIn("REFUSED --reply-to", out)
        self.assertIn("16823", out)
        self.assertIn(OTHER_KEY, out)
        self.assertIn(f"not {KEY}", out)

    # -- control 3: an unknown id is refused, with the id in the message ----------------------------
    def test_reply_to_a_missing_comment_is_refused_with_the_id(self):
        fake = FakeJira(existing=[comment(16823)], on_issue=[16823])
        rc, out = self.run_guard(fake, "--reply-to", "99999999999")
        self.assertEqual(rc, 10, out)
        self.assertEqual(fake.posts, [], "a refused reply must write nothing")
        self.assertIn("99999999999", out)
        self.assertIn("does not exist", out)

    def test_a_bulk_read_failure_is_named_and_writes_nothing(self):
        # An unreadable answer is not "no such comment": the id may be fine and the read is what failed.
        foreign = comment(16823, issue_id=OTHER_ID)
        fake = FakeJira(existing=[foreign], on_issue=[], bulk_status=503)
        rc, out = self.run_guard(fake, "--reply-to", "16823")
        self.assertEqual(rc, 10, out)
        self.assertEqual(fake.posts, [])
        self.assertIn("target read failed", out)
        self.assertIn("HTTP 503", out)
        self.assertNotIn("does not exist", out)

    def test_a_superscript_id_is_refused_without_a_traceback(self):
        fake = FakeJira(existing=[comment(16823)], on_issue=[16823])
        rc, out = self.run_guard(fake, "--reply-to", "\u00b2")
        self.assertEqual(rc, 10, out)
        self.assertIn("not a comment id", out)
        self.assertEqual(fake.calls, [])

    def test_a_non_numeric_reply_to_is_refused_before_any_read(self):
        fake = FakeJira()
        rc, out = self.run_guard(fake, "--reply-to", "the comment above")
        self.assertEqual(rc, 10, out)
        self.assertEqual(fake.calls, [], "the target must be parsed before any request")
        self.assertIn("not a comment id", out)

    # -- unchanged behaviour ------------------------------------------------------------------------
    def test_flat_post_carries_no_parent_id(self):
        fake = FakeJira(existing=[comment(16823)], on_issue=[16823])
        rc, out = self.run_guard(fake)
        self.assertEqual(rc, 0, out)
        self.assertNotIn("parentId", fake.posts[0])
        self.assertNotIn("ok_parent", out)

    def test_mention_first_still_injects_one_mention_first(self):
        fake = FakeJira(existing=[comment(16823)], on_issue=[16823])
        rc, out = self.run_guard(fake, "--mention-first")
        self.assertEqual(rc, 0, out)
        body = fake.posts[0]["body"]["content"]
        self.assertEqual(body[0]["content"][0]["type"], "mention")
        self.assertIn("mention: injected the operator node at position 0 (--mention-first)", out)

    def test_reply_to_conflicts_with_update(self):
        fake = FakeJira(existing=[comment(16823)], on_issue=[16823])
        rc, out = self.run_guard(fake, "--reply-to", "16823", "--update", "16823")
        self.assertEqual(rc, 6, out)
        self.assertEqual(fake.calls, [])
        self.assertIn("use one or the other", out)

    def test_dry_run_reply_previews_the_parent_without_writing(self):
        fake = FakeJira(existing=[comment(16823)], on_issue=[16823])
        rc, out = self.run_guard(fake, "--reply-to", "16823", "--dry-run")
        self.assertEqual(rc, 0, out)
        self.assertEqual(fake.posts, [])
        self.assertIn("DRY-RUN would post (parentId=16823)", out)

    def test_dry_run_without_reply_to_prints_the_old_shape(self):
        fake = FakeJira(existing=[comment(16823)], on_issue=[16823])
        rc, out = self.run_guard(fake, "--dry-run")
        self.assertEqual(rc, 0, out)
        self.assertIn("DRY-RUN would post:\n", out)
        self.assertNotIn("parentId", out)


class VerifyReplyTargetTest(unittest.TestCase):
    """The helper on its own: the two refusals never depend on Jira's error text (this site answers in Italian)."""

    def test_localised_404_does_not_change_the_verdict(self):
        target = comment(16823, text="the question")
        fake = FakeJira(existing=[target], on_issue=[16823])
        with mock.patch.object(pg.J, "call", fake.call):
            self.assertEqual(pg.verify_reply_target(KEY, ISSUE_ID, 16823), (16823, None))
            parent, why = pg.verify_reply_target(KEY, ISSUE_ID, 99999)
            self.assertIsNone(parent)
            self.assertIn("99999", why)


class AttachTest(unittest.TestCase):
    """jira.py attach: multipart POST with X-Atlassian-Token, refused without the board-helper flag (AT-01)."""

    def setUp(self):
        self.J = pg.J
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.file = os.path.join(tmp.name, "evidence.txt")
        with open(self.file, "w") as fh:
            fh.write("deploy log line\n")
        self.sent = []
        J = self.J

        class Resp:
            status = 200

            def read(self):
                return json.dumps([{"id": "10500", "filename": "evidence.txt"}]).encode()

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def urlopen(req, *a, **k):
            self.sent.append(req)
            return Resp()
        patches = [mock.patch.object(J.urllib.request, "urlopen", urlopen),
                   mock.patch.object(J, "creds", lambda: ("bot@example.invalid", "tok")),
                   mock.patch.dict(os.environ, {}, clear=False)]
        for pt in patches:
            pt.start()
            self.addCleanup(pt.stop)
        os.environ.pop("POST_GUARD_ACTIVE", None)   # post-guard sets it at import; the CLI path has it unset

    def test_refused_without_the_flag(self):
        with redirect_stdout(io.StringIO()) as out:
            st, msg = self.J.attach(KEY, self.file)
        self.assertEqual(st, 400)
        self.assertIn("AT-01", msg)
        self.assertEqual(self.sent, [], "nothing reached Jira")

    def test_board_helper_posts_multipart_with_the_no_check_header(self):
        st, out = self.J.attach(KEY, self.file, board_helper=True)
        self.assertEqual(st, 200)
        (req,) = self.sent
        self.assertEqual(req.get_method(), "POST")
        self.assertTrue(req.full_url.endswith(f"/rest/api/3/issue/{KEY}/attachments"))
        self.assertEqual(req.get_header("X-atlassian-token"), "no-check")
        self.assertTrue(req.get_header("Content-type").startswith("multipart/form-data; boundary="))
        self.assertIn(b'name="file"; filename="evidence.txt"', req.data)
        self.assertIn(b"deploy log line", req.data)

    def test_inside_post_guard_is_allowed(self):
        os.environ["POST_GUARD_ACTIVE"] = "1"
        self.assertEqual(self.J.attach(KEY, self.file)[0], 200)

    def test_credential_shaped_text_is_refused(self):
        with open(self.file, "w") as fh:
            fh.write("token = ATATT" + "x" * 30)
        with redirect_stdout(io.StringIO()):
            st, msg = self.J.attach(KEY, self.file, board_helper=True)
        self.assertEqual(st, 400)
        self.assertIn("SC-03", msg)
        self.assertEqual(self.sent, [])

    def test_json_post_to_attachments_is_refused(self):
        with self.assertRaises(RuntimeError):
            self.J._raw_call("POST", f"/rest/api/3/issue/{KEY}/attachments", {})


if __name__ == "__main__":
    unittest.main()
