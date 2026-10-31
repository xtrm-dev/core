# The audit harness: snapshot, judged verdicts, deterministic majority

The audit is two halves that must not be confused. **Facts** are computed in code and are the
only thing allowed to be authoritative about relations and arithmetic. **Judgments** are the
model's job, and there are exactly two of them: is this one deploy in one shared slot (S4), and
does the judge agree with the code verdict (S9). Everything else is code.

A verdict from this harness is a claim, never a decision. `approve` means "no Jira-visible
defect" — it has never meant "this window will succeed", and the one time it was treated that way
in the same week (ISSUE-459 scored approve, then failed operationally), the board was right and
the harness was honest about its own blind spot.

## One command

```sh
cd skills/optional/programme/board-audit
./scripts/run-audit.sh 3 2026-10-22      # a day's windows
./scripts/run-audit.sh 3                 # the pinned sample rows
```

Requires `AGENTRUN_PI_ROOT` (the `@parcha/agentrun-pi` install root), `JIRA_EMAIL` and
`JIRA_TOKEN_FILE`. Receipts go to `$MMD_AUDIT_RUN_DIR` (default
`~/.local/state/mmd-board-audit`), never into this repo.

Files: `scripts/facts.py` (snapshot + facts + `--selftest`), `workflows/board-batch-verdicts-v3.json`
(the judged workflow), `scripts/aggregate.py` (odd-N majority, refuses a run that is not
`complete`), `scripts/run-audit.sh` (driver), `scripts/check.py` (guard before you commit).

## Facts (computed, never judged)

| Fact | Meaning |
|---|---|
| `same_slot_cluster` | two Tasks of one parent whose windows overlap. A fact about windows only; whether the two Tasks are **one deploy** is the judge's S4 |
| `order` | each predecessor's `cf38` in UTC against this row's `cf37`, printed as holds/violated with both times |
| `expected_band` | the window converted to UTC and compared with the band its Task type requires. Today the only band is the CME daily halt 21:17–21:55Z for tick-ingestor changes |
| `named_pr` / `named_subject` / `named_blocker_required` / `named_reference_only` | every PR and Substrate mention, classified and state-tagged (`SATISFIED`, `BLOCKING`, `STALE`, `HISTORICAL`) |
| `stable_check` | for a precondition that says "on stable"/"promotion", whether the merged commit is an ancestor of `origin/stable` |
| `stated_preconditions` | the sentences that state a blocking condition, quoted. The judge reads the quote; this function never decides "met" |
| `oracle` | the code verdict for the row, from S0–S8. The judge must match it (S9) or name the contradicting fact |

Three classification rules earn their place by the wrong verdicts they fixed:

1. **A Substrate mention has a role.** *subject* ("Substrate MMD-2412" — the work the window
   ships), *dependency* ("needs MMD-2481 ruling"), or *reference* ("Source:
   schedule-proposal-v3 (MMD-2534)" — provenance). References are never gates. Treating a
   reference as a dependency rejected a job-only window (ISSUE-327) on a PR belonging to a
   scheduling proposal.
2. **A merged PR can be too old to satisfy.** Merged at least 7 days before now is `STALE` and
   cannot satisfy a per-window precondition such as "each MCP window needs its own rotation";
   a closed-unmerged PR that old is `HISTORICAL`. The threshold is **global, measured from now,
   fitted to one observed case (PR #879)**: it is provisional and nothing may describe it as
   calibrated.
3. **A closed window is not a plan.** Terminal status (`Done`, `Completata`, `Won't Do`,
   `Cancelled`, `Done with Follow-up`) gives `not_applicable` at S0, so a closed window cannot
   be judged as if it were schedulable.

## Rubric S0–S9

| Step | Rule | Decided by |
|---|---|---|
| S0 | terminal status → `not_applicable` | code |
| S1 | bounds present, start < end, due not before the start date | code |
| S2 | `expected_band` | code |
| S3 | `order` | code |
| S4 | `same_slot_cluster`: one deploy in one slot is allowed, two changes is not | **judge** |
| S5 | status Blocked → reject, stating whether an unblocking condition is recorded | code |
| S6 | a `BLOCKING` fact rejects; `SATISFIED`, `STALE`, `HISTORICAL` and references do not | code |
| S7 | `stated_preconditions`: none stated is not a defect; shown unmet rejects; stated-but-unprovable is `approve_with_change` | code |
| S8 | nothing failed → `approve` = no Jira-visible defect, never GO | — |
| S9 | the row carries `oracle=`; the judge matches it or names the contradicting fact | **judge** |

## Stability history, stated precisely

| Run | Input | Result |
|---|---|---|
| v2, 2 runs, 2026-10-21 | 10 Thursday rows, loose rubric | 5 of 10 verdicts differed **between those two runs on a changed input**; the determined rubric on the same setup then gave 0 of 10 |
| v2, 2 × 30 PRs | PR batch | 0 of 30 both times, but degenerate: no window linkage, so R4 rejected all 30 uniformly |
| v3 first pass | 10 rows | 2/10 labelling disagreements (`not_applicable` vs `approve`), fixed by reserving `not_applicable` for skipped rules |
| v3 second pass | 11 rows | 1/11 |
| **v3 final, 3 complete runs** | **11 rows 2026-10-22** | **0/11 disagreement, no majority gaps** |
| **v3 final, 3 complete runs** | **10 rows 2026-10-23** | **0/10 disagreement, no majority gaps** |

Two lessons that must survive with those numbers:

- **Consensus is not correctness.** The most stable configuration of the earlier rubric was
  stably **wrong**: it rejected ISSUE-182 and ISSUE-306, which share one deploy, and approved
  ISSUE-457 whose window sat outside the halt band. Agreement across runs measures the
  authoring, not the truth. The facts are the thing to review; the selftest is the gate.
- **A tool verdict is a claim.** Sample-check before acting, and never let the harness's
  `approve` stand in for a coordinator's Verified OK.

## Why v1 was retired

`workflows/board-batch-verdicts.json` (blob `76b32e5f3c95f225636942e9cb1cced1b3c545b1`) is gone
for **shape** defects, not for flapping: it had no `not_applicable` value in a closed enum, and it
asked a model node to transcribe and count verdicts (`extract`) where code belongs. Both are
authoring defects that the reviewer listed before any measurement. It measured 0 of 30 twice on PR
batches; the 5-of-10 figure I first attributed to it came from a different input and a looser
rubric.

## Adopted from awesome-jev (2026-10-22, MMD-2740)

Studied via the deepwiki CLI (`toc` + full `wiki` + `ask`); 10-item proposal, 8 folded in, 2 rejected below.

- **Tri-state gate vocabulary.** Verdicts read as clean/advisory/fix_now/abstain:
  `approve`=clean, `approve_with_change`=advisory, `reject_needs_evidence`=fix_now,
  `not_applicable`=abstain. The enum is unchanged; naming the mapping kills the
  v3-first-pass `not_applicable`-vs-`approve` confusion class. Mirrored in the RUBRIC
  preamble and the workflow's judge instructions.
- **Fail-open vs fail-closed gates.** S0 (terminal window) fails OPEN: a closed window
  is never a plan and can never reject. S5 (Blocked status) fails CLOSED: a Blocked
  window rejects even when every other fact is clean. The 1-hour freshness refuse is
  the circuit breaker. No new workflow nodes.
- **Rejected and kept out:** model-side majority / pairwise ranking (reintroduces the
  transcription flakiness v1 was retired for; code majority in `aggregate.py` is
  strictly stronger and measured stable) and calibrated-confidence shadow thresholds
  (require a calibration we explicitly do not have; revisit only with `jev:true` + a
  jevcal-style harness).

## Adding a fact

Add a pure function to `scripts/facts.py`, add a case to `selftest()`, run
`python3 scripts/check.py` (16 checks today; network cases report SKIP, not pass), then mention
the fact in the rubric text and in this file. If the fact changes a verdict, say which window it
would have got wrong before.
