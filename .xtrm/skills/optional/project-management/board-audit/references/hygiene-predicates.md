# MMD-3017 hygiene predicates — CANONICAL for this lane

Ruling: fri30-coord, 2026-10-30 ~19:15Z — "ADOPT your documented predicates as canonical now."
Reason: saved filters **10065** ("MMD · Open without dates"), **10055** ("MMD · Overdue, not done") and
**10056** ("MMD · Next 48 hours") answer `404 Non puoi utilizzare il filtro selezionato` to the Jira
credential this lane uses (deleted, or never shared). Positive control on the same endpoint and
credential: filters 10034 `entity`, 10035 `roll-plan`, 10037 `tasks-only` return 200 with their JQL, and
`GET /rest/api/3/filter/favourite` returns `[]`.

Cycle reports cite THIS FILE and the JQL key below. They do not carry `FILTER-UNAVAILABLE`, and the
operator is never asked to re-share the filters. All predicates are `project = ISSUE` (replace the key
for another project) and are read with `GET /rest/api/3/search/jql?jql=...&maxResults=100`
(paged by `nextPageToken`; the endpoint returns no `total`).

## Controls (run before trusting any number)

Every predicate carries a positive control (a row it must accept) and a negative control (a row drawn
from the complement population, which it must reject). Each control re-asks the predicate narrowed to
one key, so it cannot pass by restating the predicate's own count, and it cannot pass on a superset.

`scripts/cycle/hygiene_cycle.py` derives both controls from live data and prints `PASS` or `FAILED` per
predicate; a `FAILED` predicate prints `CONTROL-FAILED` and its number is not a measurement.
Exit status 3 means a control failed.

- **CTRL-pop** — population control, not a control of any predicate:
  `project = ISSUE AND labels = window AND statusCategory != Done` (113 rows on 2026-10-31). An empty or
  implausible result means the credential or the endpoint broke, not that the board is empty.
- **H1** — positive: an actual H1 row (e.g. ISSUE-356) must return 1 under H1. Negative: an open window
  that HAS a due date (e.g. ISSUE-587) must return 0 under H1.
- **H3** — positive: a row with a date pattern in its summary (ISSUE-528) → 1. Negative: a window whose
  summary has no date pattern (ISSUE-587) → 0.
- **H4** — positive: `parent IS EMPTY` must accept a row where the field really is empty, taken from
  outside the window population (ISSUE-585) → 1. Negative: a window that HAS a parent (ISSUE-587) → 0.
  H4 = 0 therefore means "no window is parentless", not "the predicate is broken". A positive control
  inside the window population is impossible while H4 = 0, and demanding one would force a false alarm.
- **O1w** — positive: an actual O1w row (ISSUE-566) → 1. Negative: an overdue `Blocked` window
  (ISSUE-521) → 0, because Blocked is not workable.

Superseded control, do not reuse: HC3 (`parent is EMPTY`) as H4's "negative control" was the same
predicate as H4, so H4 = 0 was uncontrolled (caught 2026-10-31, fixed here).

## H1 — windows with no due date (mirrors 10065 for the subset that is a defect)

```
project = ISSUE AND labels = window AND statusCategory != Done
  AND issuetype in (Task, Story) AND duedate is EMPTY
```
Report the keys. Widening to all types (no `labels = window`) returns ~160 rows of ordinary backlog and is
not a defect list — the label-restricted subset is the finding.
Observed 2026-10-30 19:09Z: 11 open rows (ISSUE-247, 292, 309, 315, 318, 325, 327, 328, 354, 356, 564);
15 including terminal statuses.

## H2 — windows missing the slot fields

```
project = ISSUE AND labels = window AND (duedate is EMPTY OR cf[10237] is EMPTY)
```
The documented health check says this must return 0; it does not. Report the count and the status
breakdown, never a per-row fix list (62 rows on 2026-10-30: Da completare 17, Blocked 12, Won't Do 9,
Completata 8, Deferred 7, Done with Follow-up 4, Waiting Production 3, Pronto 2). Slot fields on a closed
window are a record unless the window never ran (`board-audit`, standing rules).

## H3 — dates in window titles

```
project = ISSUE AND labels = window AND summary ~ "10-*"
```
Must be 0 by the row rule (dates live in `customfield_10015`, duedate, `cf[10237]`, `cf[10238]`).
Observed 2026-10-30: 19 rows, mostly closed.

## H4 — parentless windows

```
project = ISSUE AND labels = window AND parent is EMPTY
```
Observed 2026-10-31: **0** — clean. Its control is the pair described above: the mechanism demonstrably
accepts a parentless issue, and rejects a window that has a parent.

## O1 — overdue and workable (mirrors 10055)

```
project = ISSUE AND statusCategory != Done AND status not in (Blocked, Deferred)
  AND duedate < now()
```
`Blocked` and `Deferred` are excluded because they are not workable: filter 10055 tests "workable and past
its date", not "past its date" (ISSUE-335 was falsely reported late by the looser predicate).
Window-labelled subset is the high-signal one:
`... AND labels = window` → 5 rows on 2026-10-30 (ISSUE-365, 388, 457, 497, 520).
The broad predicate legitimately includes Stories (ISSUE-432 … ISSUE-447) and long-dead rows (ISSUE-49,
ISSUE-68); report those separately, not as window misses.

## N1 — next 48 hours (mirrors 10056)

```
project = ISSUE AND labels = window AND statusCategory != Done
  AND duedate >= now() AND duedate <= 2d
```
Slot-time matching is deliberately **by due date, not by `cf[10237]`**: a JQL range on `cf[10237]` compares
in the value's STORED offset, so a 09:07Z window answers a `10:00-11:00` query and misses a `09:00-10:00`
one. Query wide by date, then convert each row to UTC with `zoneinfo` before trusting the match.
Observed 2026-10-30: 26 rows.

## N2 — open items with no due date, all types (context, not a defect list)

```
project = ISSUE AND statusCategory != Done AND duedate is EMPTY
```
160 rows on 2026-10-30. Reported only as a board-shape number.

## Reporting rules

- Quote the number with the JQL key that produced it (`H1`, `O1`, …); a value with no predicate is not a
  measurement.
- Every count is produced by a paged read in the same turn as the report; never from memory.
- At load1 > 10 run no per-item `gh`/`sb` loop; these predicates are all single paged JQL reads and stay
  legal at any load.

## Status drift — both sides

`scripts/cycle/hygiene_cycle.py` also compares one day's merge journal with the Jira status it implies.
It reads the Substrate journal with `sb journal timeline MMD-2331 --json --limit 5000` (the bounded
RECENT window; entries created after 00:00Z) and today's merged PRs
(`gh pr list --state merged --search "merged:>=<date>"`), then reads each ticket's Jira status with
`GET /rest/api/3/issue/<key>`. The verdict compares the two, never the event alone:

- a Substrate closure whose Jira status is not in `Completata | Done with Follow-up | Won't Do | Cancelled`
  is `MISMATCH`;
- a merged PR whose ticket is `Blocked` or `Pronto` is `MISMATCH` (work merged, board says not started);
- a merged PR whose ticket is `Da completare | In corso | Waiting Production | In verifica` or done is `OK`;
- a journal mention with no closure and no merge is `INFO`, never drift.

**Never read the journal with `show` for a "today" question.** `show` returns the OLDEST entries first,
so any `--limit` below the head silently hides the recent window. At `--limit 400` on 2026-10-31 it
stopped at seq 400 (2026-10-21) while the head was 1790, and the sweep reported "no drift today" — a
blind instrument reading as a quiet board (MMD-3223 cycle 09:36Z). The script now reads `timeline` and
enforces three coverage controls, printing `UNMEASURED` instead of a zero when any fails:

1. **live** — the newest entry is younger than 3600 s (catches a stale or cached read);
2. **reaches today** — the oldest entry in the window is at or before today's 00:00Z (catches a window
   too small for a busy day);
3. **not at the limit** — a window exactly at `--limit` is truncation, not coverage.

Negative control for all three: run the cycle with a stub `sb` on `PATH` that returns entries two hours
old; it must print `drift: UNMEASURED`. A real read prints its rows (2026-10-31 12:45Z: 4 rows, including
ISSUE-335 `Deferred` with merged PR #1160).



Ticket-to-PR matching is by `ISSUE-\d+` in the PR title and body, so a PR that mentions many tickets can
produce a false candidate: report `MISMATCH` rows as candidates for the coordinator, not as facts.

Prove the instrument before trusting a quiet day: today's sweep returning nothing is a measurement only
after `--since=<yesterday>` produces rows. On 2026-10-31 the replay of 2026-10-30 produced 17 rows
(14 OK, 3 candidate mismatches: ISSUE-477 `Blocked`, ISSUE-482 `Pronto`, ISSUE-483 `Blocked`, each with a
merged PR), while the same `gh` command returned 0 for 2026-10-31 and 23 for 2026-10-30.
