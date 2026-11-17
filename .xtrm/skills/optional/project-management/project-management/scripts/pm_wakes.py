#!/usr/bin/env python3
"""Measure what wakes a Claude Code session and how much it messages others, from its transcript (rule 40).

Every wake re-reads the whole context, so a coordinator's cost follows its wakes and the messages it sends (each one wakes the
receiver). This reads one transcript (JSONL) and prints, without sending anything anywhere:
- the span, and wakes by source: operator, peer message (by sender), task notification (monitor, goal check-in, specialist,
  background task), cron, compaction, slash command; peer messages queued during a running turn are counted apart (no wake);
- the share of the response cost each source drew (input + cache writes + a tenth of cache reads + 5x output, a rough weight);
- the SendMessage calls the session made, by recipient and by first word of the summary.

  pm_wakes.py --session <name>        newest transcript under ~/.claude/projects/*<name>*/ (or $CLAUDE_CONFIG_DIR/projects)
  pm_wakes.py <transcript.jsonl>      one transcript
"""
from __future__ import annotations

import collections
import glob
import json
import os
import re
import sys

PREFIX = re.compile(r"^[a-z0-9-]+-xt-(claude|pi)-")


def transcript_for(name: str) -> str | None:
    base = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"), "projects")
    files = glob.glob(os.path.join(base, f"*{name}*", "*.jsonl"))
    return max(files, key=os.path.getmtime) if files else None


def text_of(content) -> str | None:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        if any(isinstance(x, dict) and x.get("type") == "tool_result" for x in content):
            return None
        return " ".join(x.get("text", "") for x in content if isinstance(x, dict))
    return None


def source(text: str) -> str:
    t = text.lstrip()[:600]
    if t.startswith("<task-notification"):
        if "Monitor event" in t:
            return "notification: monitor"
        if "Goal check-in" in t:
            return "notification: goal check-in"
        if "Specialist" in t or "specialist" in t[:200]:
            return "notification: specialist"
        return "notification: background task"
    if t.startswith("[cron") or "<<autonomous" in t:
        return "cron"
    if "continued from a previous conversation" in t or "<command-name>/compact" in t or "Compacted" in t[:200]:
        return "compaction"
    if t.startswith("<command-message>") or t.startswith("<command-name>"):
        return "slash command"
    if t.startswith("<local-command") or t.startswith("<bash-"):
        return "local command"
    return "operator"


PEER = re.compile(r'<cross-session-message([^>]*)>\s*(.{0,60})', re.S)


def peers(text: str) -> list[tuple[str, str]]:
    """(dedupe key, sender) for each cross-session message in a text: the message id, else sender plus its opening words."""
    out = []
    for m in PEER.finditer(text or ""):
        attrs = m.group(1)
        sender = re.search(r'from-name="([^"]+)"', attrs)
        mid = re.search(r'message-id="([^"]+)"', attrs)
        name = PREFIX.sub("", sender.group(1)) if sender else "?"
        out.append((mid.group(1) if mid else f"{name}|{m.group(2)}", name))
    return out


def measure(path: str) -> dict:
    """Wakes: a turn that starts from a user entry (an idle peer message arrives as an isMeta user entry). A peer message queued
    while a turn runs ("during") does not start a turn, so it is counted apart and charged nothing. Cost is added once per
    assistant message id: Claude Code writes one line per content block, each repeating the same usage."""
    wakes, cost, sent, words, during = (collections.Counter() for _ in range(5))
    seen_peer, seen_sent, seen_msg, span, pending = set(), set(), set(), [], None
    with open(path, errors="replace") as fh:
        for line in fh:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get("timestamp"):
                span.append(e["timestamp"])
            att = e.get("attachment") if isinstance(e.get("attachment"), dict) else {}
            if att.get("type") == "queued_command":
                for key, name in peers(att.get("prompt") or ""):
                    if key not in seen_peer:
                        seen_peer.add(key)
                        during["peer: " + name] += 1
                continue
            if e.get("type") == "user":
                t = text_of(e.get("message", {}).get("content"))
                if t is None:
                    continue
                if e.get("isMeta"):
                    new = [(k, n) for k, n in peers(t) if k not in seen_peer]
                    if not new:
                        continue
                    seen_peer.update(k for k, _ in new)
                    pending = "peer: " + new[0][1]
                    for _, n in new:
                        wakes["peer: " + n] += 1
                    continue
                pending = source(t)
                wakes[pending] += 1
            elif e.get("type") == "assistant":
                msg = e.get("message", {})
                u = msg.get("usage") or {}
                mid = msg.get("id")
                if pending and (mid is None or mid not in seen_msg):
                    if mid is not None:
                        seen_msg.add(mid)
                    cost[pending] += ((u.get("input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0)
                                      + (u.get("cache_read_input_tokens") or 0) // 10 + 5 * (u.get("output_tokens") or 0))
                for c in msg.get("content") or []:
                    if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") == "SendMessage":
                        if c.get("id") in seen_sent:
                            continue
                        seen_sent.add(c.get("id"))
                        inp = c.get("input") or {}
                        to = str(inp.get("to", ""))
                        sent["socket path (rule: never)" if "sock" in to else PREFIX.sub("", to)] += 1
                        w = str(inp.get("summary") or inp.get("message") or "").split()
                        words[w[0].strip(":,").lower() if w else "?"] += 1
    return {"span": (span[0][:16], span[-1][:16]) if span else ("-", "-"), "wakes": wakes, "cost": cost, "sent": sent,
            "words": words, "during": during}


def report(r: dict) -> str:
    total = sum(r["cost"].values()) or 1
    out = [f"span {r['span'][0]} .. {r['span'][1]}", f"WAKES {sum(r['wakes'].values())}"]
    out += [f"  {k:34s} {n:5d}   cost share {100 * r['cost'][k] / total:5.1f}%" for k, n in r["wakes"].most_common()]
    out.append(f"PEER MESSAGES QUEUED DURING A TURN (no wake) {sum(r['during'].values())}")
    out += [f"  {k:34s} {n:5d}" for k, n in r["during"].most_common(8)]
    out.append(f"MESSAGES SENT {sum(r['sent'].values())}")
    out += [f"  to {k:31s} {n:5d}" for k, n in r["sent"].most_common(12)]
    out.append("  by first word: " + ", ".join(f"{k} {n}" for k, n in r["words"].most_common(10)))
    return "\n".join(out)


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[0] == "--session":
        path = transcript_for(argv[1])
        if not path:
            print(f"pm_wakes: no transcript for session {argv[1]!r}", file=sys.stderr)
            return 1
    elif len(argv) == 1 and not argv[0].startswith("-"):
        path = argv[0]
    else:
        print(__doc__.strip().splitlines()[-2].strip() + "\n" + __doc__.strip().splitlines()[-1].strip(), file=sys.stderr)
        return 2
    print(path)
    print(report(measure(path)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
