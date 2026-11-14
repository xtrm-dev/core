---
name: board-audit
description: >
  Run Jira board audits and mutation batches for one project's board
  (instance settings in references/setup.md) the wed-board way: snapshot live state, propose row-by-row with
  evidence, apply strictly on the orderer's word (the owning lead, or the
  manager) with before/after re-reads, verify, and journal with --semantic.
  Use for board cleanups, window scheduling, theme restructures, and
  pre-window precondition checks — in interactive sessions and as the injected
  skill of board-audit roles. Also the skill of the board helper (launch role
  board-audit-runner, pack role `board_helper`, usually named `board-helper`): the only Jira writer, the owner of the lane
  processes, and the router that alone reads the operator's inbound channels,
  decides where each comment goes, and writes every comment through one guarded path.
version: 1.7.0
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

Draft the proposal in `$PM_LANE_DIR/`: one row per item —
key | current | should be | evidence (link/seq/SHA) | action. Then post it to its
system of record (a `note` journal entry on the helper's issue, sent to the orderer
with its seq); a draft file nobody received is not a proposal. Proposal-only is
the default. A lead's or manager's message relayed second-hand is not approval; only a
direct word in this task (or a `specialist_reply` answer) unlocks writes.

## 3. Apply on the word, row by row

Re-read each row live BEFORE the write (status, parent, dates, labels), apply
exactly the ruled change, re-read AFTER, report old→new with evidence. Jira
transitions need the transition id re-read from the issue first (on the reference board
the done status is 45, Blocked 101, Won't Do 111 — verify, never assume).
Trap: 101 is Blocked on one Jira project but Deferred on another — read the table for the
project you write to, then `GET .../transitions` and confirm `to.name`.
Trap (2026-10-30): JQL `status = <localised done status>` returned ZERO rows (quoted or not) while the rows existed; use `statusCategory = Done` plus a client-side exact-name filter, and never scope a terminal-status query by `labels = $PM_JIRA_LABEL` (closed rows drop that label). Prove every zero with a positive control.
Trap (2026-10-30): `POST .../transitions` with `update.comment.add` returns 204 and silently drops the comment; post comments separately (`POST .../comment`) and re-read the comment list before reporting an id.
Stop at the
first failed check and roll back that row only.

Duplicate check before posting: list the issue's comments and search them for
what you are about to say — a retry after a crash can double-post what already
landed. After a crashed write, read fields + comment list and write only what
is missing; recover by reading, never by re-running.

**One write path.** Every comment this lane posts goes through one guarded command, not an ad-hoc
script: `post-guard.py <key> <textfile> --run <WORD> [--mention-first] [--force] [--dry-run] [--update <cid>]`.
It refuses when the row was updated by anyone else within 60 minutes (the clock comes from Jira, never from the host), refuses a
duplicate of the last five comments (a crash retry must recover by reading, never by re-running), posts
through the module's own `adf()` converter, and then asserts on read-back: newest id equals the posted id,
the mention rule held (exactly one mention and it is the FIRST node when `--mention-first`, zero
otherwise), and the last paragraph is the agent tag. A rule that lives in a head dies with the context; a
rule in the guard fires whether or not anyone remembers it.

**The guard is shared, and direct POSTs are mechanically blocked** (coordinator ruling 2026-11-02). The tool
ships with the project-management skill, so every project that uses that skill's `jira.py` can reach it:

```
~/.xtrm/skills/optional/project-management/project-management/scripts/post-guard.py <KEY> <text-file> --run <WORD>
```

`jira.py`'s `call()` refuses any `POST .../comment` unless `POST_GUARD_ACTIVE=1` is set, and only the guard
sets it, so a direct `jira.call('POST', ..., comment)` raises `RuntimeError` and writes nothing. The bypass is
the defect that produced c16623 (B394): it was posted through `jira.adf()` directly, without `@operator` in the
text, so no mention node was created and the operator was never notified. Every comment, mention or not, goes
through the guard. No exceptions.
The guard takes no project paths: `--own-writes <file>` (env `POST_GUARD_OWN_WRITES`) records this lane's
own comment ids for its comment watch, and `--run-file <file>` (env `POST_GUARD_RUN_FILE`) stamps the WORD as a
record; unset means nothing is recorded. `--run <WORD>` is required and is never inherited from a file: a lane
that read the tag from a file left by a previous session mislabelled its comments (B406 comments carried
`run:B364` on 2026-11-02). A lane keeps a thin wrapper that sets those two variables and execs the shared
script, so its callers keep one command and every project runs the same code.

**Every key is a link.** Any Jira key in a comment this lane posts is an ADF `inlineCard` node pointing at
`$JIRA_SITE/browse/<KEY>`, and every PR is a link to its GitHub URL — never a
plain-text pointer a reader has to copy-paste. Substrate refs (`<PM_SB_PREFIX>-n`) have no web page, so say so instead of
inventing a link, and never mirror them into Jira rows to make them clickable: the operator ruled against
mirrors on 2026-11-01, because they add noise. Build the body with a link-aware ADF builder that turns
`[[<KEY>]]` into an `inlineCard`, and assert the card count on read-back — a link that silently stayed
text looks correct by eye.

**Mention-first comments.** The `@operator` token must become a real ADF mention node, and some comments
must OPEN with it. Post them with `post-guard.py <KEY> <text-file> --run <WORD> --mention-first`: the guard
puts exactly one mention at node 0, appends the agent tag as the last paragraph, and asserts on read-back.
Never build the body by hand: `jira.py` refuses a comment POST outside the guard. The text being right is
not proof the mention landed (`content[0].content[0].type == "mention"` is).

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
(`result|note|decision|blocker|handoff`). `sb issue renew <ref>` at checkpoints; take a
new claim only after the lease expired. The claim owning the lane is the only one that edits it.

**Cadence.** One note per HOUR plus one on every state change — not one per 15-minute cycle. The journal is
read by other lanes; a hundred identical counter notes a day bury the decision that mattered. A state change
means a status moved, a gate flipped, a channel delivered, a control failed.

**Correct in the open.** When your own report was wrong, journal it as a correction with the row, the wrong
value, the fix and the batch, then report it. A silent fix teaches nobody and leaves two versions of the
board.

## Continuous helper cycle (board helper)

One board helper per project (launch role board-audit-runner, pack role `board_helper`, usually session `board-helper`) runs this cycle as an
`xt pi` worker (the pack default model, never Muse Spark: it stops mid-task; one process, no Claude, no subagents). Launch syntax:
`project-management/references/launching.md`. It is the only Jira writer: leads order their own Jira
moves through it, the manager orders the rest. Jira calls go through `project-management/scripts/jira.py`.
Writes follow steps 2-3 above unless the manager has allowed a class of mechanical fixes in writing on
the helper's issue.

Every cycle (default every 30 min; the manager sets the interval in the helper's contract):
1. **Hygiene filters.** Run the three saved filters in config `hygiene_filters` ("Open without dates",
   "Overdue, not done", "Next 48 hours"; ids per board). Report every row with key, missing field or slot, and owner.
   The "Open without dates" filter matches every non-Done Task/Story without a due date — 100+ rows, past the 100-row page —
   so report its `labels = window` subset; that is where a missing date is a defect rather than a state.
2. **Window checks** (kept from the auditor role): windows with stale dates, windows with zero
   comments, open PRs with no window, health-check JQL rows (`project-management/references/jira.md`).
3. **Status drift.** For every Substrate issue closed, claimed or merged today (`sb journal`,
   `gh pr list --state merged --search "merged:>=<today>"`), read the mirrored Jira item. The status must match
   the event (`project-management/references/jira.md`, event-to-status table). Report each
   mismatch with both states and the evidence. Fix it only when the orderer allowed status fixes.
4. **PR-link top-up.** Every PR mapped to a ticket needs its formal link comment, and merges keep
   arriving after any backfill. Each cycle: list PRs merged or opened since the last ledger stamp
   (`merged:>=` search per repo, never a `--limit` list), check each ticket's comment list for a
   comment in the `PR-link <PM_REPO_NAME>#<n> (head <sha>, <state>)` shape, and propose the missing rows.
   A passing mention in a status comment does not count (`references/batch-protocol.md`,
   "PR-link timeline"). Post only on the manager's word; a PR-link backfill is standing authority (c)
   since 2026-10-30 (sat31-coord ruling), so that class needs no fresh word, only the report.
   **Match both shapes and anywhere in the body.** The comments in use read
   `PR-link https://github.com/<org>/<repo>/pull/<n> (head <sha>, merged <ts>)`, usually behind an
   `[agent:<name> | run:<id>]` prefix, so a `startswith('PR-link <PM_REPO_NAME>#')` test reports zero on a
   ticket whose link is present. Two false zeros on 2026-10-30 (epic-coord-3) came from that test and
   from deriving the repo slug from an SSH remote (`git@github.com:org/repo` -> `com:org/repo`). Derive
   the slug with `git@` and `:` normalised, and match `PR-link\s+\S*?<slug>/pull/<n>` OR
   `PR-link\s+\S*?<repo>#<n>`.
5. **Comment watch.** Sweep `project = $PM_JIRA_PROJECT AND updated >= -2h` (wider than the contract's
   `labels = "prog:<project>"` scope on purpose: Jira's `updated` is answered from the search index,
   which lags, and a 30-minute window can miss a comment twice and lose it), read every comment newer than
   the cursor (`$PM_LANE_DIR/comment-cursor`), and route it: see "The router role" below. Mechanical
   board effects are applied only within a class the manager allowed in writing; everything else is a
   proposal. Own PR-link timeline comments advance the cursor and are never self-flagged.
6. **Cycle report** to the manager every 2 h (`SendMessage` to the session that
   `project-management/scripts/route_target.py manager` resolves, plus a `result` journal entry on the
   helper's issue; the lane file `$PM_LANE_DIR/CYCLE-<HHMM>Z.md`, stamped from `date -u` in the same
   command, is state the scripts read, not the record): counts per check, rows needing action, fixes
   applied with old->new, comments needing a decision. A clean cycle is one line.
   Between cycles, message the manager (or the owning lead, for its workstream) only for a decision, an operator comment that needs one, a defect that changes a
   window today, a production anomaly or a data-correctness finding; write confirmations of ordered writes as ONE message per order batch (ids, re-read result), and put self-corrections
   and instrument changes in the journal and the next cycle report, not in separate messages (project-management rule 40). The
   orderer orders by intent; you word the Jira text in plain language unless the order says "verbatim".
   Journal one `note` per hour and on every state change (see step 5). Pin paths:
   cursor `$PM_LANE_DIR/comment-cursor`, reports `$PM_LANE_DIR/CYCLE-<HHMM>Z.md` —
   convergent helpers, auditable cycles.
7. **Close sweep.** List, as one proposal batch per cycle, two populations: (a) every Substrate issue that has a
   result entry and is still open (`sb issue list --project $PM_SB_PROJECT_ID` filtered on result entries, cross-checked
   against `lifecycleState != closed`); (b) every Jira row not Done whose Substrate issue is closed (status
   drift already detects these; re-list them here as a close proposal). Send each lead the rows of its own
   workstream in ONE message; send the manager only the rows with no workstream parent (operator ruling
   2026-11-12). The lead closes its own Substrate issues and orders the Jira transitions in one word; you
   write nothing without that word — no Jira transition, no Substrate close, no comment. This sweep is the
   only path by which a closed Substrate issue or a result-bearing open issue reaches a Jira Done row.

Rule 53 (project-management): every Jira ticket order you receive must use the /planning sections in
plain words (PROBLEM, SUCCESS, SCOPE, NON_GOALS, CONSTRAINTS, VALIDATION, OUTPUT, SCRUTINY). When an order
lacks one, tell the orderer (lead or manager) before acting; do not infer the missing section.

The helper never edits repos, never touches production, and never closes Substrate issues. It owns the
lane processes: it alone starts and restarts the scheduler and the dead-man switch, and it keeps exactly
one tail on the lane's `$PM_LANE_DIR/events.log`.

## The router role (operator channels)

The board helper is the router: the only reader of the operator's inbound channels, and the only one who
decides where each operator comment goes — to the owning lead when it concerns a workstream, to the manager
otherwise (GOs, windows, merges, rulings, staffing). Leads and the manager do not read the inboxes, so a
decision this lane fails to forward is a decision nobody sees. Address by role or session name
(`project-management/scripts/route_target.py manager|board_helper`, `--team` for the roster), never by a
transport path. Instrument: `route-watch.py` (MMD-3017, 2026-11-01), every 300 s, one cursor per channel,
printing the trigger it matched on every line so a misroute can be argued with instead of guessed at.
Channels: the bot inbox (setting `PM_BOT_INBOX`) and the Status board answers inbox (`PM_ANSWERS_INBOX`).

**Forward AT ONCE** when the comment needs a decision: a GO or approval, a refusal, a halt, an explicit
question, a production or window matter, a secret or access matter, or a substantive answer with no other
marker. **Everything else is one line in the cycle report**: acks (`ok`, `yes`), statements,
answers to questions already handled. Err toward forwarding — a needless forward costs a message, a missed
decision costs a day.

The filter has to be provable, or it is a mood: classify with an ordered rule list and print the trigger;
prove it against the operator's own recent comments (`ok.` must be INFO; `@xtrm-bot ok.` is DECISION, because a bot
mention outranks the ack test (coordinator ruling 2026-11-01T12:00Z); a real approval,
a question and an `it is revoked` must be DECISION; an empty body with `answer: yes` must be INFO); baseline
the cursor on first run so nothing old reports as new; and watch the scheduler with a dead-man switch, because
a router that stopped looks exactly like an inbox with no news.

**A visibly empty operator comment is an instrument failure, never "he said nothing".** Read the raw ADF
before concluding anything about an operator comment.

## New-ticket check (every newly filed ticket, whoever filed it)

A ticket is a brief, and a brief has to stand alone. Run this check whenever a new Jira ticket or a new
Substrate issue appears: new `$PM_JIRA_PROJECT-*` from a `created >= -<window>` JQL on the project, new `$PM_SB_PREFIX-*`
from `sb issue list --project $PM_SB_PROJECT_ID` filtered on createdAt. Operator order 2026-10-25.

### (a) Deep check: duplicates, links, and clusters

**Search both systems, in four places, before any duplicate verdict.** A probe that reads one of Jira and
Substrate can only produce a half-verdict: on 2026-11-01 this lane called a ticket CLEAN from the Substrate
side while the Jira board already carried the same contract (MMD-3364 vs ISSUE-585 — same symptom, same code
site, same fix), and the row was a duplicate. `dup-probe.py` reads summary, server-side `text` (description
AND comments), every ADF node including `inlineCard` urls and link-mark `href`s, and the v2 render, with a
POSITIVE control on a key known to contain the term. Measure the gap: on `FRED_API_KEY` the summary probe
returned 1 row and the wide probe returned 7.

1. **Semantic search, not keyword search.** Search for the symptom and the code site in the ticket's own
   words, then again in the words the codebase would use, across Jira `$PM_JIRA_PROJECT` and Substrate `$PM_SB_PROJECT_ID`,
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
verdict. **Propose; do not act.** The owning lead rules on merges and closures in its workstream, the
manager on the rest; this lane does not
close Substrate issues or merge Jira tickets. It **does** enrich thin Jira text itself, because it owns
Jira writes — enrichment is a description edit, not a disposition.

## Standing rules

- **Slot fields on a closed window are a record, unless the window never ran.** Clear the window-start/window-end fields
  (and start/due) only when the work never happened in the slot: ISSUE-331 was closed after its PRs merged
  and deployed outside the window, so the fields were emptied. Keep them when the window *ran in its slot*,
  even if it closed early: ISSUE-397 merged at 20:10:44Z inside a 20:00-23:00Z slot, so the fields are the
  record of when it ran (sun-coord ruling 2026-10-25). The question to ask is not "is it closed" but "did the
  work happen in the window".
- **A window whose PRs are all merged AND deployed is a stale window.** It hides from every filter: it is not
  expired, not unlabelled, not dateless, and its status is a legal status. Check the PR state against
  `origin/stable` and the running image, not against the ticket's status word; if the change is live, clear the
  slot and close the window with the shipped evidence (coordinator ruling 2026-10-25, ISSUE-331: #936 merged
  10-20 and deployed in feed `e249fcbce`, slot cleared, closed done).
- **A ticket whose step ran but which has a later step is re-slotted, not closed.** "The work happened in
  the slot" is about the row's step, not the ticket: ISSUE-395's verifier ran inside its 08:07-08:37Z slot
  on 10-26 and one apply still waited for Tuesday's cron, so the row moved to 2026-10-27 07:17-07:47Z with
  status `Pronto` kept (mon-coord ruling 2026-10-26, correcting this lane's close proposal). Closing it
  would have retired a step nobody ran.
- **An empty field is a defect, not a default.** Entity, start, due and the two slot fields are what
  make a window readable; a row missing one is a finding to report, never something to fill with a
  guess. The detector is the health-check JQLs in `project-management/references/jira.md`
  (windows with no dates, dates in titles, windows with no parent).
- Titles carry no schedule dates; dates live in the start-date field, due date, and
  the window-start/window-end fields (config `custom_fields`). The server renders times
  in `$PM_TIMEZONE` (`+0000` shows as `+0200` in summer CEST) — compute the
  offset per date with zoneinfo (CEST +0200 until 2026-10-25, CET +0100 after),
  write the offset the slot requires, report UTC in comments. Stamp every time
  from `date -u` in the SAME command as the write carrying it. The same trap bites
  queries: a JQL range on the window-start field compares in the value's STORED offset, so
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
  **Flatten ADF shape-agnostically**: walk every node and keep `text`, `mention.attrs.text`,
  `inlineCard.attrs.url`, media urls and link-mark `href`s, and turn block boundaries into newlines. Two more
  losses on 2026-11-01 came from narrow walkers: mention nodes dropped (a comment opening with a real mention
  read as untagged) and paragraph-only walks (an ordered list of answers read as an empty body).
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
  filter (config `hygiene_filters`), read the filter's JQL and implement the same predicate, including its exclusions;
  if the two disagree the cycle prints `FILTER-DISAGREEMENT` and the cycle side is presumed wrong until shown
  otherwise. Controls are not optional: the positive one must flag an item you can already see is a hit, and the
  negative one must decline an item you know is not (a folded ticket, a slot that has not ended, a file the
  pattern does not match). An instrument returning zero and an instrument that is broken look identical, and a
  "none" is a measurement only after the instrument has said "yes" to a case whose answer you know. Three
  instances in two days, each fixed on the narrow side: the freeze classifier matched the rotation by subset
  rather than file-set equality; `gh()` parsed stdout as JSON so `--jq '.[].filename'` returned `[]` and every
  PR looked file-less; the overdue check tested "past its date" where the saved overdue filter tests "workable and past its
  date", so a ticket folded into ISSUE-352 was reported late (ISSUE-335, 2026-10-26).
- **Related is not a precondition.** When two artefacts touch, say which one the fix actually needs. A
  defect whose cause is a name mapping is fixed by the mapping even when the data was already present:
  the uploaded history was called a precondition for MMD-2902 when the calibration only needed the
  October-2026 closes the database already held under other symbol names (sun-coord correction 2026-10-25).
  Check what the contract says the fix needs before promoting an adjacency into a dependency.
- **One row, one writer.** Another lane may hold write access to the same board: from 2026-10-26 the operator's own
  board-cleanup agent writes Jira directly. Before every write this lane makes, re-read the row live
  (status, parent, dates, labels, comments); if another writer changed it within the last hour, **do not write** and report
  the row instead. A stale snapshot is not evidence of ownership, and two writers on one row is a lost update with no error.
- **Quote the artefact, not the relay.** When a register, report or register-style file exists and a
  message summarises it, the file wins: quote it verbatim and state any divergence from the relay,
  including counts (a relayed "four S2" against five rows in the table). Never average the two, never
  pick the friendlier number.
- Status comments are plain language: what/why/evidence/UTC + ruling ref.
- **Plain writing for humans.** Jira descriptions and comments are read by operators, not machines. Write short plain sentences. Lead with what changed and what the operator needs to do. Keep ids and SHAs to one line at the end. No bullet walls, no robotic enumeration, no "as per" or "in accordance with". Operator ruling 2026-11-01 (B379): our output read too robotic; apply this to every post from now on.
- **Post operator comments only through `post-guard.py <KEY> <text-file> --run <WORD> --mention-first`.** The guard
  converts the `@operator` token into a real Jira mention node (`$PM_OPERATOR_ACCOUNT_ID`); a hand-built ADF `text` node renders `@operator` as plain text and
  notifies nobody, so an operator request can sit unseen while the board shows it posted. On 2026-10-31 comments
  16121 (ISSUE-561) and 16102 (ISSUE-198) were posted that way: both read correctly by eye and neither carried a
  mention. Fix in place with `post-guard.py <KEY> <text-file> --run <WORD> --mention-first --update <id>`,
  then re-read by id and assert `content[0].content[0].type == "mention"` with the right account id — the text being
  unchanged is not proof the mention landed.
- Peer fact-report text on its own issue may be posted after the owning lead's
  or the manager's one-line OK (weekend-coord ruling 2026-10-24); anything else
  needs the orderer's direct word, never a peer relay.
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
- Never edit project repos, never touch production (no deploys, merges,
  production restarts or timers; the lane's own processes are the helper's).
  Nothing in this skill authorizes a production change.
- One window per change, DRY first where the runbook demands it, deploy only
  inside the window's slot.

- **A gate keys on the RUN, not on the clock, and never on a pre-change green.** A promotion or HEAVY gate is
  satisfied by a run of the real workflow on the real branch created AFTER the merge that was supposed to fix
  it — not by the file's cron schedule, not by a manual dispatch on a side branch, not by a nightly that
  predates the fix. Measured 2026-11-01: `tests.yml` says `cron: "30 4 * * *"` while the only
  schedule-triggered run was created at 10:29Z, six hours later, so a clock-keyed gate watches an empty
  window and calls the nightly broken; and the last green nightly was green before the breakage, so accepting
  it would have closed the wrong row. Report the gate as `PENDING` (open, not failed) until such a run
  exists, and dedupe its own output on the run id, not on the stamped line, or it wakes someone every cycle.

## References

`references/audit-harness.md` — the audit's two halves: what the snapshot computes (`scripts/facts.py`),
the S0–S9 rubric with the two steps that need a model, the measured stability history, the calibration
limits, and why the v1 workflow was retired. Start here before running a batch.

`references/agentrun.md` — the CLI cookbook: what works (CLI, unmodified models.json), what does not
(the host `agentrun` tool), the standing `board-batch-verdicts-v3` workflow, and the two authoring
rules. Authoring changes go through `/agentrun-author`.

`references/batch-protocol.md` — per-batch mechanics (search, writes, date discipline, Substrate lane)
with the Blocked-101 trap. Jira ids live in `project-management/references/jira.md`; board
discipline (window closing, slot clearing, one plan per day) lives there too.

`references/waiting-production-audit.md` — the Waiting Production audit (MMD-3180, 2026-10-30): "deployed" means the merge is an ancestor of the RUNNING image SHA of every service the PR touches (the project's deploy-status command), never of `stable`; a row is WP when every build vehicle is merged and no prerequisite whose output its own step consumes has yet to run; bind a row to its governing vehicle, not to any `#n` mention.

Judge instrument (rule for every Jev or model judge node in this skill): no node is trusted before a calibration harness passes on a held-out seed (MMD-2673), and a Jev-only verdict caps at REVIEW. MANIFEST.json lacks the model id (H20), so record `PM_AUDIT_MODEL` in the run's journal entry.

`references/verification.md` — the re-read checklists, the duplicate-check and crash-recovery rules,
and the index-lag rule.

`references/lane-automation.md` — the helper's own machinery, learned the hard way: state files are
interfaces (read the consumer before reshaping one), prove a filter before trusting its result, one
watcher that advances its own baseline, and one write path that identifies itself. Read it before
changing anything under `$PM_LANE_DIR/`.

First-time setup (prerequisites, variables, config keys per script family): `references/setup.md`; the lane's
own settings and processes: `references/setup-lane.md`.

Scripts: `scripts/run-audit.sh` (driver), `scripts/facts.py` (snapshot + facts + selftest),
`scripts/aggregate.py` (odd-N majority), `scripts/check.py` (guard before committing). Workflow:
`workflows/board-batch-verdicts-v3.json`.

Continuous helper (lane) scripts live in `scripts/lane/`: `scheduler.sh` (the loop, one process owns every due-time),
`cycle-run.sh` + `cycle/cycle.py` (one read-only pass, one `CYCLE-<HHMM>Z.md`, one summary line), `wp-audit.py`,
`route-watch.py`, `deadman.py`, `post-guard.py`, `mark-sent.py`, `route-forward.py`. These are
durable copies; the scheduler runs from here. `deadman.py` loads an optional local watchdog module from the
setting `PM_LANE_WATCHDOG`; none ships with the pack. Per-lane state (events.log, pending-routes.jsonl, own-writes.txt,
CYCLE-*.md, WITHHELD-*.json) stays in `$PM_LANE_DIR/` and is not committed.
Board hygiene and status drift with live positive/negative controls: `scripts/cycle/hygiene_cycle.py` (predicates H1-H4, O1, N1-N2, one real control pair per predicate, and a Jira-side drift sweep; `--since=<date>` replays a day to prove the instrument); predicates and control rules in `references/hygiene-predicates.md`. Code readiness of epic children (is the code built, in a PR, partial or missing): `scripts/readiness/run-readiness.sh`
with `workflows/code-readiness-v1.json`; cookbook row and lessons in `references/agentrun.md`.
