"""Tests for pm_wakes (wake sources and messages sent, from a transcript). Run: python3 test_pm_wakes.py"""
import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import pm_wakes  # noqa: E402


def entry(**kw):
    return json.dumps({"timestamp": "2026-11-17T10:00:00Z", **kw})


class Wakes(unittest.TestCase):
    def test_sources_cost_and_messages(self):
        lines = [
            entry(type="user", message={"content": "please check the window"}),
            entry(type="assistant", message={"usage": {"input_tokens": 100, "output_tokens": 10}, "content": [
                {"type": "tool_use", "id": "t1", "name": "SendMessage", "input": {"to": "p-xt-claude-EP-1-api-lead", "summary": "Ack: done"}},
                {"type": "tool_use", "id": "t2", "name": "SendMessage", "input": {"to": "uds:/run/x.sock", "summary": "Hold"}}]}),
            entry(type="attachment", attachment={"type": "queued_command", "prompt":
                  '<cross-session-message message-id="m1" from="x" from-name="p-xt-claude-EP-1-api-lead">MERGE-READY #12</cross-session-message>'}),
            entry(type="user", isMeta=True, message={"content": 'Another Claude session sent a message:\n<cross-session-message '
                  'message-id="m2" from="x" from-name="p-xt-claude-EP-1-api-lead">blocker on #13</cross-session-message>'}),
            entry(type="assistant", message={"id": "a2", "usage": {"input_tokens": 300}, "content": []}),
            entry(type="assistant", message={"id": "a2", "usage": {"input_tokens": 300}, "content": []}),
            entry(type="user", message={"content": "<task-notification> <summary>Monitor event: swap</summary>"}),
            entry(type="user", message={"content": [{"type": "tool_result", "content": "ignored"}]}),
            entry(type="user", message={"content": "[cron HOURLY] cycle"}),
        ]
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as fh:
            fh.write("\n".join(lines))
        r = pm_wakes.measure(fh.name)
        self.assertEqual(r["wakes"]["operator"], 1)
        self.assertEqual(r["wakes"]["peer: EP-1-api-lead"], 1)       # the idle message woke it
        self.assertEqual(r["during"]["peer: EP-1-api-lead"], 1)      # the queued one did not
        self.assertEqual(r["wakes"]["notification: monitor"], 1)
        self.assertEqual(r["wakes"]["cron"], 1)
        self.assertEqual(r["cost"]["peer: EP-1-api-lead"], 300)      # one assistant id counted once
        self.assertEqual(r["sent"]["EP-1-api-lead"], 1)
        self.assertEqual(r["sent"]["socket path (rule: never)"], 1)
        self.assertEqual(r["words"]["ack"], 1)
        self.assertIn("MESSAGES SENT 2", pm_wakes.report(r))


if __name__ == "__main__":
    unittest.main()
