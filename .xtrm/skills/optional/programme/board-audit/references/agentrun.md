# AgentRun cookbook for board batches

Authoring is owned by `/agentrun-author` — read it before drafting or changing a workflow.
Facts, the S0–S9 rubric and the measured stability history live in
[`audit-harness.md`](audit-harness.md); the coordination discipline (describe → inspect → run,
the `--trusted` rule, "verdicts are claims", peer claims are untrusted) lives in
`programme-coordination/references/agentrun.md`. This file is the cookbook: what to run, and the
two authoring rules that decide whether a batch is worth running at all.

## What works, as of 2026-10-22

**The CLI path works and needs nothing.** `createPiRunner` goes through
`createAgentSession`, which adds the provider-attribution headers itself, so a complete run is
produced against the **unmodified** `~/.pi/agent/models.json`. Standing operator ruling: models.json
stays unchanged.

**The host `agentrun` tool does not work for this family.** Its child session is built with
`createPiHostSessionFactory` (bare `Agent` + raw `streamSimple`) and omits the attribution headers,
so `opencode-go` answers 400 `MissingSessionID` (missing `x-opencode-session`), which the extension
reports as `model_response_failed` with the provider text stripped. The only way to make the tool
work is a header overlay in models.json — ruled out. Use the CLI.

Consequence for specialist activations: a specialist that runs this workflow inherits the host-tool
path and will fail the same way. Run board batches from the CLI; keep the specialist for the parts
that do not judge.

## The standing workflow: `board-batch-verdicts-v3`

`workflows/board-batch-verdicts-v3.json`. It judges supplied snapshot rows against a pinned rubric
and never fetches. Chain of three: empty-rows escalate, `map` of `decide` per row, `extract`
assembles the typed `BatchReport`. No code nodes, no tool calls, no trusted command.

Host boundaries (from `describe`; re-check when the host changes): 50 model requests per run, so
chunk inputs to **at most 40 rows** (40 decides + 1 assembly). `jev: false` — `judge`/`sift`/`pick`
and question-`route` are unavailable; `decide` plus `valuePath`-`route` only. Calibrated-confidence
shadow mode stays out for the same reason: no calibration harness exists. The workflow sees
only its input; the snapshot script is the evidence gate.

The retired v1 (`board-batch-verdicts.json`) is documented in `audit-harness.md`: it is gone for
shape defects (no `not_applicable`, a model node transcribing verdicts), not for flapping.

## Concrete steps (every batch)

```sh
export AGENTRUN_PI_ROOT="$(npm root -g)/@parcha/agentrun-pi"
export JIRA_EMAIL=...            # required, no default
export JIRA_TOKEN_FILE=~/.secrets/atlassian-api-token.txt

cd skills/optional/programme/board-audit
python3 scripts/check.py                 # literals + selftest, before anything else
./scripts/run-audit.sh 3 2026-10-22      # snapshot -> 3 runs -> majority
```

1. **Snapshot first** (direct API, the one allowed loop). `scripts/facts.py --day <date>` writes
   `{batch_id, rubric, rows[]}` with live fields and every computed fact folded into `evidence`.
   Refuse a snapshot older than an hour.
2. **Author or change** via `/agentrun-author`: smallest graph, inspect, repair, re-inspect. Never
   run what does not inspect clean.
3. **Record** the workflow revision and the input hash in the batch proposal.
4. **Run** three times (odd N), then `aggregate.py` — majority in code, refusing any run that is
   not `complete`.
5. **Sample-check** the majority against live state before acting; a run that fails the sample
   check is discarded, not applied. The check is a 5-item list, not a feeling: oracle present?
   evidence quotes the relied-on fact? counts reconcile? snapshot younger than one hour?
   input hash recorded in the batch proposal?
6. **Apply** row by row per the apply protocol, on the coordinator's word. The workflow never
   writes to Jira, Substrate or GitHub.

## The two authoring rules that decide whether a batch is worth running

1. **Precompute relations, decide absence.** Anything relational (slot overlap, ordering between
   rows) is computed by `facts.py` and carried in the row: a `map` body sees one row only. And every
   rule that can be *not applicable* must say so explicitly ("if `prerequisite` is `none`, the rule
   does not apply"). Without the second, verdicts flapped between identical runs.
2. **Code computes, the judge judges.** The row carries an `oracle=` verdict from S0–S8 and the
   judge must match it or name the contradicting fact (S9). This is the change that took the same
   ten rows from an unstable rubric to 0 disagreement across three runs. If a rule cannot be
   precomputed, it belongs to S4 (is this one deploy in one slot?) and nowhere else.

Both halves, stated once: a stable rubric can be stably **wrong**, so the snapshot facts are the
thing to test, and a verdict is a claim, so no harness verdict substitutes for a coordinator's
Verified OK.

## Heavy Substrate context: pre-export, never live-fetch

For batches that need Substrate evidence (precondition checks naming MMD refs,
theme mapping across work-lists), the judge must not call `sb` live. The workflow
has no tool calls by design; live-fetching breaks the evidence gate and the
40-row budget.

Pattern, measured 2026-10-22: a full `sb export project --project prj_mmd`
is ~19 MB — unusable as model input. Export once, filter in code, fold the
selection into the rows:

```sh
# one export to the run dir, outside the repo
sb export project --project prj_mmd --file "$RUNS/sb-export-$STAMP.json"
# facts.py selects only the refs the day's windows name (subjects +
# dependencies; references are provenance, never gates) via
# `sb issue show <ref> --json` / `sb journal show <ref> --limit <n> --json`,
# and folds them into each row's `evidence` as the existing
# named_subject / named_blocker_required facts with state tags.
```

Rules: the filtered selection (not the 19 MB dump) enters the model input;
record the export hash with the workflow revision and input hash in the batch
proposal; refuse Substrate evidence older than one hour, same as the Jira
snapshot. `scripts/check.py` enforces the freshness gate.

## Verdict cache (adopted pattern, not yet wired into run-audit.sh)

Same measured stability at lower cost: cache per-row verdicts keyed by
(input hash + workflow revision) and skip re-judging unchanged rows. The cache lives
outside the model, so the evidence gate and the odd-N code majority are untouched.
Wire it into `run-audit.sh` only with a run that proves identical majorities with and
without the cache.

## Cookbook (batch shape → what to reuse)

| Batch | Rubric | Input source |
|---|---|---|
| Title/date hygiene sweep (B2 pattern) | Approve strips/keeps against the title rules + date-field presence | snapshot of title + date fields |
| Precondition check (Batch E pattern) | Approve when the named PR/state/owner evidence holds live | window Tasks + PR states |
| Theme mapping (C2/G2 pattern) | Approve primary when evidence names the theme family or a sibling there | story work-lists + Relates graph |
| Status-vs-evidence sweep | Approve transitions when slot/evidence/status agree | windows with a past end slot |
| PR-link top-up + drift sweep (measured 2026-10-24: 18 rows, 0 disagreement) | Approve when the slot still holds and no Jira-visible defect exists; `reject_needs_evidence` for Blocked and for stale dates (S1/S5) | window-labelled rows touched since the last ledger stamp, plus PRs merged/opened since that stamp |
| Code readiness of epic children (MMD-3015, 2026-10-28: 168 rows, 15 runs, 29 run disagreements, 23 deep-read overrides) | R1-R7 (`scripts/readiness/RUBRIC.md`): code computes the oracle (OPEN_PR/PARTIAL/SUPERSEDED/BUILT); the judge only rules the rest; every NOT_BUILT/PARTIAL/NEEDS_HUMAN row is deep-read by a worker, because the model majority is NOT the answer | `scripts/readiness/run-readiness.sh [N]` from a market-data checkout: Jira epic snapshot + Substrate own-vs-mentioned refs + PRs tied by key/own ref/'Jira binding:' footer with master/stable ancestry + last 6 master commits per contract path + remote branches with no PR; selftest of 7 positive/negative controls must pass; workflow `workflows/code-readiness-v1.json` |
| New shape | Author ad-hoc, inspect, save under `workflows/`, extend this table | per need |

## Maintenance duty

After every session that uses or extends these workflows: update the table, prune dead revisions,
run `scripts/check.py`, and re-validate the skill. A workflow that no longer matches the board is
deleted, not left to mislead. New batch shapes climb a promotion ladder: ad-hoc shape under
`workflows/` + cookbook table row, then measured stability runs as the promotion test, then prune
or keep. Bulk guardrail: one shape per change, at most three live candidates.

## Code-readiness lessons (MMD-3015, 2026-10-28)

- A filter is proven only by controls: the first facts script failed 3 of 6 (a since-contract filter hid a PR that predates the contract; refs mentioned in text were taken as the row's own; an OPEN_PR oracle fired on PRs only named in prose).
- A Substrate ref has a role: own subject (labels, else the first refs) versus context. Only own refs tie PRs and branches.
- A remote branch with no PR is PARTIAL, not NOT_BUILT; a deploy/flip row is OPERATIONAL only when the deployed change is on master.
- `gh` run outside a git checkout returns empty PR bodies: pass `--repo`.
- Majority agreement with an independent manual table was 45/100; after deep reads 60/100. Budget the deep-read pass; it is where the answer is.
