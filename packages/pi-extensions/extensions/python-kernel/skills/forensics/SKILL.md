---
name: forensics
description: Transcript/log forensics in kernel cells: load JSONL once, tally, pair tool_use with tool_results. Mounted as `forensics` — no host round trips.
---

# Forensics (`forensics` kernel module)

First skillbridge consumer: pure-stdlib helpers for the loop the audit trail
is made of — load a corpus once into a named variable, then filter across
cells instead of re-fetching per question.

```python
recs = forensics.load_jsonl(path)                 # list[dict], bad lines skipped
forensics.tally(recs, "type")                     # Counter
forensics.top(forensics.tally(recs, "type"))      # [(value, count)] — the digest
forensics.count_occurrences(path, "hook_success") # streaming line count, file never fully loaded
io = forensics.summarize_tool_io(path)            # {tool: {calls, input_chars, result_chars}}
```

Conventions (enforced by nothing, followed by everything):

- One cell per question: capture via `subprocess` inside the cell and parse in
  the same cell — a shell+compute round-trip pair collapses to one call.
- Name the corpus variable after the corpus (`recs`, `shapes`) so `kns()`
  shows what survives; re-read `kns()` after long threads instead of
  re-deriving.
- Session scratch: the module holds no state between calls. Durable findings
  go to files/bd/journal, never into kernel variables you can't see tomorrow.

`help(forensics)` lists signatures. No third-party imports — zero-install
mount holds by construction.
