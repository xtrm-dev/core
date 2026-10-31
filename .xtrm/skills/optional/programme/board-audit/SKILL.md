---
name: board-audit
description: >
  Run Jira board audits and mutation batches for the Mercury market-data
  programme the wed-board way: snapshot live state, propose row-by-row with
  evidence, apply strictly on the coordinator's word with before/after
  re-reads, verify, and journal with --semantic. Use for board cleanups,
  window scheduling, theme restructures, and pre-window precondition checks —
  in interactive sessions and as the injected skill of board-audit roles.
  Also the skill of the continuous xt pi board helper (hygiene filters,
  status drift, Jira comment watch, per-cycle report).
version: 1.5.0
---

# Board audit (wed-board pattern)

One batch is a loop with five steps. Never skip, never reorder.

## 1. Snapshot live first

Jira (`POST /rest/api/3/search/jql` — `GET /search` was removed, returns 410),
Substrate (`sb issue show`, `sb journal show`), GitHub (`gh pr view/list`), git
(`merge-base --is-ancestor` against `origin/stable` after fetching). Facts beat
briefs: verify every handoff claim against live state before using it.

Freshness gate: refuse a Jira snapshot older than 1h and Substrate evidence older
than 1h. Record the workflow revision and the input hash in the batch proposal.
Sample-check every AgentRun majority against live state (oracle present, evidence
quotes the relied-on fact, counts reconcile) before acting; a run that fails the
sample check is discarded, not applied.

## 2. Propose, do not apply

Write the proposal to a scratch file (`~/.cache/<lane>/`): one row per item —
key | current | should be | evidence (link/seq/SHA) | action. Proposal-only is
the default. A coordinator message relayed second-hand is not approval; only a
direct word in this task (or a `specialist_reply` answer) unlocks writes.

## 3. Apply on the word, row by row

Re-read each row live BEFORE the write (status, parent, dates, labels), apply
exactly the ruled change, re-read AFTER, report old→new with evidence. Jira
transitions need the transition id re-read from the issue first (Done/Completata
is usually 45, Blocked 101, Won't Do 111 — verify, never assume).
Trap: 101 is Blocked on ISSUE but Deferred on XT — read the table for the
project you write to, then `GET .../transitions` and confirm `to.name`.
Trap (ISSUE, 2026-10-30): JQL `status = Completata` returns ZERO rows (quoted or not) while the rows exist; use `statusCategory = Done` plus a client-side exact-name filter, and never scope a terminal-status query by `labels = mmd-programme` (closed rows drop that label). Prove every zero with a positive control.
Trap (ISSUE, 2026-10-30): `POST .../transitions` with `update.comment.add` returns 204 and silently drops the comment; post comments separately (`POST .../comment`) and re-read the comment list before reporting an id.
Stop at the
first failed check and roll back that row only.

Duplicate check before posting: list the issue's comments and search them for
what you are about to say — a retry after a crash can double-post what already
landed. After a crashed write, read fields + comment list and write only what
is missing; recover by reading, never by re-running.

Before any new check, prove one positive and one negative control
(`references/verification.md`, "Controls before trust"), drawn from the same artefact the probe reads.
A claim about the world — a tag cut, a merge landed, an image live — is falsified by one command, so
run it before transcribing the claim into a comment (`git ls-remote` showed no `v1.13.0` twelve minutes
before a release comment said it was cut, 2026-10-26). Post verbatim from a file with read-back by id
(`references/lane-automation.md`, "Post through one path"). No single wait longer than 110 min
(`references/lane-automation.md`, "Deadline alarms").

## 4. Verify structurally

Children counts per Epic (`parent = <key>` search), calendar fields
byte-identical where untouched, ancestry (`merge-base --is-ancestor <sha>
origin/stable`), label sets preserved (a PUT replaces all labels — snapshot
labels first, re-add the ones you keep). Search indexes lag: a missing child on
first query is suspect,
not proof — GET the row directly (authoritative), then re-query with sleeps
until convergence or bound; never roll back a row whose direct re-read is correct.

Correction discipline: own transcription slips in the open — row, wrong value,
fix, session — as a first-class journal entry, not a footnote.

## 5. Journal and hand off

`sb issue claim --holder <name> --ttl-ms 3600000` before edits; journal every
applied batch, proposal, correction, and wait with `--semantic`
(`result|note|decision|blocker|handoff`). Claim again at checkpoints; the claim
owning the lane is the only one that edits it.

## Continuous helper cycle (xt pi board helper)

One `xt pi` worker per coordinator runs this cycle (Muse Spark or the pi default; one process, no
Claude, no subagents). Launch syntax: `programme-coordination/references/fleet.md`, "Dispatch
surface". Jira calls go through `programme-coordination/scripts/jira.py`. Writes follow steps 2-3
above unless the coordinator has allowed a class of mechanical fixes in writing on the helper's issue.

Every cycle (default every 30 min; the coordinator sets the interval in the helper's contract):
1. **Hygiene filters.** Run "MMD · Open without dates" (10065), "MMD · Overdue, not done" (10055)
   and "MMD · Next 48 hours" (10056). Report every row with key, missing field or slot, and owner.
   Filter 10065 matches every non-Done Task/Story without a due date — 100+ rows, past the 100-row page —
   so report its `labels = window` subset; that is where a missing date is a defect rather than a state.
2. **Window checks** (kept from the auditor role): windows with stale dates, windows with zero
   comments, open PRs with no window, health-check JQL rows (`programme-coordination/references/jira.md`).
3. **Status drift.** For every Substrate issue closed, claimed or merged today (`sb journal`,
   `gh pr list --state merged --search "merged:>=<today>"`), read the mirrored Jira item. The status must match
   the event (`programme-coordination/references/jira.md`, event-to-status table). Report each
   mismatch with both states and the evidence. Fix it only when the coordinator allowed status fixes.
4. **PR-link top-up.** Every PR mapped to a ticket needs its formal link comment, and merges keep
   arriving after any backfill. Each cycle: list PRs merged or opened since the last ledger stamp
   (`merged:>=` search per repo, never a `--limit` list), check each ticket's comment list for a
   comment in the `PR-link market-data#<n> (head <sha>, <state>)` shape, and propose the missing rows.
   A passing mention in a status comment does not count (`references/batch-protocol.md`,
   "PR-link timeline"). Post only on the coordinator's word; from 2026-10-30 sat31-coord made a
   PR-link backfill standing authority (c), so that class needs no fresh word, only the report.
   **Match both shapes and anywhere in the body.** The comments in use read
   `PR-link https://github.com/<org>/<repo>/pull/<n> (head <sha>, merged <ts>)`, usually behind an
   `[agent:<name> | run:<id>]` prefix, so a `startswith('PR-link market-data#')` test reports zero on a
   ticket whose link is present. Two false zeros on 2026-10-30 (epic-coord-3) came from that test and
   from deriving the repo slug from an SSH remote (`git@github.com:org/repo` -> `com:org/repo`). Derive
   the slug with `git@` and `:` normalised, and match `PR-link\s+\S*?<slug>/pull/<n>` OR
   `PR-link\s+\S*?<repo>#<n>`.
5. **Comment watch** (background loop, every 15-30 min): search
   `project = ISSUE AND labels = "prog:<programme>" AND updated >= -30m`, read comments newer than
   the last seen comment id (keep the cursor in `~/.cache/<lane>/comment-cursor`). For each new comment, decide its
   effect on the board: dates, window slot, status, decision, operator answer. If the effect is
   mechanical (for example, the operator moves a window to a stated slot) AND the coordinator has allowed that class of fix in writing on the helper's issue, apply it with a before/after
   re-read. Otherwise notify the coordinator at once with the key, the comment text and the proposed change.
   An operator answer always goes to the coordinator, even when it is also applied.
   Own PR-link timeline comments advance the cursor (never self-flag) and trip
   the watch like any comment (operator rule 2026-10-24).
6. **Cycle report** to the coordinator (`SendMessage` to `$XTRM_DISPATCHER_NAME`, plus a file
   `~/.cache/<lane>/CYCLE-<HHMM>Z.md` stamped from `date -u` in the same command): counts per check,
   rows needing action, fixes applied with old->new, comments needing a decision. A clean cycle is one line.
   Journal one `note` per cycle with `--semantic` on the helper's issue. Pin paths:
   cursor `~/.cache/<lane>/comment-cursor`, reports `~/.cache/<lane>/CYCLE-<HHMM>Z.md` —
   convergent helpers, auditable cycles.

The helper never edits repos, never touches production, and never closes Substrate issues.

## New-ticket check (every newly filed ticket, whoever filed it)

A ticket is a brief, and a brief has to stand alone. Run this check whenever a new Jira ticket or a new
Substrate issue appears: new `ISSUE-*` from a `created >= -<window>` JQL on the project, new `MMD-*`
from `sb issue list --project prj_mmd` filtered on createdAt. Operator order 2026-10-25.

### (a) Deep check: duplicates, links, and clusters

1. **Semantic search, not keyword search.** Search for the symptom and the code site in the ticket's own
   words, then again in the words the codebase would use, across Jira `ISSUE` and Substrate `prj_mmd`,
   **open and recently closed** (a closed duplicate is still a duplicate, and a "fixed" ticket that left
   the defect behind is the most expensive miss).
2. **Ask three questions per candidate pair** — same symptom, same code site, same fix. Two of the three
   is a `RELATES-TO`; all three is a `DUPLICATE-OF` or a `MERGE-WITH`. Same symptom at two different code
   sites is two defects, and merging them loses one.
3. **Look for the shape, not the word.** A cluster looks like: N findings from one audit with no fix
   issues filed; one root cause restated as several tickets; a defect in a report table that nobody
   filed; an old ticket whose scope quietly covers a new one (see MMD-2806 versus MMD-2884, where the
   older contract was stricter and the newer was a duplicate).
4. **Resolve every ref to its flat id before comparing.** `sb issue show <ref> --json` returns an `id`
   field; two refs are the same issue if and only if those ids are equal. A hierarchical path
   (`MMD-2331.135`) and its flat form (`MMD-2862`) are ONE issue addressed two ways, so a title match
   across the two forms is not a duplicate — the coordinator corrected exactly this on 2026-10-25.
   Compare ids, not names, before writing DUPLICATE-OF.
5. **Branch ids are not issue ids.** `MMD-2331.1.9`, `MMD-1091.18.6` are revision-qualified references
   inside a parent issue, not standalone tickets: resolve the parent, then check whether the branch's
   subject has a ticket of its own.

### (b) Thin check: is the description a brief or a pointer?

Flag **THIN yes** when the description is pointer-only (`(MMD-4429)`, a bare ref, a title restated) or
when it is under the ADR shape. The ADR shape, even at three lines:

```
Context      — what is true now, with the measurement that shows it
Decision/plan— what will change, and the go-live or landing rule
Rejected     — the obvious alternatives and why they lose
Consequences — what breaks or improves, and what stays undone
Open         — what is unresolved and who rules on it
Evidence     — ticket keys, file paths, PR numbers, measurements
Pointers     — the refs, LAST, after the idea is stated in full
```

Never only `(MMD-4429)`: the whole idea first, then the pointers. A reader who has to open a second
ticket to learn what this one is about has been given a pointer, not a brief.

### Output, per new ticket

`DUPLICATE-OF / MERGE-WITH / RELATES-TO / CLEAN`, plus `THIN yes/no`, one line of evidence for each
verdict. **Propose; do not act.** The coordinator rules on merges and closures; this lane does not
close Substrate issues or merge Jira tickets. It **does** enrich thin Jira text itself, because it owns
Jira writes — enrichment is a description edit, not a disposition.

## Standing rules

- **Slot fields on a closed window are a record, unless the window never ran.** Clear `cf[10237]`/`cf[10238]`
  (and start/due) only when the work never happened in the slot: ISSUE-331 was closed after its PRs merged
  and deployed outside the window, so the fields were emptied. Keep them when the window *ran in its slot*,
  even if it closed early: ISSUE-397 merged at 20:10:44Z inside a 20:00-23:00Z slot, so the fields are the
  record of when it ran (sun-coord ruling 2026-10-25). The question to ask is not "is it closed" but "did the
  work happen in the window".
- **A window whose PRs are all merged AND deployed is a stale window.** It hides from every filter: it is not
  expired, not unlabelled, not dateless, and its status is a legal status. Check the PR state against
  `origin/stable` and the running image, not against the ticket's status word; if the change is live, clear the
  slot and close the window with the shipped evidence (coordinator ruling 2026-10-25, ISSUE-331: #936 merged
  10-20 and deployed in feed `e249fcbce`, slot cleared, Completata).
- **A ticket whose step ran but which has a later step is re-slotted, not closed.** "The work happened in
  the slot" is about the row's step, not the ticket: ISSUE-395's verifier ran inside its 08:07-08:37Z slot
  on 10-26 and one apply still waited for Tuesday's cron, so the row moved to 2026-10-27 07:17-07:47Z with
  status `Pronto` kept (mon-coord ruling 2026-10-26, correcting this lane's close proposal). Closing it
  would have retired a step nobody ran.
- **An empty field is a defect, not a default.** Entity, start, due and the two slot fields are what
  make a window readable; a row missing one is a finding to report, never something to fill with a
  guess. The detector is the health-check JQLs in `programme-coordination/references/jira.md`
  (windows with no dates, dates in titles, windows with no parent).
- Titles carry no schedule dates; dates live in `customfield_10015`/due-date/
  `customfield_10237`/`10238`. Server renders `+0000` as `+0200` — compute the
  offset per date with zoneinfo (CEST +0200 until 2026-10-25, CET +0100 after),
  write the offset the slot requires, report UTC in comments. Stamp every time
  from `date -u` in the SAME command as the write carrying it. The same trap bites
  queries: a JQL range on `cf[10237]` compares in the value's STORED offset, so
  `10:00-11:00` local finds a 09:07Z window while `09:00-10:00` silently finds a
  different one. Query wide, then convert each row to UTC before trusting the match.
- **Prove the filter before trusting its result.** Every filter gets a known-positive control: run it
  against one item you can see by eye. An empty control means the filter is wrong, not that the board
  is empty. A path that does not exist, a project key that is not a Jira project, and `git log
  --merges` on a squash-merge repo all return silent, plausible zeros — see
  `references/lane-automation.md`.
- **A zero from a Jira text probe is reported only after (a) a positive control on the same artefact, (b) all
  text fields including the description, (c) URL attrs and mark hrefs harvested from ADF, (d) the v2 wiki
  text as a second renderer.** A path check that returns 0 on a present path is the same failure as a
  counter that drifts. On 2026-10-29 a lane reported "no artefact path stored" on ISSUE-563 from two
  comment bodies: the path was in the description all along, and the ADF flattener read only `text`
  nodes, so a path inside an inline link was invisible (MMD-3017 caught it on a literal grep).
- **A field value in a report exists only if a command printed it in that turn, and every timestamp is
  checked for ordering before the report is sent.** A value with no source is fabrication, not a stale
  read, and it survives every control that tests the instrument. On 2026-10-29 a lane reported ISSUE-499
  as `Pronto` with a 2026-11-04 slot and `updated 10:40Z`; the row was `Blocked` with slot, start and due
  all empty, those three values appeared on no row of the board, and the report's own arithmetic was
  impossible — `updated 10:40Z` nine minutes *before* the comment that updated it. Quote the command
  beside the value, and re-read the ordering of any timestamps that share a sentence. The correction cost
  four messages and a withdrawn report; the ordering check would have caught it before the send.
- **A cycle check that mirrors a Jira filter uses that filter's exact predicate, and every new check gets a
  positive and a negative control before its numbers are reported.** When a cycle counter duplicates a saved
  filter (10065/10055/10056), read the filter's JQL and implement the same predicate, including its exclusions;
  if the two disagree the cycle prints `FILTER-DISAGREEMENT` and the cycle side is presumed wrong until shown
  otherwise. Controls are not optional: the positive one must flag an item you can already see is a hit, and the
  negative one must decline an item you know is not (a folded ticket, a slot that has not ended, a file the
  pattern does not match). An instrument returning zero and an instrument that is broken look identical, and a
  "none" is a measurement only after the instrument has said "yes" to a case whose answer you know. Three
  instances in two days, each fixed on the narrow side: the freeze classifier matched the rotation by subset
  rather than file-set equality; `gh()` parsed stdout as JSON so `--jq '.[].filename'` returned `[]` and every
  PR looked file-less; the overdue check tested "past its date" where filter 10055 tests "workable and past its
  date", so a ticket folded into ISSUE-352 was reported late (ISSUE-335, 2026-10-26).
- **Related is not a precondition.** When two artefacts touch, say which one the fix actually needs. A
  defect whose cause is a name mapping is fixed by the mapping even when the data was already present:
  the uploaded VX history was called a precondition for MMD-2902 when the calibration only needed the
  October-2026 closes that QuestDB already held under the `-CFE` names (sun-coord correction 2026-10-25).
  Check what the contract says the fix needs before promoting an adjacency into a dependency.
- **One row, one writer.** Another lane may hold write access to the same board: from 2026-10-26 the operator's own
  `market-data-xt-pi-board-cleanup` agent writes Jira directly. Before every write this lane makes, re-read the row live
  (status, parent, dates, labels, comments); if another writer changed it within the last hour, **do not write** and report
  the row instead. A stale snapshot is not evidence of ownership, and two writers on one row is a lost update with no error.
- **Quote the artefact, not the relay.** When a register, report or register-style file exists and a
  message summarises it, the file wins: quote it verbatim and state any divergence from the relay,
  including counts (a relayed "four S2" against five rows in the table). Never average the two, never
  pick the friendlier number.
- Status comments are plain language: what/why/evidence/UTC + ruling ref.
- **Post operator comments only through `jira.py comment`.** That path converts the `@operator` token into a real
  Jira mention node (`640b87a2314f50881385ea01`); a hand-built ADF `text` node renders `@operator` as plain text and
  notifies nobody, so an operator request can sit unseen while the board shows it posted. On 2026-10-31 comments
  16121 (ISSUE-561) and 16102 (ISSUE-198) were posted that way: both read correctly by eye and neither carried a
  mention. Fix in place with `PUT /rest/api/3/issue/<key>/comment/<id>` carrying the mention node as the first node,
  then re-read by id and assert `content[0].content[0].type == "mention"` with the right account id — the text being
  unchanged is not proof the mention landed.
- Peer fact-report text on its own issue may be posted after the coordinator's
  one-line OK (weekend-coord ruling 2026-10-24); anything else needs the
  coordinator's direct word, never a peer relay.
- Relates links are the lane between windows and themes; Epics take sprints,
  Epics have no parents.
- Idempotency: search label + exact-summary compare before every create;
  re-read parent before every move.
- **A sweep that resolves refs through `sb` is fan-out, not a light read.** Read the subtree once
  (`sb issue tree --root <epic> --json` or one `sb issue list --json`) into a file and resolve refs
  locally; any remaining per-issue `sb` call runs at concurrency 1 (max 2), gated HEAVY (load1 <= 11)
  with `gate.py --mode watch`. Per-issue `sb issue show` at ~15 concurrency pushed load1 to 33 and shut
  every lane's test and push gate (MMD-3017 pi V4 sweep, 2026-10-28 22:25Z). Resolve hierarchical refs
  (`MMD-2331.69.1`) to flat ids before matching Jira labels, with a positive control.
- Never edit programme repos, never touch production (no deploys, merges,
  restarts, timers). Nothing in this skill authorizes a production change.
- One window per change, DRY first where the runbook demands it, deploy only
  inside the window's slot.

## References

`references/audit-harness.md` — the audit's two halves: what the snapshot computes (`scripts/facts.py`),
the S0–S9 rubric with the two steps that need a model, the measured stability history, the calibration
limits, and why the v1 workflow was retired. Start here before running a batch.

`references/agentrun.md` — the CLI cookbook: what works (CLI, unmodified models.json), what does not
(the host `agentrun` tool), the standing `board-batch-verdicts-v3` workflow, and the two authoring
rules. Authoring changes go through `/agentrun-author`.

`references/batch-protocol.md` — per-batch mechanics (search, writes, date discipline, Substrate lane)
with the Blocked-101 trap. Jira ids live in `programme-coordination/references/jira.md`; board
discipline (window closing, slot clearing, one plan per day) lives there too.

`references/waiting-production-audit.md` — the Waiting Production audit (MMD-3180, 2026-10-30): "deployed" means the merge is an ancestor of the RUNNING export SHA of every container the PR touches (`make deploy-status`), never of `stable`; a row is WP when every build vehicle is merged and no prerequisite whose output its own step consumes has yet to run; bind a row to its governing vehicle, not to any `#n` mention.

`references/programme-sequencing.md` — programme sequencing to a hard stop (MMD-2909, folded 2026-10-30): which windows and PRs ride one promotion, which open PR can rewrite an earlier change, what happens to each item with no window, and whether each day fits the deploy rules. Facts and the oracle are code (`scripts/sequencing/facts_plan.py --selftest` first); AgentRun judges only the semantic step. Run it when a coordinator plans the days before a deadline, from a copy under `~/.cache/<issue>/sequencing/` (it writes its output next to the script). Its "Judge instrument" section is the rule for every Jev or model judge node in this skill: no node is trusted before the MMD-2673 calibration harness passes on a held-out seed, and a Jev-only verdict caps at REVIEW. Open: MANIFEST.json lacks the model id (H20), so record MMD_AUDIT_MODEL in the run's journal entry.

`references/verification.md` — the re-read checklists, the duplicate-check and crash-recovery rules,
and the index-lag rule.

`references/lane-automation.md` — the helper's own machinery, learned the hard way: state files are
interfaces (read the consumer before reshaping one), prove a filter before trusting its result, one
watcher that advances its own baseline, and one write path that identifies itself. Read it before
changing anything under `~/.cache/<lane>/`.

Scripts: `scripts/run-audit.sh` (driver), `scripts/facts.py` (snapshot + facts + selftest),
`scripts/aggregate.py` (odd-N majority), `scripts/check.py` (guard before committing). Workflow:
`workflows/board-batch-verdicts-v3.json`.
Board hygiene and status drift with live positive/negative controls: `scripts/cycle/hygiene_cycle.py` (predicates H1-H4, O1, N1-N2, one real control pair per predicate, and a Jira-side drift sweep; `--since=<date>` replays a day to prove the instrument); predicates and control rules in `references/hygiene-predicates.md`. Code readiness of epic children (is the code built, in a PR, partial or missing): `scripts/readiness/run-readiness.sh`
with `workflows/code-readiness-v1.json`; cookbook row and lessons in `references/agentrun.md`.
