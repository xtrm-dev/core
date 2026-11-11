# Jev / AgentRun pointers

Where to look for the Jev classifier, the async suggestion pipeline, AgentRun, and the
CORE-2580 / CORE-2581 work. Paths are relative to the repository root. Written 2026-11-06.
Verified with `git grep`; the files were not all re-read.

## Jev classifier: code to copy

- `packages/pi-extensions/shared/suggest.ts` (963 lines) is the core.
  - `classify`, `systemOne`, `questionShape`, `parseAnswerPayload`: ask the question, read the answer.
  - `readApiKey`, `primeApiKey`: read the key from `~/.secrets/typesafe_api_key.txt` at runtime only.
  - `pickClassifiers`, `classifyViaRegistry`: choose the model.
  - `ClassifierFailure`: the failure kinds that drive fail-open.
  - `CATALOG`, `evaluateDeterministic`, cooldown helpers: the Substrate-verb side.
- `packages/pi-extensions/shared/suggest-pipeline.ts` (109 lines) is the async flow: `detach`,
  `propose`, `settle`, the epoch guard (`stale`, `turn_taken`, `duplicate`), and `DELIVERY`
  (`steer`, no turn trigger). Read this first.
- `packages/pi-extensions/shared/shortlist.ts` and `shared/roster.ts`: build the skill roster
  (about 270 entries) and shortlist it before Jev is called. `extensions/skill-suggest/roster.ts`
  re-exports `shared/roster.ts`.
- `packages/pi-extensions/shared/judge.ts`: the decision itself (CORE-2594), shared by Pi and the
  Claude plugin: `judge()` (two Jev stages and the fitted score), `criteriaOf`, `SCORE_MODEL`, and
  `buildIndex(cwd)`. It owns no state; each host caches its own index.
  `tests/skill-suggest/judge-golden.test.ts` pins its Jev payloads and every skip reason.
- `packages/pi-extensions/extensions/skill-suggest/index.ts` (853 lines): prompt, classify,
  rate limit and delivery wired together.
- `packages/pi-extensions/shared/jsonl-log.ts`: log writer.
- `packages/pi-extensions/extensions/substrate-suggest/`: second consumer; `jev.ts` only
  re-exports `shared/suggest.ts`.

## Jev evidence and examples

- `docs/jev/README.md`: harness and eval write-up.
- `docs/jev/eval-jev-latest-2026-09-18.json`: model `jev-1.13.0`, 7 of 8 cases agree, names the miss.
- `scripts/jev_classify.py`: Python harness with an allowlist for recommendations, fail-closed.
- `packages/pi-extensions/tests/skill-suggest/`: `replay.*.test.ts` (recorded answers),
  `failures.test.ts`, `delivery.test.ts`, `gate.test.ts`, `nudges.test.ts`, `shortlist.test.ts`,
  `router.test.ts`, `roster-id.test.ts`. Also `tests/skill-suggest.test.ts`, `tests/core-2361.test.ts`.
- `.xtrm/skills/default/codemode/SKILL.md` and `references/runtime-shapes.md` (near line 96):
  Jev choice-plus-boolean routing with the 402 fallback.

## AgentRun

- `.xtrm/skills/optional/project-management/board-audit/references/agentrun.md`: cookbook. Use the CLI
  path; the host `agentrun` tool fails on `opencode-go` with 400 `MissingSessionID`.
- `.xtrm/skills/optional/project-management/board-audit/references/audit-harness.md`: rubric and
  stability history.
- `.xtrm/skills/optional/project-management/project-management/references/agentrun.md`:
  coordination rules (describe, inspect, run; `--trusted`; verdicts are claims).
- `/agentrun-author` skill: authoring.
- Working workflows: `.xtrm/skills/default/service-knowledge/scripts/coverage_audit/`
  (`workflows/*.mjs`, `run-coverage.mjs`, `run-prs.mjs`);
  `.xtrm/skills/optional/project-management/board-audit/scripts/agentrun-config-stock.mjs`.

## CORE-2580 (Claude Code port) and CORE-2581 (recall design)

- The Claude plugin is `packages/claude-skill-suggest/` (CORE-2594). Read its `README.md` first. A thin
  Python monitor (`bin/monitor.py`, `bin/turnstate.py`) owns delivery; a bun/node worker
  (`worker/worker.ts`, bundled to `dist/worker.mjs`) runs the shared `judge()`. The monitor delivers
  a nudge only while the turn it was computed for is still running.

- Substrate Journals: `sb journal show CORE-2580`, `sb journal show CORE-2581`. They hold the
  delivery-path, latency and memory measurements and the recall design.
- Published summary page: https://kindly-anvil-n7k9.here.now/ (static snapshot, republished by hand).
- Scratch, not in git:
  `/var/tmp/claude-1000/-home-dawid-dev-core--xtrm-worktrees-core-xt-claude-skill-suggest/605fd62b-aa58-482b-9f63-ad5eee30a4c8/scratchpad/`
  - `cc-probe/`: hook, monitor and channel probes and benchmarks.
  - `recall/`: FTS5 prototype and replay scripts.
- `~/.cache/recall-design/replay-set.json`: 14 replay cases for recall.

## Rules that apply when reusing this

- Never print the Jev key; show a suffix only. Never put it in a log, journal or state file.
- Run the extension tests as `cd packages/pi-extensions && bun test`. Running from the repo
  root leaks the pi-tui `mock.module` stub and gives phantom failures.
- Hash the production logs (`~/.xtrm/logs/*.jsonl`) before and after test runs.
- Check machine load before testing.
- Fail open. At most one suggestion per turn. Criteria at most 240 characters.
