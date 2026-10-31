# Programme sequencing to a hard stop (board-audit reference)

Folded from MMD-2909 (built 2026-10-26) on 2026-10-30 by MMD-3192 (fri30-coord ruling: fold now; operator: "the proven
and not in any skill, should be used"). Read `audit-harness.md` and `agentrun.md` first. This file reuses their rules:
facts in code, a determined rubric, an oracle on every row, the odd-N majority in code, and verdicts are claims.

## 1. When to run

- A coordinator plans the days before a programme stop (the current stop is 2026-11-05).
- The board changed enough that the last plan is stale: new windows, merged PRs or new programme items.
- Do not run it to decide one window. A single window is a batch row (`batch-protocol.md`).

## 2. What it answers

| Question | Node | Verdict set |
|---|---|---|
| Which booked windows and open PRs share one window and one promotion? | K (bundles) | bundle, partial, split |
| Can a later open PR rewrite or revert code that an earlier change put in place? | P (pairs) | real-conflict, needs-order, benign, needs-review |
| What happens to each programme item that has no window? | I (items) | bundle-into, own-window, defer-after-11-05, zombie-close, no-window-needed |
| Does each calendar day fit the deploy rules and leave verification time? | D (days) | fits, over-capacity |
| How few promotions meet every deploy deadline? | code only (`promotion_plan`) | a list |
| What landed, and what did it touch? | code only (`landed_table`) | a table |

The workflows judge precomputed rows. They never fetch, call no tool (`tools: []`) and write nothing.

## 3. Inputs

- Jira: open ISSUE rows, the Epic 198 tree, and windows with their comments (read-only, through `jira.py`).
- Substrate: the export, plus the claim, journal and contract of every open issue.
- GitHub: open PRs and PRs merged since a date, each with changed files, hunk symbols, config keys and SQL objects.
- git: `git fetch` only. The script reads master/stable ancestry, fetches PR heads by SHA, and reads the ancestry of each open PR.
- `MMD_REPO`: the checkout whose `origin/master` and `origin/stable` are read. `MMD_JIRA_PY`: the path to `jira.py`.
- `MMD_AUDIT_MODEL`: the chat model as `provider/model-id`. Use `commandcode/deepseek/deepseek-v4.1-flash`. Do not
  use `opencode-go/*`: it fails twice (400 MissingSessionID, then 401 Invalid credential; section 7).

## 4. Files (under `scripts/sequencing/`; each file runs from its own directory)

| File | Role |
|---|---|
| `snapshot_plan.py` | Read-only snapshot of Jira, Substrate, GitHub and git. Writes `snap/*.json` with a fetch stamp each. |
| `facts_plan.py` | Deterministic facts and the code oracle for every row. `--selftest` holds the controls. Refuses a snapshot older than one hour. |
| `build_workflows.py` | Writes `workflows/programme-seq-{bundles,pairs,items,days}-v1.json` and `rubrics.json` from one template. |
| `run_plan.py` | Load-gated driver: one AgentRun per chunk of at most 40 rows, one identical retry, MANIFEST.json with hashes. |
| `aggregate_plan.py` | Compares two runs: verdict flips, field flips, disagreement with the oracle, overrides. |
| `finalize_plan.py` | Places the judged own-window items in slots and rebuilds the day rows. |
| `build_plan.py` | Compiles the plan document from facts and verdicts. |
| `reuse_plan.py` | Reuses verdicts of byte-identical rows (same rubric hash); sends only changed rows to AgentRun. |
| `run-sequencing.sh` | The whole procedure in one script (section 5). |
| `agentrun-config.mjs` | Stock `createPiRunner` config; the model comes from `MMD_AUDIT_MODEL`. |

## 5. Procedure

Preconditions: the memory gate holds (PSI full avg10 <= 10, MemAvailable >= 4 GB), load1 <= 10, and no other AgentRun
is live. `run_plan.py` checks load1 and PSI itself and waits at most 300 s.

1. Set the environment.
   ```sh
   export AGENTRUN_PI_ROOT="$(npm root -g)/@parcha/agentrun-pi"   # the package root, not the bare npm root
   export MMD_REPO=<market-data checkout>
   export MMD_AUDIT_MODEL=commandcode/deepseek/deepseek-v4.1-flash
   cd ~/.xtrm/skills/optional/programme/board-audit/scripts/sequencing
   ```
2. Run the selftest. Expect `selftest: <n> pass, 0 fail`. If one check fails, stop and report it.
   ```sh
   python3 facts_plan.py --selftest | tail -1
   ```
3. Take the snapshot (about 2 minutes, read-only). Then compute the facts (about 2 seconds).
   ```sh
   python3 snapshot_plan.py --out snap
   python3 facts_plan.py --snap snap --out run
   ```
4. Judge each node (pairs, bundles, items) twice. Compare the two runs. Run a third time only on the flipped keys.
   ```sh
   python3 run_plan.py --node pairs --rows run/rows-pairs.json --out runs/r1-pairs-1     # then -2
   python3 aggregate_plan.py runs/r1-pairs-1 runs/r1-pairs-2                              # flips, mismatches, overrides
   python3 run_plan.py --node pairs --rows run/rows-pairs.json --out runs/r1-pairs-3 --keys <flipped keys>
   ```
5. Place the own-window items in slots. Judge the days twice.
   ```sh
   python3 finalize_plan.py --snap snap --facts run/facts.json --tag r1 --out run-final
   python3 run_plan.py --node days --rows run-final/rows-days.json --out runs/r1d-days-1   # then -2
   ```
6. Build the plan.
   ```sh
   python3 build_plan.py --facts run/facts.json --tag r1 --days-tag r1d --out PLAN.md
   ```
Steps 2-6 in one command: `./run-sequencing.sh r1`. After a load-gate stop, resume with `SKIP_SNAPSHOT=1`
(the facts still refuse a snapshot older than one hour).

## 6. Output (shape of `PLAN-1105.md`)

| Section | Content |
|---|---|
| 0 | Provenance (snapshot stamps, hashes, model) and the stability of the judged runs |
| (a) | Calendar as booked, one block per day to the stop |
| (b) | Promotion bundles and order: b1 landed picture, b2 fewest promotions that meet every deploy deadline, b3 judged window bundles |
| (c) | Rewrite and revert risk: judged pairs, the strongest pairs with files and symbols, landed-after-landed candidates (code only, low precision) |
| (d) | Unwindowed programme items, grouped by verdict (own-window, bundle-into, zombie-close, no-window-needed, defer-after-11-05) |
| (e) | Capacity per day (fits or over-capacity, with the D rule) |
| (f) | Numbered PROPOSALS for the coordinator; nothing is applied |
| end | Corrigenda and judge-oracle mismatches |

The plan is a proposal. Every Jira change it suggests goes through `batch-protocol.md` on the coordinator's word.

## 7. Rules in code

Pair rules P0-P6, bundle rules K1-K5, item rules I1-I7 and day rules D1-D6 are written in `facts_plan.py` and quoted
in each rubric; the rule id appears in every verdict's `rule` field. Strong overlap means: a shared symbol in one
file, a shared config key, a shared SQL object, or two new alembic revisions. Doc, test, CI, dependency and data files
never count. The judge may differ from the oracle only at the semantic steps J1 (P: a revert word about a different
subject or a generic helper name; I: the item ships nothing; K: the same operation repeated by design). A difference
must start with `OVERRIDE:` or `J1` and name the field.

## 8. Controls and their recorded results

| Control | Recorded result | Source |
|---|---|---|
| Selftest (positive and negative fixtures for each rule family) | 82 pass, 0 fail, 1 skip ("live controls need a snapshot"), run 2026-10-30 by MMD-3192; the 2026-10-26 text said 89 checks | `facts_plan.py --selftest` |
| Stability, bundles | 7 rows, 0 flips, 0 differ from the oracle | MMD-2909 reference, line 73 |
| Stability, pairs | 181 rows (all non-P5 pairs plus 25 P5 controls), 3 flips, 3 decided by a third run, 0 unstable, 11 differ from the oracle | line 74 |
| Stability, items | 313 rows, 6 flips, 6 decided by a third run, 0 unstable, 14 differ from the oracle | line 75 |
| Stability, days | 11 rows, 0 flips, 0 differ from the oracle | line 76 |
| Replay, positive | `runs/p1-bundles-1/input-01.json` through `programme-seq-bundles-v1` on commandcode/deepseek/deepseek-v4.1-flash: exit 0, status complete, 10 verdicts; diff against `run-01.json`: 10/10 identical (verdict AND rule), 2026-10-30T11:18:52Z | `p5-replay-evidence.md` lines 2, 19, 22 |
| Replay, pinned inputs | input sha256[:16] 978771fcfb76a351 and workflow 0c91bc6f9c7c1757 match the manifest | lines 10-11 |
| Replay, negative | the recorded model opencode-go/deepseek-v4.1-flash: exit 1, `model_error (1 turns, 0 submissions)` | line 20 |
| Provider probe | no session header: HTTP 400 MissingSessionID; key + `x-opencode-session`: HTTP 401 Invalid credential | lines 53-55 |

The 2026-10-26 runs used opencode-go/deepseek-v4.1-flash, thinking low, tools none (MMD-2909 reference, line 69).
Agreement across runs measures the authoring, not the truth; the facts and the selftest carry the correctness.

## 9. Gates

- Load: load1 <= 10 and PSI full avg10 <= 10 before every chunk (`run_plan.py`, `LOAD_MAX, PSI_MAX = 10.0, 10.0`).
- One AgentRun at a time; the driver refuses to start while another AgentRun is live. At most 2 model-calling runs
  on the host (fri30-coord ruling).
- Chunks of at most 40 rows (the host allows 50 model requests per run).
- One identical retry per chunk. A second failure stops the driver and prints the command and the error.
  The driver never substitutes a per-item call.

## 10. What a failure looks like

| Symptom | Meaning | Action |
|---|---|---|
| `selftest: ... <n> fail` | a rule or fixture is broken | Stop. Report the failing check. Do not take a snapshot. |
| facts refuse the snapshot | the snapshot is older than one hour | Take a new snapshot. |
| `GATE: waited 300s: load1=...` | the host is busy | Wait. Resume with `SKIP_SNAPSHOT=1` inside the hour. |
| `model_error (1 turns, 0 submissions)` | the provider rejected the call (opencode-go: 400/401) | Set `MMD_AUDIT_MODEL` to a commandcode model. |
| `model unavailable` for a three-segment id | the config split the id at every slash | Fix `agentrun-config.mjs` (split at the first slash). |
| a row with no majority after the third run | UNSTABLE | Report the row as UNSTABLE. A person rules on it. |
| many oracle differences without `OVERRIDE:`/`J1` | rubric drift | Stop. Review the rubric. Do not build the plan. |

## 11. Judge instrument (applies to every judge node in this skill)

The MMD-2673 calibration harness is the only instrument that measured a judge against known answers. Use it before a
Jev or model judge node is trusted, and again after a rubric, model or threshold change.
Where it is: Substrate MMD-2673 (title "Operator-directed tests and CI worker"; the harness work was done under it on
2026-10-22, holder MMD-2673-tests-ci). Code on master: `scripts/dev/test_audit/judge/` (workflow.json, rubric.py,
run.sh) and `scripts/dev/test_audit/calibration/` (build_corpus.py, score.py, README.md). Run driver:
`~/.cache/MMD-2673/run_calib2.sh CALIB_DIR N`. Jev config: `~/.cache/MMD-2673/agentrun-config-jev.mjs`.
The r7 result: `~/.cache/MMD-2673/v7/calib-r7-seed20271120/scores/metrics.md` (held-out seed), copied to
`~/.cache/MMD-2673/calib-r7-heldout-metrics.md`.

Method:
1. Plant cases with known labels next to real originals (for the test audit: hollow, weakened, mirror and syntactic
   plants, 120 rows).
2. Tune on one seed. Freeze the rubric. Score once on a held-out seed that tuning never saw.
3. Run each input in two replicate sets (r7: 15 runs). `score.py` exits 1 when any bar fails.

What pass looks like (r7 held-out, `calib-r7-heldout-metrics.md` lines 3-9 and 19-26): `rows=120 runs=15 overall=PASS`;
syntactic recall 1.0 (bar >= 0.95); mirror recall 1.0 (bar >= 0.70); original DELETE false positives 0 (bar == 0);
overall flip rate 0.0167 (bar <= 0.02); delete-eligible flips 0; replicate disagreement 0/120.
The r7 tuning seed failed one bar: flip rate 0.0417 (`calib-r7-tuning-metrics.md`, line 9). Only the held-out score
decides; a tuning-seed pass is not evidence.

Rules:
- A judge node leaves shadow only after a held-out PASS on planted cases of its own domain. Bars are ruled by the
  quant-methodologist.
- A Jev-only verdict caps at REVIEW. A Jev "no problem" never clears a code-flagged defect.
- Record the chat model id and the Jev model id in every MANIFEST.json and receipt. A replay refuses a manifest
  with no model.
````
