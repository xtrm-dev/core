"""forensics: transcript/log forensics helpers for kernel cells.

Pure stdlib, no third-party imports — zero-install mount holds by
construction. Every helper returns small digests, never raw dumps (the
kernel truncates at 20KB; these keep you far below it). Module holds no
state: the caller names the corpus variable, the kernel holds it.
"""

from collections import Counter
import json


def load_jsonl(path, limit=None):
    """Parse a JSONL file, skipping blank/bad lines. Returns list[dict]."""
    out = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
            if limit is not None and len(out) >= limit:
                break
    return out


def tally(items, key):
    """Count items by key (field name or callable). Returns Counter."""
    c = Counter()
    for it in items:
        if callable(key):
            k = key(it)
        elif isinstance(it, dict):
            k = it.get(key)
        else:
            k = it
        c[k] += 1
    return c


def top(counter, n=10):
    """Top-N (value, count) pairs — the digest, not the dump."""
    return counter.most_common(n)


def count_occurrences(path, needle):
    """Streaming substring line-count for one file. Never loads it whole."""
    n = 0
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if needle in line:
                n += 1
    return n


def summarize_tool_io(path, name_field="name"):
    """One-pass tool_use/tool_result pairing for transcript JSONL.

    Returns {tool: {"calls", "input_chars", "result_chars"}} — the table
    behind "which tool costs what". Tool uses are paired to their results
    by tool_use_id; unpaired results are ignored.
    """
    pending = {}
    stats = {}

    def _entry(name):
        return stats.setdefault(name, {"calls": 0, "input_chars": 0, "result_chars": 0})

    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            content = obj.get("message", {}).get("content")
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    name = str(block.get(name_field, "?"))
                    pending[block.get("id")] = name
                    entry = _entry(name)
                    entry["calls"] += 1
                    entry["input_chars"] += len(json.dumps(block.get("input", {})))
                elif block.get("type") == "tool_result":
                    name = pending.pop(block.get("tool_use_id"), None)
                    if name is None:
                        continue
                    result = block.get("content")
                    text = result if isinstance(result, str) else json.dumps(result)
                    _entry(name)["result_chars"] += len(text)
    return stats
