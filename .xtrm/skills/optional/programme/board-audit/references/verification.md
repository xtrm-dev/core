# Verification checklists

## Per row (every write)

1. Pre-read: status, parent, dates, labels all match the proposal's "current".
2. Write: exactly the ruled change, response 200/201/204.
3. Post-read: new state == proposal's "should be"; everything else identical
   (status unchanged on moves; calendar byte-identical on reparenting).

## Before posting, and after a crash

- **Duplicate check before posting.** List the issue's comments and search them for the thing you
  are about to say. A retry after a failure can double-post what already landed: the POST may have
  succeeded before the script died, so the artefact can exist while the tool reports an exception.
- **A claim about what the board says is checked by scanning the board, never by trusting the sender.**
  Paginate the whole comment history and parse the first line: shape plus id. Two hops of an unchecked
  claim is how a stale note becomes a permanent comment. Seen twice in one hour on 2026-10-26: a stale
  caveat set said six files had been relayed as PASS, the helper carried it to the coordinator, and a
  correction post was ordered for a defect that did not exist. The board scan settled it in one query.
- **Match the formal shape, never a bare identifier.** A bare identifier in a comment proves the
  string exists, not that the verdict was posted: it matches the uploader's own list of batch names,
  an `MMD-` ref inside prose, an `ISSUE-` number inside a sentence. Search for the shape that only the
  intended comment can carry — `VERIFIED <batch>`, `PR-link <repo>#<n>` — and treat a hit on the bare
  name as no evidence either way. Seen three times on the Mercury board before it became this rule.
- **Inspect actual state after a crashed write**, before retrying: read the fields and the comment
  list and write only what is missing. A half-applied batch is recovered by reading, not by
  re-running.

## Per batch

- Children counts per Epic sum to stories + moved items; `parent = <old>`
  returns only the planned keeps.
- Ancestry for ship claims: `git merge-base --is-ancestor <sha>
  origin/stable` after `git fetch origin stable`.
- Label sets: diff pre/post, explain every delta.

## Controls before trust (every new check)

- State the property in one sentence before writing the predicate that tests it.
- Prove the predicate with one positive control (an item that must match) and one negative control (a near miss that must not) before trusting a "none".
- **The control comes from the artefact the probe reads.** A positive control built from anything else — the
text you are about to post, a row summary when you are probing comments — declines the item it should
flag, and the probe's "not yet posted" then rests on nothing. Two instances on 2026-10-26, one built from
a pending message and one from a summary instead of the comment list; both were caught by the control
itself, which is the only reason they cost minutes rather than a double post.
- Record both controls beside the check; a silent result with no recorded controls is not evidence.
- **A control query must request the fields it reads.** `/search/jql` returns only the fields you name, and
  naming none of them drops the `fields` object entirely, so a control that reads `f['status']` raises
  `KeyError` instead of reporting the gap it was built to expose (2026-10-26). Request the field, or read
  defensively and say which branch you took.
- Re-prove after any re-arm or baseline reset: a watcher that recaptures its baseline absorbs the event it watches for.
- A thresholded check needs three samples, not two: below the threshold (silent), at the threshold (fires),
  and well above it (silent again under a higher setting). Two points cannot tell a working detector from
  one whose threshold is off by a factor — `600` written as `6000` passes "fires at 5 s" and "silent at
  600 s" and stays silent through the failure it exists to catch.
- Derive the threshold from the observed cadence, and test it against the healthy state, not only the
  failing one. A watchdog for a loop that lands a round every 1800 s caught a 600 s threshold firing on
  every healthy cycle, ~20 minutes before the next round was due — every test had sampled the moment just
  after a round, when the age is small (2026-10-26). A guard that cries wolf is invisible for the same
  reason one that expires early is: it looks armed and it looks like it works. Sample the worst point of
  the duty cycle, just before the next event is due.
- **A deterministic-zero instrument is not a measurement.** `sb issue query` rows carry no `closedAt` and
  the page paginates, so "Substrate issues closed today" cannot be derived from it; a zero from a shape that
  cannot express the answer is a gap to report, not a clean result. Test the instrument against an item you
  know is closed before reporting its zero (2026-10-26).
- A detector's inputs come from the record itself, never from filesystem metadata. A watchdog that reads
  file mtime treats a rotation, a `touch` or any other writer as liveness; measured 2026-10-26 by
  planting a 436 s-old line and `touch`ing the file: the age stayed 436 s because it came from the line.

Seven checks failed this way in one night (2026-10-26): a freeze identified by PR title instead of the
allowlist paths it touches, a `gh --jq` flag that failed where the shell pipeline succeeded, an overdue
list that counted a `folded-into:*` ticket as late, halt collisions read from summary keywords instead of
season-aware windows, a reversed precondition direction, a CPU pressure series read for a memory gate,
and a watcher baseline recaptured on every re-arm.

- **No verdict is not a failure.** CI conclusions are not two-valued: the last 60 runs of market-data
  measured 2026-10-26 were success 49, skipped 5, failure 4, cancelled 2. A `cancelled` or `skipped` run
  says the check did not decide, so a board cell that reads "fails CI" off it is wrong in the same way a
  zero from a broken filter is wrong. Report the categories with their counts, never a pass/fail collapse
  (mon-coord's spot-check caught a map asserting "fails CI" on a run that was 6 cancelled + 1 skipped).

## Citations for agent-produced findings

A subagent's finding is a claim, and a claim about a row survives only if its citation contains it. Before
accepting a batch, open one citation per finding and check three things: the artefact exists, the cited span
says what the finding says, and the count reconciles with the rows listed.

Two passes on one sprint audit (2026-10-31, 253 rows) show why:

- **pass 1** returned a verdict the row's own text contradicts — the citation named a comment that argued the
  opposite. The citation check caught it; the gate was fine, the verdict was invented.
- **pass 2** passed the citation gate and still produced only false verdicts: every escalated row was in a
  legal state. A gate that proves a citation exists does not prove the inference from it.

The rule that follows: an agent reports facts per row (status, dates, links, last comment id) and no
disposition. Bulk status adjudication stays with the lane that owns the board, because a verdict the coordinator
must disprove costs more than the sweep saved.

## Index-lag rule

Jira `parent =` search lags moves by seconds-to-minutes. A missing child on
first query proves nothing: GET the row directly (authoritative), then
re-query with sleeps until it converges or a bound is hit. Never roll back a
row whose direct re-read is correct.

## Close and block

Window closing and slot-clearing discipline is **not** repeated here: it lives in
`programme-coordination/references/jira.md` under window discipline (close on a coordinator
Verified OK, never on a deploy having started; a blocked window clears its slot in the same edit;
a passed slot with no record is unrecorded, not failed).

## Correction discipline

Own transcription slips in the open: name the row, the wrong value, the fix,
and the session it was fixed in. The journal carries corrections as first-class
entries, not footnotes.
