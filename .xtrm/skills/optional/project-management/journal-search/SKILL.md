---
name: journal-search
description: Full-text search over every Substrate journal entry (all projects) with SQLite FTS5 and BM25 ranking, through the prototype script journal-search/scripts/jsearch.py in the project-management pack. Use when you need to find where something was decided, reported, ruled or handed off ("when did we decide X", "who said Y about Z", "find the operator's word on W") and you do not know the issue or seq. Read-only on the Substrate store. Not for reading one known issue (use sb journal show/latest/since).
---

# Journal search (jsearch)

Prototype before a `sb journal search` verb. One script, one side index, read-only on Substrate. Manager, leads and
workers use it before asking a peer "what did we decide about X": the answer is usually already in a journal.

## Run

```
python3 <pack>/journal-search/scripts/jsearch.py "<query>" [filters]
```

`<pack>` is the pack directory, for example `~/.xtrm/skills/optional/project-management`. The script reads the same store
as `sb`: `$SUBSTRATE_DB`, else `~/.xtrm/state.db`.

Each call first syncs the index (only entries newer than the last one indexed, about 0.1 s), then searches.
Output per hit: `<REF> seq<N> <kind> <MM-DD HH:MMZ> <participant> (<score>)` and one snippet with the matched words in `[brackets]`.
Higher score = better match (BM25; the issue title counts half as much as the body).

| Filter | Meaning |
|---|---|
| `-p PROJ` | project prefix |
| `-r PROJ-120` | one issue |
| `-k decision,blocker` | entry kinds (decision, finding, blocker, result, handoff, milestone, note, checkpoint) |
| `-w engine` | participant name contains |
| `--since 2026-11-10` | created on or after that UTC day |
| `-n 30` | number of hits (default 15) |
| `--rebuild` | drop and rebuild the index (about 6 s for 33k entries) |

No query: sync only and print the entry count.

## Query syntax (FTS5)

- Words are ANDed: `tick DROP operator`.
- Exact phrase: `'"promote merge"'` (quote the phrase inside the shell quotes).
- `OR`, `NOT`, grouping: `'(cloudflare OR ufw) NOT docker'`.
- Prefix: `'rollback*'`.
- Case and accents are ignored. A `-`, `#` or `.` splits a token: search `1490` not `#1490`, `PROJ 4810` or `"PROJ-4810"` as a phrase.
- A query FTS5 cannot parse (for example `route-backlog dedup`) is retried with every word quoted as a phrase; the output says so. `query error` means even that failed.

## Examples

```
jsearch.py '"rollback" operator' -p PROJ -k decision,blocker --since 2026-11-12
jsearch.py 'firewall dns' -n 5
jsearch.py 'merged 1503' -r PROJ-120
jsearch.py 'FAILED lint' -k blocker
```

## What it indexes

The text of semantic, result, mechanical and refs JSON of every entry, plus the issue title. The result payload is included, so entries whose text
lives only in `result.summary` (hasSemantic false) are found.

## Rules

- A hit is a pointer, not evidence: open the entry with `sb journal show <ref>` (or `--json`) before acting on it, and re-check the fact live.
- Never write to the Substrate store; the script opens it read-only. The index lives in `$XDG_CACHE_HOME/journal-search/` (default `~/.cache`; rebuildable, safe to lose) and can be rebuilt any time.
- Journal edits are not reindexed (entries are append-only); use `--rebuild` if an entry was rewritten.
