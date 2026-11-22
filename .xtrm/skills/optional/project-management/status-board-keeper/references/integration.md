# Status board (Tabellone): integration reference

Everything needed to read, write and run the project's Status board from another app.
Written 2026-11-17 against the live host; every path, endpoint and count below was read
from the running system, not from memory. Where a fact is a snapshot (record counts,
config values for project `mercury`), the date is stated.

Companion files: [setup.md](setup.md) (settings and first-time setup, this skill),
[SKILL.md](../SKILL.md) (the keeper brief and its write bans),
`project-management/references/setup.md` (the shared settings every pack script reads).

---

## 1. What the artifact is

One published web page per project (`https://<site>.here.now`) plus a JSON document
store on the same site. The page is published once. After that **only the store
changes** — never republish the page to update data.

```
                       ┌──────────────────────────────┐
 Jira (window slots,   │ status_board_sync.py         │      here.now data API
 PR links, op-waiting) │ systemd --user, every 5 min  │────► docs/<recordId>
 Substrate (sb issue,  │ parts (a)–(f)               │      (Bearer, PATCH whole doc)
 journals)             └──────────────────────────────┘
 tmux panes                     ▲ write                    │ read
 gh pr list                     │                          ▼
                        ┌──────────────────────────────┐  ┌─────────────────────┐
                        │ keeper (hourly subagent)     │  │ the page / your app │
                        │ + pm_question.py (on demand) │  │ render + answer UI  │
                        └──────────────────────────────┘  └─────────────────────┘
```

Three writers only: the sync (mechanical), the keeper (judgement-lite, from manager
facts), and `pm_question.py` (one row per filed question). An integrating app should
treat the store as read-mostly.

---

## 2. Component map

Pack root: `~/.xtrm/skills/optional/project-management/`

| Path | Lines | Role |
|---|---|---|
| `status-board-keeper/scripts/status_board_sync.py` | 1890 | the mechanical writer; parts (a)–(f) including answer routing; stdlib only |
| `status-board-keeper/scripts/test_status_board_sync.py` | 462 | unit tests, no network |
| `status-board-keeper/SKILL.md` | — | keeper brief: store rules, doc shapes, what it may never write |
| `status-board-keeper/references/setup.md` | — | every setting, example config, install and verify |
| `status-board-keeper/references/integration.md` | — | this file |
| `project-management/scripts/pm_config.py` | — | settings resolution: env → pack config → project profile |
| `project-management/scripts/pm_question.py` | — | `add` / `refresh` / `close` a question row (+ Substrate journal) |
| `project-management/scripts/pm_check.py` | — | `--skill status-board-keeper` validates every setting |
| `project-management/scripts/post-guard.py` | — | the only Jira comment path (`--mention-first` for the operator) |
| `project-management/scripts/route_target.py` | — | resolves the live session an answer is delivered to |
| `project-management/hooks/operator-questions.py` | — | Stop hook: finds your unanswered board questions, prints the `pm_question.py` command |
| `board-audit/scripts/lane/scheduler.sh` | — | lane passes; its `run_tab()` is the board's health check |
| `board-audit/scripts/lane/route-watch.py` | — | reads the answers inbox and routes to the operator channel |

Line anchors in `status_board_sync.py`: `mem_gate` 215, `hn_call` 237, `hn_list` 267,
`doc_of` 282, `build_waiting` 578, `build_workers` 733, `archive_done` 847,
`answer_target` 941, `deliver` 966, `build_prs` 1035, `desired_event` 1242,
`build_jira_schedule` 1274, `route_answers` 1484, `assert_lines` 1578, `main` 1734.

---

## 3. Runtime on this host

| Item | Value |
|---|---|
| unit | `~/.config/systemd/user/status-board-sync.service` (oneshot) |
| timer | `~/.config/systemd/user/status-board-sync.timer`, every 5 min |
| env | `PM_PROJECT=mercury`, `SUBSTRATE_HOLDER=MMD-3173-tabellone-sync` |
| workdir / log | `~/.xtrm/product/market-data/tabellone/` · `sync.log` (append) |
| limits | `TimeoutStartSec=600`, `Nice=10` |
| linger | enabled for `dawid` (survives logout and reboot) |

State directory (`PM_STATUS_BOARD_STATE_DIR` = `~/.xtrm/product/market-data/tabellone/`):

| File | Meaning |
|---|---|
| `state.json` | routed answer ids, last run, `waiting_backfill_done` |
| `drift.jsonl` | one line per anomaly the run found (`waiting-row-dropped`, placement drift); the keeper reports it, never repairs it |
| `jira-profile.json` | cached Jira board profile (status categories, slot fields) |
| `answers-inbox.jsonl` | answers appended for the lane router (one path for both ends) |
| `assert-cache.json` | cache for the assertion pass |
| `waiting-armed` | present = part (a) label writes live; absent = dry for the label only |
| `sync.log` | stdout/stderr of every run |

Commands an integrator needs:

```bash
systemctl --user list-timers status-board-sync.timer     # armed? next run?
systemctl --user start status-board-sync.service         # run once now
journalctl --user -u status-board-sync -n 80             # ASSERT-* lines live here
tail -40 ~/.xtrm/product/market-data/tabellone/sync.log   # the script's own view
python3 <pack>/status-board-keeper/scripts/status_board_sync.py --dry   # plan only
```

---

## 4. Settings

Resolution order (`pm_config.py`): environment variable `PM_<NAME>` → the project
profile in `~/.config/xtrm/project-management.json` (`projects.<name>.<lower-case-name>`)
→ the file's defaults → built-in default. Select the project with `PM_PROJECT`, or let
it be inferred from the working directory.

| Key (config) | Variable | Project `mercury` value | Required |
|---|---|---|---|
| `status_board_site` | `PM_STATUS_BOARD_SITE` | `velvet-breeze-fbm8` | yes |
| `status_board_self_issue` | `PM_STATUS_BOARD_SELF_ISSUE` | `MMD-3173` | yes |
| `status_board_key_file` | `PM_STATUS_BOARD_KEY_FILE` | `~/.herenow/credentials` | no (default `~/.herenow/credentials`) |
| `status_board_state_dir` | `PM_STATUS_BOARD_STATE_DIR` | `~/.xtrm/product/market-data/tabellone` | no (default `<state_dir>/status_board`) |
| `answers_inbox` | `PM_ANSWERS_INBOX` | `~/.cache/MMD-3173/answers-inbox.jsonl` | no |
| `bot_inbox` | `PM_BOT_INBOX` | `~/.xtrm/product/market-data/xtrm-bot-watch/inbox.jsonl` | no |
| `status_board_unit` | `PM_STATUS_BOARD_UNIT` | `status-board-sync.service` | no |
| `status_board_file_only` | — | `["manager"]` | no |
| `status_board_answer_seed_at` | — | `2026-10-30T12:30Z` | no |
| `status_board_status_overrides` | — | `{"Deferred":"blocked","Won't Do":"blocked","Won't do":"blocked"}` | no |
| `status_board_jql` | — | `project = ISSUE AND (labels = mmd-programme OR labels = window OR parent in (ISSUE-432..448, ISSUE-502, ISSUE-528) OR key = ISSUE-198) AND created >= "2026-10-06 11:20" AND statusCategory != Done` | no |

Shared settings the sync also reads: `jira_site`, `jira_token_file`, `jira_project`,
`sb_prefix`, `sb_bin`, `epic`, `repo_dir`, `repo_slug`, `repo_name`, `state_dir`,
`operator_account_id`, `operator_handle`, `custom_fields.{window_start,window_end}`,
`extra_ref_prefixes`.

---

## 5. Store API

Base: `https://here.now/api/v1/publishes/<site>/data/docs` (site `velvet-breeze-fbm8`).

| Operation | Call |
|---|---|
| list | `GET …?limit=100` → `{"records":[…],"nextCursor":…}`; follow `nextCursor` until absent |
| create | `POST …/docs` with header `Idempotency-Key: <uuid>` |
| replace | `PATCH …/docs/<recordId>` — **replaces the whole `doc`**: `GET` the record first and send the complete new doc, never a fragment |
| delete | `DELETE …/docs/<recordId>` |
| page file | `GET https://here.now/api/v1/publish/<site>/files/index.html` |

Auth: header `Authorization: Bearer <key>`, key file `chmod 600`, never printed, never
logged, never copied under `~/.cache`. **The published page is private**: the site URL
returns 401 without the bearer, so an app that embeds or proxies it needs the key too.

Record shape:

```json
{"id": "rec_01M7MAGQJNTTPF1NV2D4FAQ1EE",
 "data": {"path": "workers/MMD-5252-tier2-unordered-guards",
          "doc": {"name": "…", "status": "live", "…": "…"}},
 "createdAt": "…", "updatedAt": "…"}
```

`doc` may be a JSON string or an object — parse both (`doc_of()` at line 282 does).
One path = one record (duplicates are resolved by newest `updatedAt`). **16 KB per
record**, last writer wins.

List example:

```bash
K=$(cat ~/.herenow/credentials)
curl -s -H "Authorization: Bearer $K" \
  'https://here.now/api/v1/publishes/velvet-breeze-fbm8/data/docs?limit=100' \
  | jq '.records[] | {id, path: .data.path}'
```

---

## 6. Data model

Ten collections existed on 2026-11-17 08:50Z (414 records). `doc` fields:

| Path | n | Shape | Written by |
|---|---|---|---|
| `workers/<name>` | 131 | `{name, kind:"coordinator\|pi\|specialist\|subagent\|builder", where:"%paneId", runtime:"xt pi\|xt claude", issue, task, status:"live\|gone\|working\|idle\|waiting\|done\|blocked", milestone, milestoneAt, ctxPct, claimUntil, reportsTo, order, note, updatedAt, updatedBy}` | sync (b): `status, where, ctxPct, claimUntil, updatedAt, updatedBy`; coordinator: `milestone, note, task, reportsTo, order` |
| `schedule/<YYYY-MM-DD>` | 25 | `{date, updatedAt, updatedBy, events:{<id>:{at:"YYYY-MM-DDTHH:MMZ", ref, label, status:"done\|running\|waiting\|blocked\|scheduled\|proposed-move", note, note_src, end, url, kind:"window\|pr\|handover\|incident\|report", created_by}}}` | window events: sync (e) `created_by:"sync-jira"`; PR events: sync (d) `e_<HHMM>_PR-<n>`; handover/incident/report: keeper |
| `followups/<ref>` | 83 | `{ref, title, plain, status:"scheduled\|running\|waiting\|blocked\|done", priority, area, owner, when, refs, updatedAt, updatedBy}` | keeper |
| `answers/<qid>` | 126 | `{answer, comment, at, by}` | the answer UI (no pack script writes it) |
| `archive/workers-<date>[-N]` | 20 | `{date, note, workers:{<name>: <whole worker doc>}}` | sync rotation of done workers older than 24 h |
| `questions/<owner>` | 19 | `{from, rows:[{id, ref, by, q, rec, why, at}], updatedAt, updatedBy}` | `pm_question.py`; `questions/operator-waiting` by sync (a) |
| `lanes/config` | 5 | `{hardstop, markers:[{at, kind, label}]}` | coordinator (no pack script) |
| `status/<session>` | 3 | `{from, at, now}` (long free text) | manager/coordinator (no pack script) |
| `board/next` | 1 | `{rows:[{key, title, status, start, end, why}]}` | coordinator (no pack script) |
| `proposals/<date>` | 1 | `{title, why, deadline, open, slips:[{ref,to,why}]}` | coordinator (no pack script) |

Verified samples (one per collection, trimmed):

```json
// questions/MMD-4416-options-lead-2
{"from":"MMD-4416-options-lead-2",
 "rows":[{"id":"q-band4-1117","ref":"MMD-4416","by":"MMD-4416-options-lead-2",
          "q":"Band 4 of the options restart (11-01..11-10, 58 root-dates) missed Tue 02:45Z; may it run Wed 11-18 01:45-05:45Z? ISSUE-551 comment c18414",
          "rec":"Yes: TimescaleDB only, a copy of each date is kept; word needed before Wed 01:45Z",
          "why":"","at":"2026-11-17T08:31:04Z"}],
 "updatedAt":"2026-11-17T08:31:04Z"}

// answers/q-darth-pgbouncer
{"answer":"yes","comment":"done","at":"2026-11-17T08:06Z","by":"Dawid"}

// schedule/2026-11-23 (window event, machine-owned)
{"at":"2026-11-23T02:00Z","ref":"ISSUE-722","label":"MMD window: drop the 4 options_rematerialize_* backup tables (MMD-4541)",
 "status":"scheduled","note":"02:00-03:00Z · Date recorded: 23 November 2026, and the slot is word-gated.",
 "kind":"window","created_by":"sync-jira","url":"https://mercuryintel.atlassian.net/browse/ISSUE-722"}

// workers/MMD-5252-tier2-unordered-guards
{"name":"MMD-5252-tier2-unordered-guards","kind":"pi","runtime":"xt pi","issue":"MMD-5252",
 "status":"live","where":"%1347","ctxPct":14.8,"claimUntil":"2026-11-17T10:18Z",
 "updatedAt":"2026-11-17T08:48Z","updatedBy":"status-board-sync"}
```

---

## 7. Ownership matrix

| Write | Who may | Rule |
|---|---|---|
| `schedule/*` event with `created_by:"sync-jira"` | sync only | a wrong slot is a **Jira** defect: report it, never patch the page |
| `schedule/*` key ending `_<JIRA_PROJECT>-<n>` | sync only | same reason (Jira window Task) |
| `schedule/*` handover, incident, report events | keeper only, from manager facts | keep `created_by` absent so the sync never touches them; timeline events need a timed `at` |
| `workers/*` machine fields | sync | `milestone, note, task, reportsTo, order` belong to the coordinator |
| `questions/operator-waiting` and the `op-waiting` Jira label | sync (a) | only while `waiting-armed` exists |
| `questions/<owner>` | `pm_question.py` | never hand-edit; it also writes the Substrate journal entry |
| `answers/*` | the answer UI | sync only reads, routes and delivers |
| delete a doc | only the sync (worker rotation) | never delete to "clean up" |

An integrating app is expected to write **at most `answers/<qid>`** and read everything
else. It must never write `created_by:"sync-jira"` events and never republish the page.

---

## 8. The sync's parts

One run, six mechanical jobs (a–f). Every part is idempotent; a skipped run
(memory gate) writes nothing and keeps state, so the next run picks up the same window.

**(a) Operator waiting list (upstream MMD-3291 / MMD-3353).** Only the ticket's **latest
comment** counts. It mentions the operator (ADF `mention` of `operator_account_id`, or the
text `@<operator_handle>`) → set `op-waiting` and write one row. It mentions
`@xtrm-bot` (the operator answered) → remove the label and the row. Any other latest
comment, including the operator writing in person, changes nothing. A `statusCategory
Done` ticket never waits. Doc `questions/operator-waiting`, row id
`w-<key>-<qualifying commentId>`, capped at 12 KB (text trimmed 1000→60, then oldest rows
dropped, each drop a `drift.jsonl` line).

**(b) Workers.** `tmux list-panes -a` + `sb issue show` → status/where/ctxPct/claimUntil.
Pane gone **and** issue closed → `done`. A `done` worker untouched for 24 h is copied
whole into `archive/workers-<date>` and only then deleted from `workers/`; the delete is
skipped if the archive write failed.

**(c) Answer routing.** Every `answers/*` row newer than the last routed id is appended
to the answers inbox (`pm_config.answers_inbox()`, the same file the lane router reads)
and delivered once: target = the live session named `<owner>` from `questions/<owner>`,
else the one live `manager`. Owners in `status_board_file_only` (here: `manager`) get the
inbox line only, never keystrokes. Seed `status_board_answer_seed_at` = `2026-10-30T12:30Z`.

**(d) Merged PRs → `schedule/<mergedAt date>`.** One bulk
`gh pr list --state merged --search merged:>=<today-1>` per repo; key `e_<HHMM>_PR-<n>`,
`ref:"PR #<n>"`, `kind:"pr"`, `status:"done"`. An existing PR row is adopted (only
`url, kind, base, status, title` added); rows it did not create are never deleted.

**(e) Jira windows → `schedule/<date>`.** Every Jira window row for today−2 … today+7 is
placed from the slot fields (`customfield_10237/10238`), key `e_<HHMM>_<KEY>`, label =
summary, `note` = the slot range + the recorded-date phrase, `created_by:"sync-jira"`.
A row it cannot place is a `drift.jsonl` line and an `ASSERT-FAIL unplaced-row`.
This is the part the keeper SKILL.md calls "part (e)"; the letters here follow the
module docstring, which documents them in the order a, b, d, c, f, with windows added
later as (e).

**(f) Assertions (MMD-3382), read-only, after the writes.** For each Jira window row
placed for today … today+7: a `kind:"window"` event exists in the doc the run published,
and the doc's `updatedAt` does not predate the Jira slot write. Output is one
`ASSERT-COUNT` line (`<publish>` = site `currentVersionCreatedAt`) and, on a hole,
`ASSERT-FAIL missing-doc|missing-event|stale-doc|unplaced-row` with exit 1;
`ASSERT-UNKNOWN` is reported only. **A failure is a hole in the schedule: fix the Jira
data, never write a `sync-jira` event by hand.**

**Memory gate.** `/proc/pressure/memory` `full avg10 > 10` or `MemAvailable < 4 GB` →
`SKIP`, nothing written.

---

## 9. Questions and answers

Filing (a question from a lead/manager, not from the app):

```bash
pm_question.py add     --ref <ref> --q <text> --rec <text> [--why <url>] [--id <qid>] [--owner <doc>]
pm_question.py refresh --q <text> | --id <qid> [--rec ..] [--why ..] [--owner <doc>]
pm_question.py close   --ref <ref> --q <text> | --id <qid> [--answer <text>] [--owner <doc>]
```

- `add` writes a Substrate journal entry `kind=blocker` (semantic `{summary, for:
  operator, qid, q, rec, why}`) **and** the row in `questions/<owner>`.
- `refresh` re-stamps `at` (capped-row protection); `close` writes `kind=decision` with
  `answers: <qid>` and removes the row.
- `qid_of(text)` = hash of the question text, so the Stop hook and the CLI file the same
  row. `--owner` defaults to the session's own doc (`pm_question.py` line 78).
- The row id is stable across refresh; `at` is the freshness stamp the page shows.

Answering: the operator (or an app acting for him) writes `answers/<qid>` with
`{answer, comment, at, by}`. The next sync run routes it to the owning session. Never
write `answers/*` from a worker lane; it is the operator's channel.

---

## 10. Lane integration

`board-audit/scripts/lane/scheduler.sh` runs the board's operational passes:

| Leg | Interval | What it does |
|---|---|---|
| cycle | 15 min | hygiene filters, drift, close sweep, comment watch, PR links → `events.log` + `cycle/CYCLE-<HHMM>Z.md` |
| status_board | 30 min | `run_tab()`: `systemctl --user show <status_board_unit> -p Result,ActiveState,SubState,ExecMainStatus,LoadState`, logs `STATUS-BOARD-OK`/`STATUS-BOARD-FAIL` only when the state hash changes (`tabhash` in `sched.state`) |
| route | 5 min | `route-watch.py`: reads both inboxes (`bot_inbox`, `answers_inbox`), decides where each operator comment goes, writes `pending-routes.jsonl` |
| wp / deploy / heavy | 60 / 15 / 15 min | Waiting Production audit, deploy snapshot, HEAVY queue watch |

An app that wants the board's health should read the same unit, not a copy of the state.

---

## 11. Minimal reader for another app

```python
import json, os, urllib.request
KEY  = open(os.path.expanduser('~/.herenow/credentials')).read().strip()
SITE = 'velvet-breeze-fbm8'
BASE = f'https://here.now/api/v1/publishes/{SITE}/data/docs'

def list_docs():
    cur, out = None, {}
    while True:
        url = f'{BASE}?limit=100' + (f'&cursor={cur}' if cur else '')
        req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + KEY,
                                                  'Accept': 'application/json'})
        page = json.load(urllib.request.urlopen(req, timeout=30))
        for rec in page.get('records') or []:
            data = rec.get('data') or {}
            doc = data.get('doc')
            if isinstance(doc, str):
                try: doc = json.loads(doc)
                except ValueError: doc = None
            if data.get('path'):
                out[data['path']] = {'id': rec['id'], 'doc': doc,
                                     'updatedAt': rec.get('updatedAt')}
        cur = page.get('nextCursor')
        if not cur:
            return out

docs = list_docs()
workers   = {p: r for p, r in docs.items() if p.startswith('workers/')}
schedule  = {p: r for p, r in docs.items() if p.startswith('schedule/')}
questions = {p: r for p, r in docs.items() if p.startswith('questions/')}
followups = {p: r for p, r in docs.items() if p.startswith('followups/')}
```

Write path (only for an answer UI):

```python
# create a new answer row
POST BASE           body {"data": {"path": "answers/<qid>", "doc": {...}}}
                    header Idempotency-Key: <uuid>
# replace an existing answer: GET the record, send the WHOLE doc
PATCH BASE + '/' + record_id   body {"data": {"path": "answers/<qid>", "doc": {...}}}
```

Multi-project: one template instance per project
(`status-board-sync@.service` with `Environment=PM_PROJECT=%i`), each with its own
profile and `status_board_state_dir`; set `status_board_unit` per profile so the lane
health check reads the right unit.

---

## 12. Verify an installation

1. `python3 <pack>/project-management/scripts/pm_check.py --skill status-board-keeper`
   — every setting resolves (a missing one is named).
2. `python3 <pack>/status-board-keeper/scripts/status_board_sync.py --dry` — plans every
   write, sends nothing; expect `window rows: N`, a workers summary and
   `ASSERT-COUNT … result=OK`.
3. Create `<state dir>/waiting-armed` only **after** reading the dry-run output; before
   it exists, parts (a)'s label writes are disabled.
4. Run without `--dry`; expect `RESULT OK` and exit 0. `ASSERT-FAIL` + exit 1 = a hole in
   the schedule.
5. `python3 -m unittest <pack>/status-board-keeper/scripts/test_status_board_sync.py`.
6. `journalctl --user -u status-board-sync | grep ASSERT` after the first hour.

---

## 13. Traps (verified, they cost time)

1. **The state-dir README is stale.** `tabellone/README.md` still names
   `~/.cache/MMD-3173/tabellone_sync.py` and `tabellone-sync.service`. The live unit runs
   the pack script as `status-board-sync.service`. Trust the unit, not the README.
2. **The answers inbox is split from the state dir.** `answers_inbox` points at
   `~/.cache/MMD-3173/answers-inbox.jsonl` while every other file lives in
   `.xtrm/product/market-data/tabellone/`. Both ends read one path (the sync writes it,
   `route-watch.py` reads it) — do not "tidy" it without changing both.
3. **The page is private.** `https://velvet-breeze-fbm8.here.now` answers 401 without the
   bearer; `…/files/index.html` is 121,118 bytes behind the same auth. Do not embed the
   URL expecting a public page.
4. **`PATCH` replaces the whole `doc`.** A fragment silently drops every other field of
   that record (and the page then shows blanks).
5. **16 KB per record.** Over the cap the write fails or the sync shrinks data (the
   waiting list trims text, then drops the oldest row and logs `waiting-row-dropped`).
6. **One path = one record.** Two records on one path are resolved by newest
   `updatedAt`; creating a second one instead of patching is the usual cause.
7. **Never republish the page to refresh data**, and never edit a `created_by:"sync-jira"`
   event: both are the two ways to make the board lie while every check stays green.
8. **The 5-minute timer is the whole mechanism.** If `status-board-sync.timer` is not
   active, the board freezes silently; the lane logs `STATUS-BOARD-FAIL` only when the
   unit's state hash changes.

---

## 14. Glossary

| Term | Meaning |
|---|---|
| Tabellone | the Status board page + store (Italian for "board") |
| part (a)…(f) | the sync's job letters, as documented in `status_board_sync.py`'s module docstring |
| `op-waiting` | Jira label marking a ticket whose latest comment asks the operator |
| `created_by:"sync-jira"` | machine-owned schedule event; read-only for every human writer |
| keeper | the hourly subagent that copies manager facts into the store, never judges |
| `ASSERT-COUNT` / `ASSERT-FAIL` | the sync's own result line / its hole report (exit 1) |
