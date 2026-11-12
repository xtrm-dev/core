"""Regression tests for the MMD-3382 run assertions in tabellone_sync.py.

Run: python3 -m unittest skills/optional/project-management/tabellone-keeper/scripts/test_tabellone_sync.py
Payloads use the live schedule/<date> doc shape (events keyed e_<HHMM>_<KEY>, created_by
sync-jira, kind window) and the here.now record updatedAt. No network, no Jira, no here.now.

Regression MMD-3382: PROJ-558 was missing from Monday's schedule and only a person noticed.
"""
import contextlib
import importlib.util
import io
import os
import shutil
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
# Neutral instance settings, set before the module import reads them; PM_CONFIG points at
# a missing file so the operator's own config never leaks into the test.
os.environ.update({
    "PM_CONFIG": os.path.join(tempfile.gettempdir(), "tabellone-test-no-config.json"),
    "PM_JIRA_PROJECT": "PROJ", "PM_SB_PREFIX": "TASK", "JIRA_SITE": "https://example.atlassian.net",
    "PM_REPO_NAME": "example-repo", "PM_REPO_SLUG": "example-org/example-repo",
    "PM_TABELLONE_SITE": "example-site", "PM_TABELLONE_SELF_ISSUE": "TASK-1",
    "TABELLONE_STATE_DIR": os.path.join(tempfile.gettempdir(), "tabellone-test-state"),
})
spec = importlib.util.spec_from_file_location("tabellone_sync", os.path.join(HERE, "tabellone_sync.py"))
ts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ts)

TODAY = date(2026, 11, 1)
HI = date(2026, 11, 8)
MONDAY = "2026-11-02"


def utc(text):
    return ts.parse_ts(text)


def event(key, at, end=None, **kw):
    ev = {"at": at, "ref": key, "label": "Window " + key, "status": "scheduled", "note": "",
          "note_src": "", "kind": "window", "created_by": "sync-jira",
          "url": "https://example.atlassian.net/browse/" + key}
    if end:
        ev["end"] = end
    ev.update(kw)
    return ev


def day_doc(day, *evs, updated="2026-11-01T05:43Z"):
    return {"date": day,
            "events": {"e_%s_%s" % (e["at"][11:13] + e["at"][14:16], e["ref"]): e for e in evs},
            "updatedAt": updated, "updatedBy": "tabellone-sync"}


def row(key, day, at, end=None, updated="2026-11-01T05:00:00.000+0000"):
    return {"key": key, "day": day, "start": utc(at), "end": utc(end) if end else None,
            "updated": utc(updated), "updated_raw": updated, "created": utc("2026-10-20T08:00:00.000+0000")}


def published(*docs):
    """{path: (record updatedAt, doc)} as run_assertions receives it."""
    return {"schedule/" + d["date"]: (utc("2026-11-01T05:43:28.962Z"), d) for d in docs}


def never(_row):
    raise AssertionError("the Jira changelog must not be read for this row")


class RunAssertions(unittest.TestCase):
    def run_checks(self, rows, docs, version=("2026-11-01T05:50:00.000Z", "v2"), write_of=never, expected="rows"):
        if expected == "rows":   # the independent search saw exactly what the run placed
            expected = {r["key"]: {"start": r["start"]} for r in rows}
        return ts.assert_lines(rows, docs, (utc(version[0]), version[1]), TODAY, HI, write_of, expected)

    def test_clean_run_gives_the_count_line(self):
        d = day_doc(MONDAY, event("PROJ-558", MONDAY + "T09:07Z"), event("PROJ-559", MONDAY + "T10:00Z"))
        rows = [row("PROJ-558", MONDAY, MONDAY + "T09:07:00.000+0000"),
                row("PROJ-559", MONDAY, MONDAY + "T10:00:00.000+0000")]
        lines, failed = self.run_checks(rows, published(d))
        self.assertFalse(failed)
        self.assertEqual(lines, ["ASSERT-COUNT window-events-placed=2 distinct-refs=2 "
                                 "latest-doc-write=2026-11-01T05:43:28Z publish=2026-11-01T05:50:00Z result=OK"])

    def test_missing_ref_names_the_ref(self):
        d = day_doc(MONDAY, event("PROJ-559", MONDAY + "T10:00Z"))
        rows = [row("PROJ-558", MONDAY, MONDAY + "T09:07:00.000+0000"),
                row("PROJ-559", MONDAY, MONDAY + "T10:00:00.000+0000")]
        lines, failed = self.run_checks(rows, published(d))
        self.assertTrue(failed)
        self.assertTrue(lines[0].startswith("ASSERT-FAIL missing-event ref=PROJ-558 date=%s" % MONDAY), lines)
        self.assertIn("result=FAIL(1)", lines[-1])

    def test_missing_doc_fails(self):
        lines, failed = self.run_checks([row("PROJ-558", MONDAY, MONDAY + "T09:07:00.000+0000")], {})
        self.assertTrue(failed)
        self.assertIn("ASSERT-FAIL missing-doc ref=PROJ-558", lines[0])

    def test_a_manual_event_with_the_ref_does_not_stand_in_for_the_window(self):
        d = day_doc(MONDAY, event("PROJ-558", MONDAY + "T09:07Z", kind="handover", created_by=None))
        lines, failed = self.run_checks([row("PROJ-558", MONDAY, MONDAY + "T09:07:00.000+0000")], published(d))
        self.assertTrue(failed)

    def test_relabel_does_not_fail(self):
        d = day_doc(MONDAY, event("PROJ-558", MONDAY + "T09:07Z", label="Renamed in Jira", note="x"))
        lines, failed = self.run_checks([row("PROJ-558", MONDAY, MONDAY + "T09:07:00.000+0000")], published(d))
        self.assertFalse(failed, lines)

    def test_keeper_row_covering_the_ref_counts(self):
        ev = event("PROJ-558 + PROJ-559", MONDAY + "T09:07Z")
        d = {"date": MONDAY, "events": {"e_0907_pair": ev}, "updatedAt": "2026-11-01T05:43Z"}
        lines, failed = self.run_checks([row("PROJ-558", MONDAY, MONDAY + "T09:07:00.000+0000")], published(d))
        self.assertFalse(failed, lines)

    def test_past_and_out_of_range_rows_are_not_asserted(self):
        rows = [row("PROJ-1", "2026-10-30", "2026-10-30T09:00:00.000+0000"),
                row("PROJ-2", "2026-11-20", "2026-11-20T09:00:00.000+0000")]
        lines, failed = self.run_checks(rows, {})
        self.assertFalse(failed)

    def test_stale_doc_fails_when_jira_slot_moved_after_the_doc_write(self):
        # Jira slot moved to 09:30 at 05:50; the doc (written 05:43) still holds 09:07
        d = day_doc(MONDAY, event("PROJ-558", MONDAY + "T09:07Z"))
        r = row("PROJ-558", MONDAY, MONDAY + "T09:30:00.000+0000", updated="2026-11-01T05:50:00.000+0000")
        lines, failed = self.run_checks([r], published(d), write_of=lambda _r: utc("2026-11-01T05:50:00.000Z"))
        self.assertTrue(failed)
        self.assertIn("ASSERT-FAIL stale-doc ref=PROJ-558", lines[0])
        self.assertIn("doc-write=2026-11-01T05:43:28Z jira-slot-write=2026-11-01T05:50:00Z", lines[0])

    def test_issue_touched_by_a_comment_is_not_stale(self):
        # Jira updated 05:55 (a comment), slot written long ago: no false fail
        d = day_doc(MONDAY, event("PROJ-558", MONDAY + "T09:07Z"))
        r = row("PROJ-558", MONDAY, MONDAY + "T09:07:00.000+0000", updated="2026-11-01T05:55:00.000+0000")
        lines, failed = self.run_checks([r], published(d), write_of=lambda _r: utc("2026-10-25T08:00:00.000Z"))
        self.assertFalse(failed, lines)

    def test_slot_rewritten_to_the_same_value_is_not_stale(self):
        d = day_doc(MONDAY, event("PROJ-558", MONDAY + "T09:07Z", end=MONDAY + "T09:37Z"))
        r = row("PROJ-558", MONDAY, MONDAY + "T09:07:00.000+0000", MONDAY + "T09:37:00.000+0000",
                updated="2026-11-01T05:50:00.000+0000")
        lines, failed = self.run_checks([r], published(d), write_of=lambda _r: utc("2026-11-01T05:50:00.000Z"))
        self.assertFalse(failed, lines)

    def test_unreadable_changelog_is_reported_not_failed(self):
        d = day_doc(MONDAY, event("PROJ-558", MONDAY + "T09:07Z"))
        r = row("PROJ-558", MONDAY, MONDAY + "T09:30:00.000+0000", updated="2026-11-01T05:50:00.000+0000")
        lines, failed = self.run_checks([r], published(d), write_of=lambda _r: None)
        self.assertFalse(failed)
        self.assertTrue(lines[0].startswith("ASSERT-UNKNOWN slot-write ref=PROJ-558"))

    def test_shared_keeper_row_is_not_judged_by_one_key_slot(self):
        # one keeper event covers PROJ-1 + PROJ-2; PROJ-2's slot differs and Jira changed after the doc write
        ev = event("PROJ-1 + PROJ-2", MONDAY + "T09:07Z")
        d = {"date": MONDAY, "events": {"e_0907_pair": ev}, "updatedAt": "2026-11-01T05:43Z"}
        r = row("PROJ-2", MONDAY, MONDAY + "T09:30:00.000+0000", updated="2026-11-01T05:50:00.000+0000")
        lines, failed = self.run_checks([r], published(d), write_of=lambda _r: utc("2026-11-01T05:50:00.000Z"))
        self.assertFalse(failed, lines)

    def test_stale_publish_shows_in_the_count_line_only(self):
        d = day_doc(MONDAY, event("PROJ-558", MONDAY + "T09:07Z"))
        lines, failed = self.run_checks([row("PROJ-558", MONDAY, MONDAY + "T09:07:00.000+0000")], published(d),
                                        version=("2026-11-01T05:06:33.239Z", "01M6AR11SPB5AEK01F1515JWRC"))
        self.assertFalse(failed)
        self.assertEqual(len(lines), 1, "no separate PUBLISH-LAG line (contract rev 2)")
        self.assertIn("latest-doc-write=2026-11-01T05:43:28Z publish=2026-11-01T05:06:33Z", lines[0])

    def test_unknown_site_version_shows_unknown_publish(self):
        d = day_doc(MONDAY, event("PROJ-558", MONDAY + "T09:07Z"))
        lines, _ = ts.assert_lines([row("PROJ-558", MONDAY, MONDAY + "T09:07:00.000+0000")], published(d),
                                   (None, None), TODAY, HI, never, {"PROJ-558": {"start": utc(MONDAY + "T09:07Z")}})
        self.assertIn("publish=unknown", lines[-1])

    def test_unlabelled_key_with_a_forward_slot_is_an_unplaced_row(self):
        # PROJ-558 lost its window label: the run's own list never saw it, the independent search did
        d = day_doc(MONDAY, event("PROJ-559", MONDAY + "T10:00Z"))
        placed = [row("PROJ-559", MONDAY, MONDAY + "T10:00:00.000+0000")]
        exp = {"PROJ-559": {"start": utc(MONDAY + "T10:00Z")},
               "PROJ-558": {"start": utc(MONDAY + "T09:07Z")}}
        lines, failed = self.run_checks(placed, published(d), expected=exp)
        self.assertTrue(failed)
        self.assertTrue(lines[0].startswith("ASSERT-FAIL unplaced-row ref=PROJ-558 slot=%sT09:07Z" % MONDAY), lines)
        self.assertIn("result=FAIL(1)", lines[-1])

    def test_unreadable_expected_set_is_reported_not_failed(self):
        lines, failed = self.run_checks([], {}, expected=None)
        self.assertFalse(failed)
        self.assertTrue(lines[0].startswith("ASSERT-UNKNOWN expected-set"))


class FakeJira:
    """mod.call stand-in serving /issue/<key>/changelog pages."""
    def __init__(self, pages):
        self.pages, self.calls = pages, []

    def call(self, method, path):
        self.calls.append(path)
        n = int(path.split("startAt=")[1].split("&")[0])
        return 200, self.pages[n // 2]


def hist(created, field):
    return {"created": created, "items": [{"fieldId": field, "field": "x"}]}


class SlotWrite(unittest.TestCase):
    def test_latest_slot_item_over_pages_ignoring_other_fields(self):
        pages = [{"values": [hist("2026-10-25T08:00:00.000+0000", "customfield_10001"),
                             hist("2026-10-26T08:00:00.000+0000", "status")], "isLast": False},
                 {"values": [hist("2026-10-27T08:00:00.000+0000", "customfield_10002"),
                             hist("2026-10-28T08:00:00.000+0000", "summary")], "isLast": True}]
        mod, cache = FakeJira(pages), {}
        r = row("PROJ-558", MONDAY, MONDAY + "T09:07:00.000+0000")
        got = ts.slot_write_time(mod, {"customfield_10001", "customfield_10002"}, r, cache)
        self.assertEqual(got, utc("2026-10-27T08:00:00.000Z"))
        self.assertEqual(len(mod.calls), 2)
        # same Jira updated stamp: served from the cache, no call
        self.assertEqual(ts.slot_write_time(mod, {"customfield_10001"}, r, cache), got)
        self.assertEqual(len(mod.calls), 2)

    def test_no_slot_item_falls_back_to_created(self):
        mod = FakeJira([{"values": [hist("2026-10-26T08:00:00.000+0000", "status")], "isLast": True}])
        r = row("PROJ-558", MONDAY, MONDAY + "T09:07:00.000+0000")
        self.assertEqual(ts.slot_write_time(mod, {"customfield_10001"}, r, {}), r["created"])


class RunAssertionsNeverRaise(unittest.TestCase):
    def test_a_broken_check_is_reported_and_flags_the_run(self):
        saved = list(ts.ASSERT_ROWS)
        saved_call, saved_cache = ts.hn_call, ts.ASSERT_CACHE_FILE
        try:
            ts.ASSERT_ROWS[:] = [{"key": "PROJ-558"}]   # malformed row: the check itself breaks
            ts.hn_call = lambda *a, **k: (404, "no")
            ts.ASSERT_CACHE_FILE = os.path.join(HERE, "no-such-dir", "cache.json")
            out = []
            real = ts.print if hasattr(ts, "print") else None
            ts.print = lambda *a, **k: out.append(" ".join(str(x) for x in a))
            try:
                failed = ts.run_assertions(None, {"fields": {}}, {}, True)
            finally:
                if real is None:
                    del ts.print
            self.assertTrue(failed)
            self.assertTrue(any(ln.startswith("ASSERT-ERROR") for ln in out), out)
        finally:
            ts.ASSERT_ROWS[:] = saved
            ts.hn_call, ts.ASSERT_CACHE_FILE = saved_call, saved_cache


class ExpectedSet(unittest.TestCase):
    def test_second_search_has_no_label_filter_and_reads_the_slot_field(self):
        seen = {}

        def fake_search(mod, jql, fields="key,updated"):
            seen["jql"], seen["fields"] = jql, fields
            return [{"key": "PROJ-558", "fields": {"customfield_10001": "2026-11-02T10:07:00.000+0100",
                                                    "issuetype": {"name": "Task", "subtask": False}}},
                    {"key": "PROJ-606", "fields": {"customfield_10001": "2026-11-05T10:07:00.000+0100",
                                                    "parent": {"key": "PROJ-358"},
                                                    "issuetype": {"name": "Subtask", "subtask": True}}},
                    {"key": "PROJ-1", "fields": {"customfield_10001": "2026-12-30T10:07:00.000+0100",
                                                  "issuetype": {"name": "Task"}}},
                    {"key": "PROJ-2", "fields": {"customfield_10001": None, "issuetype": {"name": "Task"}}}]

        saved = ts.jira_search
        ts.jira_search = fake_search
        try:
            got = ts.expected_window_keys(None, {"fields": {"windowStart": "customfield_10001"}}, TODAY, HI)
        finally:
            ts.jira_search = saved
        self.assertNotIn("labels", seen["jql"])
        self.assertTrue(seen["jql"].startswith("project = PROJ AND "), seen["jql"])
        self.assertIn('cf[10001] >= "2026-11-01" AND cf[10001] <= "2026-11-08"', seen["jql"])
        # Subtask (PROJ-606), out-of-range (PROJ-1) and slotless (PROJ-2) keys are dropped
        self.assertEqual(sorted(got), ["PROJ-558"])
        self.assertEqual(got["PROJ-558"]["start"], utc("2026-11-02T09:07Z"))

    def test_epic_is_never_a_placeable_window_row(self):
        # PROJ-198 (Epic) carries the coordinator handover slot; a theme Epic is a calendar
        # entry, not a window to place, so the check must not demand that the run place it.
        def fake_search(mod, jql, fields="key,updated"):
            return [{"key": "PROJ-198", "fields": {"customfield_10001": "2026-11-04T01:00:00.000+0100",
                                                    "issuetype": {"name": "Epic", "subtask": False,
                                                                  "hierarchyLevel": 1}}},
                    {"key": "PROJ-558", "fields": {"customfield_10001": "2026-11-02T10:07:00.000+0100",
                                                    "issuetype": {"name": "Task", "subtask": False,
                                                                  "hierarchyLevel": 0}}}]

        saved = ts.jira_search
        ts.jira_search = fake_search
        try:
            got = ts.expected_window_keys(None, {"fields": {"windowStart": "customfield_10001"}}, TODAY, HI)
        finally:
            ts.jira_search = saved
        self.assertNotIn("PROJ-198", got, "an Epic must never enter the expected set")
        self.assertIn("PROJ-558", got, "a placeable type must still be checked")
        # negative control for this exclusion lives in AssertCases:
        # test_unlabelled_key_with_a_forward_slot_is_an_unplaced_row (a Task with a slot
        # that the run did not place must still FAIL).

    def test_profile_without_window_fields_gives_no_expected_set(self):
        self.assertIsNone(ts.expected_window_keys(None, {"fields": {}}, TODAY, HI))


class MainExitPath(unittest.TestCase):
    """main(): a failed check gives exit 1, after every write has been sent."""

    def run_main(self, after_docs):
        day = (datetime.now(timezone.utc).date() + timedelta(days=1)).isoformat()
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        names = ["CACHEDIR", "STATE_FILE", "DRIFT_FILE", "ASSERT_CACHE_FILE", "mem_gate", "read_hn_key",
                 "load_jira", "hn_list", "build_waiting", "build_workers", "build_prs", "load_profile",
                 "build_jira_schedule", "route_answers", "hn_call", "expected_window_keys", "DRY"]
        saved = {n: getattr(ts, n) for n in names + ["HN_KEY"]}
        saved_rows = list(ts.ASSERT_ROWS)
        published_rec = after_docs(day)
        calls, listings = [], [[], [published_rec]]
        planned = published_rec["data"]["doc"]   # the store holds what the run wrote
        rows = [row("PROJ-558", day, day + "T09:07:00.000+0000"), row("PROJ-559", day, day + "T10:00:00.000+0000")]

        def schedule(mod, view, prof):
            ts.ASSERT_ROWS[:] = rows
            return [("POST", "schedule/" + day, None, planned)], []

        def hn_call(method, url, body=None, idem=None, tries=4):
            calls.append((method, url))
            if method == "GET":
                return 200, {"currentVersionCreatedAt": "2026-11-01T05:06:33.239Z", "currentVersionId": "v1"}
            return 201, {}

        try:
            ts.CACHEDIR = tmp
            ts.STATE_FILE, ts.DRIFT_FILE = os.path.join(tmp, "state.json"), os.path.join(tmp, "drift.jsonl")
            ts.ASSERT_CACHE_FILE = os.path.join(tmp, "assert-cache.json")
            ts.mem_gate = lambda: (True, "ok")
            ts.read_hn_key = lambda: "k"
            ts.load_jira = lambda: None
            ts.hn_list = lambda: listings.pop(0)
            ts.build_waiting = ts.build_workers = ts.build_prs = lambda *a: []
            ts.load_profile = lambda mod: {"fields": {"windowStart": "customfield_10001", "windowEnd": "customfield_10002"}}
            ts.build_jira_schedule = schedule
            ts.route_answers = lambda live, state: 0
            ts.hn_call = hn_call
            ts.expected_window_keys = lambda mod, prof, today, hi: {
                r["key"]: {"start": r["start"]} for r in rows}
            ts.DRY = False
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = ts.main()
            return code, out.getvalue(), calls
        finally:
            for n, v in saved.items():
                setattr(ts, n, v)
            ts.ASSERT_ROWS[:] = saved_rows

    @staticmethod
    def record(day, *keys):
        events = {"e_0907_" + k: event(k, day + "T09:07Z") for k in keys}
        doc = {"date": day, "events": events, "updatedAt": "2026-11-01T05:43Z"}
        return {"id": "rec_1", "updatedAt": "2026-11-01T05:43:28.962Z",
                "data": {"path": "schedule/" + day, "doc": doc}}

    def test_failed_check_exits_1_with_the_writes_done(self):
        code, out, calls = self.run_main(lambda day: self.record(day, "PROJ-559"))   # PROJ-558 missing on the page
        self.assertEqual(code, 1)
        self.assertEqual([c[0] for c in calls if c[0] != "GET"], ["POST"], "the write was sent")
        self.assertIn("created 1, updated 0, deleted 0, errors 0", out)
        self.assertIn("ASSERT-FAIL missing-event ref=PROJ-558", out)
        self.assertLess(out.index("created 1"), out.index("ASSERT-FAIL"), "assertions run after the writes")
        self.assertIn("RESULT FAILED", out)

    def test_clean_run_exits_0_with_the_count_line(self):
        code, out, calls = self.run_main(lambda day: self.record(day, "PROJ-558", "PROJ-559"))
        self.assertEqual(code, 0, out)
        self.assertIn("ASSERT-COUNT window-events-placed=2 distinct-refs=2", out)
        self.assertIn("RESULT OK", out)


if __name__ == "__main__":
    unittest.main()
