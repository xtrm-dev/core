"""Tests for jsearch (FTS5 journal search) against a small Substrate-shaped store. Run: python3 test_jsearch.py"""
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent


def make_store(path, rows):
    db = sqlite3.connect(path)
    db.executescript(
        "CREATE TABLE projects(id TEXT, prefix TEXT);"
        "CREATE TABLE issues(id TEXT, project_id TEXT, human_number INTEGER, title TEXT);"
        "CREATE TABLE issue_journal(issue_id TEXT, sequence INTEGER, kind TEXT, participant_id TEXT, created_at INTEGER,"
        " semantic_json TEXT, result_json TEXT, mechanical_json TEXT, refs_json TEXT);"
        "INSERT INTO projects VALUES ('p1','PROJ');"
        "INSERT INTO issues VALUES ('i1','p1',120,'Rollout of the parser');")
    for seq, kind, who, ts, summary in rows:
        db.execute("INSERT INTO issue_journal VALUES ('i1',?,?,?,?,?,NULL,NULL,NULL)",
                   (seq, kind, who, ts, json.dumps({"summary": summary})))
    db.commit()
    db.close()


class Search(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.store = self.root / "state.db"
        make_store(self.store, [
            (1, "decision", "alpha-lead", 1_790_000_000_000, "The operator approved the rollback window for Friday"),
            (2, "finding", "worker-a", 1_790_000_100_000, "Parser drops rows with an empty symbol"),
        ])
        self.env = {**os.environ, "SUBSTRATE_DB": str(self.store), "XDG_CACHE_HOME": str(self.root / "cache")}

    def tearDown(self):
        self.tmp.cleanup()

    def run_js(self, *args):
        r = subprocess.run([sys.executable, str(HERE / "jsearch.py"), *args], env=self.env, capture_output=True,
                           text=True, check=False)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout

    def test_finds_by_words_and_filters(self):
        out = self.run_js("rollback operator")
        self.assertIn("PROJ-120 seq1 decision", out)
        self.assertIn("[rollback]", out)
        self.assertNotIn("seq2", self.run_js("rollback", "-k", "finding"))
        self.assertIn("seq2", self.run_js("parser", "-w", "worker"))

    def test_hyphenated_query_is_retried_as_phrases(self):
        out = self.run_js("empty-symbol")
        self.assertIn("query read as", out)

    def test_index_is_incremental_and_source_untouched(self):
        self.assertIn("+2 entries", self.run_js())
        db = sqlite3.connect(self.store)
        db.execute("INSERT INTO issue_journal VALUES ('i1',3,'result','worker-a',1790000200000,?,NULL,NULL,NULL)",
                   (json.dumps({"summary": "Parser fix merged"}),))
        db.commit()
        db.close()
        self.assertIn("+1 entries, total 3", self.run_js())
        self.assertTrue((self.root / "cache" / "journal-search").is_dir())

    def test_source_is_opened_read_only(self):
        self.store.chmod(0o444)
        self.assertIn("PROJ-120", self.run_js("parser"))


if __name__ == "__main__":
    unittest.main()
