# Batch protocol mechanics

**Ids: `programme-coordination/references/jira.md`** (field table, transition table per project).
Do not keep a second copy here: the id tables drifted the moment another project appeared, and the
duplicate is what made the trap below invisible.

> Trap, recorded because it cost a wrong write: **"Blocked 101" without a project is a trap.**
> `101` is Blocked in the `ISSUE` project and Deferred in `XT`. Read the transition table for the
> project you are writing to, then `GET .../transitions` and confirm the mapping before you post.
> Never post a transition id from memory.

## Search (jql)

`POST /rest/api/3/search/jql` with `{"jql": ..., "maxResults": N, "fields": [...]}`.
Never `GET /rest/api/3/search` (410, removed). The response carries `issues` and `isLast`, and **no
`total`**: count the rows you received and follow the cursor, never report a total you did not get.
`orderBy` is not a body parameter — it returns 400 `Invalid request payload` (2026-10-26), so order in JQL
or sort client-side. Parent queries:
`parent = ISSUE-198`, `parent = <epic>`. Label queries:
`labels = window`, `labels = mmd-programme AND summary ~ "..."` + exact
string compare client-side for idempotency.

## Writes

- PUT summary/description/dates/labels replaces the field: snapshot labels
  first, re-add kept ones (the `mmd-calendar` wipe lesson).
- Parent moves: `PUT {"fields": {"parent": {"key": ...}}}`; pre-read must show
  the expected old parent, post-read the new one.
- Epic create: project + issuetype + summary (+ sprint id, labels). Sprint ids
  are board-local — read them live, never assume.
- Comments: `POST .../comment {"body": adf(text)}`; verify by re-reading the
  comment id you were given, never by reading "the newest comment" (ordering
  puts the newest first, so the last element is the oldest). Read newest-first
  with `orderBy=-created` (lesson: ascending pages misled a cycle report).
- Relayed text can arrive HTML-escaped — a peer's JSON round-trip turns a real quote into `&quot;`. Decode
  the entities before posting and tell the author you did: the read-back agrees with what you sent, so it
  cannot catch this one (ISSUE-368, 2026-10-26).
- PR-link timeline (operator rule): every PR mapped to a ticket gets its link
  posted as a Jira comment (number, branch, merge state); check the PR
  references the ticket back, report gaps to the coordinator. Mechanics below.
- `scripts/jira.py` prints `HTTP <st>` then JSON capped at 6000 chars: skip the
  first line when parsing, prefer single-issue GETs / `maxResults=1` for
  comment reads.
- JQL `status = "<name>"` can return 0 rows for a live display name; use the
  status id or `statusCategory` for counts.
- Same-name status trap: two `Completata` objects existed (10137 carries the
  rows, 10139 does not) — verify which id the rows carry before excluding.
- Shared Jira account: the author field cannot attribute a change to a person;
  peer attribution is coordinator-stated, record it as such.
- Links: `POST /rest/api/3/issueLink {"type": {"name": "Relates"},
  "inwardIssue": {"key": A}, "outwardIssue": {"key": B}}`.
- Blocks link: inwardIssue = the blocker, outwardIssue = the blocked; re-read both rows; a script that sees the wrong direction stops (fail-closed helper: ~/.cache/MMD-3017/blocks_link.py; two wrong-direction slips on 2026-10-30).
- Authorship evidence: the changelog shows a deleted comment as
  `Comment -> None` and bumps the issue's `updated`, so a mysterious `updated`
  change is often a deletion, not an edit.

## PR-link timeline (operator rule)

Every PR that maps to a ticket gets a formal link comment on that ticket. A link is never a one-off
backfill: merges and opens continue, so the ledger needs top-ups.

**Format (match it exactly — the duplicate check depends on it):**

```
PR-link market-data#<n> (head <12-hex sha>, <merged|open>). Ticket <KEY> governs <MMD-ref> (<how the mirror was found>).
```

**Two shapes exist; accept both.** The format above is the canonical one, but a large share of the
comments actually posted (every `[agent:<name> | run:<id>] PR-link https://github.com/...` body) use the
full PR URL and carry an attribution prefix. A presence check that only tests
`body.startswith('PR-link market-data#')` therefore reports zero on a ticket whose link is present.
Match `PR-link\s+\S*?(<org>/<repo>/pull/<n>|<repo>#<n>)` anywhere in the flattened body, and derive
`<org>/<repo>` from the remote with `git@` and `:` normalised first: an SSH remote parsed naively yields
`com:org/repo`, and every ticket then looks link-less (epic-coord-3, 2026-10-30, two false zeros before
a known-present PR exposed them).

**Give the PR-link predicate its own control, and know it is a superset.**
`project = ISSUE AND comment ~ "PR-link market-data#"` returns every issue whose comments *mention* the
string — 64 issues on 2026-10-26, against 0 for a nonsense repo — so it proves the instrument discriminates
but it cannot prove a link exists. Presence is decided client-side on `body.startswith('PR-link
market-data#')`; report the two numbers separately, or an over-count gets read as coverage.

**A passing mention is not a link.** A status, audit, ruling or "DONE" comment that cites a PR number
does not satisfy the rule and does not suppress a later link. The duplicate check must therefore match
only an earlier comment in the format above (`body.startswith('PR-link market-data#')` and the number
present), never a bare number or SHA search across the comment list. Measured 2026-10-24: a substring
dup guard tripped on old planning comments, silently skipped 22 of 51 rows, and had to be re-run under
a tightened rule (coordinator ruling: "a passing mention inside a status comment is not a link").

**Discovery must be date-bounded, not limit-bounded.** `gh pr list --limit N` sorts by creation and
silently omits merges (measured: #920 merged 16:31Z was missed by a limit-60 pass). Use a date search
per repo and union the results:

```sh
gh pr list --repo <owner/repo> --state merged --search "merged:>=<YYYY-MM-DD>" --limit 100 \
  --json number,title,headRefName,headRefOid,mergedAt,url
```

Run it for every in-scope repo (market-data, market-archive, quant) and for `--state open` too.

**Mirror resolution order:** explicit `ISSUE-<n>` in title or branch > `substrate:<MMD>` label lookup >
`NO-MIRROR` (no comment proposed). State the resolution path in the comment so the next audit can
re-derive it.

**Optional rows:** where a prose comment already records the same merge with its merge commit (for
example a DONE comment naming both the PR and the back-merge), a second formal link is optional —
propose it as optional and let the coordinator choose.

**Backlog and top-up batches** are proposed, never posted blind: one row per `PR | mirror | state |
link-comment present/MISSING | evidence`, sample-checked live on at least 3 rows before proposing.
Post paced (about 4 s), duplicate-checked per row immediately before the POST, and re-read after to
confirm the returned comment id carries the SHA.

## Date discipline

Windows: the two slot fields (ids in `programme-coordination/references/jira.md`) carry full
timestamps with an offset, start/due are plain dates, and all four are set together. The offset is per date, not per programme (+0200 CEST until
2026-10-25, +0100 CET after): compute it with zoneinfo, write the offset the slot
requires, and report UTC in the comment. A Friday slot that claims the CME halt
cannot run at all — CME closes for the weekend at 21:00Z.

**Never print a stored timestamp truncated and label it Z.** `cf[10237]` comes back as
`2026-10-27T08:00:00.000+0100`; slicing 19 characters yields `08:00` and reporting it as `08:00Z` shifts the
window an hour (2026-10-26: three Tuesday windows were published an hour late in two cycle reports for
exactly this reason). Convert with zoneinfo before it reaches any report, ledger or comment, and convert
`updated` the same way — a recency list printed as `18:45Z` was `17:45Z`.

## Substrate lane

`sb issue claim <ref> --holder <name> --ttl-ms 3600000` (re-claim at
checkpoints), `sb journal append <ref> --kind <k> --semantic '<json>'`,
`sb issue resume <ref>` after context pressure. Settlement is evidence, not
closure.

## Transport and watch mechanics

- On agent-registry failure, retry `SendMessage` once before reporting the
  flap; the report file + journal entry are the durable channel. Address a peer by its session **name**,
  never by the `uds:` socket path: the socket form fails with the same registry error while the name form
  delivers in the same second (three refusals on 2026-10-26, every retry by name succeeded).
- Change-only monitors run in <=30 min legs (tool cap), re-armed each cycle;
  a curl failure prints no line (silent), so every cycle re-checks the
  watched comments directly.
