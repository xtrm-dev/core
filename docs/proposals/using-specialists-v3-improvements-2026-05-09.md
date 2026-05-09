# Proposed improvements to `using-specialists-v3` skill

**Source:** lessons from the 2026-05-09 xtrm-tools full-auto orchestration session (~75 specialist dispatches, 22 chains landed, 6 friction beads filed).
**Target:** `specialists/config/skills/using-specialists-v3/SKILL.md` (current version: 3.2).
**Owner:** specialists repo.
**Bead:** xtrm-clzv.

The skill is solid for **dispatch + chain + reviewer**. The gaps surfaced by this session live around **integration-phase reconciliation, post-merge smoke validation, conversation-style overthinker use, autonomous long-running orchestration, and explicit workarounds for known harness bugs that won't be fixed before the next release**. This document proposes additive sections + targeted edits.

---

## Part A — Net-new sections to add

### A1. Integration phase / cherry-pick playbook

The skill currently assumes `sp merge` and `sp epic merge` are the only publish path. In practice when chains forked from a non-`main` working branch (e.g. `fix/foo-baseline`), `sp merge` fails because it hardcodes `main` as the rebase target (filed as xtrm-nr05). The orchestrator falls back to manual cherry-pick + debugger restitch — a multi-step pattern that the skill should teach explicitly.

**Add this section after "Merge And Publication":**

````markdown
## Integration Phase — Cherry-Pick Playbook

Use this when:
- `sp merge` refuses (e.g., chains forked from a non-main working branch)
- The operator wants visibility before publish
- Multiple chains must land into a single integration branch before main

### Step-by-step

1. Stash uncommitted state on working branch: `git stash push -u -m "pre-integration"`.
2. Create integration branch off the working branch: `git checkout -b integration/<date>-orchestrator`.
3. For each non-overlapping chain (security/critical first, then test-baseline, then features):
   - `git merge --squash <chain-branch>`
   - Restore noise files (see "Chain noise filter checklist" below)
   - `git commit -m "<type>(<scope>): <summary> (<bead-id>)"` — one squash commit per chain
4. For each overlapping chain, switch to the **debugger-restitch** pattern (see A2).
5. After all chains land, run E2E smoke phase (see A3) before declaring done.
6. Operator FF-merges integration → main when satisfied.

### Chain noise filter checklist

Before committing each squashed chain, unstage:

- `.pi/npm` — accidentally created by xt commands inside worktrees
- `cli/pnpm-lock.yaml` and `cli/pnpm-workspace.yaml` — pnpm side-effects
- `AGENTS.md` and `CLAUDE.md` — gitnexus stat-refresh hook noise
- `.beads/issues.jsonl` and `.beads/interactions.jsonl` — bd state changes from your own bd close calls
- Any `.beads/*` symlink-vs-dir conflicts (worktree bd setup leaks)
- `.specialists/executor-result.md` — last specialist's transient output

```bash
git restore --staged .beads .pi AGENTS.md CLAUDE.md
git checkout HEAD -- .beads AGENTS.md CLAUDE.md
rm -f .pi/npm
```

If a chain commits its own `.beads` symlink (older bd-in-worktree behavior), `rm -f .beads` then `git checkout HEAD -- .beads` to restore the real directory.
````

### A2. Debugger-restitch pattern (NEW)

When a chain conflicts with already-landed work, raw `git cherry-pick` will revert the landed work. The debugger-restitch pattern preserves both — but only when the debugger is given an explicit "preserve already-landed work" contract. This pattern saved the 2026-05-09 session.

````markdown
## Debugger-Restitch Pattern

When chain X conflicts with already-landed chain Y on shared files:

1. **Reopen X**: `bd reopen <X> --reason="integration stitch onto post-Y state"`.
2. **Strengthen the bead contract** with these fields:
   - `## CRITICAL CONSTRAINTS:` heading at the top
   - "Fork off integration/<date>-orchestrator. Verify with `git log integration/...$..HEAD` empty before any commits."
   - List the symbols/lines from Y that MUST be preserved verbatim (with file paths).
   - "ADD X's intent ON TOP" with a numbered list of the additions.
   - "Reference original feature/<X>-executor for symbol shapes only — do NOT cherry-pick or merge. Re-implement on integration's current state."
   - `## VALIDATION:` includes both Y's tests passing AND X's new tests passing.
   - `## OUTPUT:` mandates a 5-line code excerpt showing both Y and X features coexisting.
3. **Dispatch debugger** with `--force-stale-base` if X is an epic child:
   ```bash
   sp run debugger --bead <X> --force-stale-base --keep-alive --background
   ```
4. **Sanity check the result**: when the debugger reports back, run:
   ```bash
   git log integration/<date>..feature/<X>-debugger --oneline
   git diff integration/<date>...feature/<X>-debugger -- <key-files>
   ```
   Confirm the debugger's diff is **additive** — no reverts of Y's lines.
5. **Land via FF or cherry-pick the named commit** (NOT the checkpoint commit). Look for the commit with the proper `<type>(<scope>):` message; ignore `checkpoint(debugger):` commits above it.
6. **Verify tests** before marking done.

### Failure mode to watch for

If the debugger forks off the OLD baseline (pre-Y) instead of integration, its commit will revert Y. Symptom: `git diff integration..feature/<X>-debugger -- <Y's-file>` shows DELETIONS of Y's symbols. Fix: resume the debugger with explicit `cd to a fresh worktree forked from integration/<date>-orchestrator` instruction. Re-verify with `git log integration..HEAD` empty.
````

### A3. E2E smoke phase before close (MANDATORY at end of integration)

This session discovered a missed chain (xtrm-qtq9) only via post-integration smoke testing. The skill should mandate this step.

````markdown
## E2E Smoke Phase (MANDATORY before declaring integration done)

After all chains land, run **every** npm script + entry point that any chain added or modified. The smoke phase is the only way to catch:

- Missed chains (you forgot to cherry-pick one)
- False-positive CI gates (script flags itself)
- Missing intermediate files (e.g., a verifier that needs a file the vendor script creates)
- Runtime regressions invisible to unit tests

### Procedure

```bash
# Build sanity
npm run build --workspace cli   # or equivalent

# Test sanity — record PRE-baseline first
git checkout <baseline-branch>
npm test --workspace cli 2>&1 | tail -5   # record N failed / M passed

# Switch back and re-run
git checkout integration/<date>-orchestrator
npm test --workspace cli 2>&1 | tail -5   # MUST be ≥ baseline. Net regression is a stop-the-line.

# Run every check:* script the integration added
for s in $(jq -r '.scripts | keys[] | select(startswith("check:"))' package.json); do
  echo "=== $s ==="
  npm run "$s" 2>&1 | tail -10
done

# Targeted unit tests for chains touching the same files
npx vitest run <chain-test-files>
python3 -m pytest <chain-python-tests>
```

For each smoke that fails, **decide before continuing**:
- False positive (script flags itself, etc.) → file follow-up bead, document, continue
- Missing dependency (vendor not run, etc.) → expected gate, document
- Real regression → stop, dispatch debugger to fix, re-smoke

Record all smoke results in the session-close-report under a `## Smoke test results` table.
````

### A4. Operator escalation matrix

The skill talks about destructive operations but doesn't enumerate. Add a clear "what to escalate" table.

````markdown
## Operator Escalation Matrix

Action | Default | Always escalate to operator
---|---|---
Code edit | Specialist only | (never orchestrator-direct)
Cherry-pick onto integration branch | Auto if non-overlapping | Conflict resolution that requires manual edits
Manual conflict resolution | Never | Always
Force push | Never | Always
Branch delete | Never | Always
Stash pop where conflict expected | Auto | Stash conflict that destroys session-start state
`bd dolt fsck --revive-journal-with-data-loss` | Never | Always — has explicit data-loss warning
`sp epic merge` | Auto if all children PASSed | Skip if any child reviewer-FAILed
`sp stop <job>` | Auto when job is done/stale | Never on actively-running unless context blown
`git push origin <branch>` | Auto for chain branches (read-only push) | Force-push or delete-remote always
`npm publish` | Never | Always
Dependency bump | Auto for patch-bumps in security work | Major/minor bumps escalate
Config file edit (.beads/config.yaml) | Auto for shared-server flag re-add | Schema-changing edits escalate
````

### A5. Conflict cluster identification (PRE-DISPATCH)

The orchestrator should map overlap surface BEFORE dispatching parallel waves, not discover conflicts at integration time. Add to "Dependency Linking" or as a new section.

````markdown
## Pre-Dispatch: Conflict Cluster Identification

Before dispatching N parallel chains, build the file-overlap matrix:

```bash
# For each candidate chain, list what files it'll touch (from bead SCOPE)
# Then group by file overlap:
```

| Chain | Touches | Overlap with |
|-------|---------|--------------|
| sm1t | cli/src/commands/update.ts | 42in, 19e5 |
| 42in | cli/src/commands/update.ts, install.ts, registry-scaffold.ts | sm1t, 19e5, u3t |
| 19e5 | cli/src/commands/update.ts, install.ts, doctor.ts | sm1t, 42in |

For each cluster of overlapping chains, choose **one** of:

1. **Serial dispatch** — execute chains in dependency order, each waits for previous to land. Slowest but cleanest.
2. **Unified bead** — collapse all chains into one bead/executor pass. Larger reviewer scope but no merge conflicts.
3. **Parallel dispatch + debugger restitch at integration** — dispatch in parallel, plan for ~50% conflict rate, budget debugger-restitch passes during integration phase.

Empirical conflict rates from 2026-05-09:
- 8 of 20 chains conflicted on shared files (~40%)
- Each conflict cost ~1 debugger restitch (~5–10 min wall time)
- Net: serial order on the 3 worst clusters would have saved ~30 min vs parallel + restitch

Default heuristic: if 3+ chains touch the same file, **serial-dispatch them**.
````

### A6. Overthinker as conversation (PATTERN UPDATE)

Current skill mentions overthinker for "risky design, tradeoffs, premortem". This session showed a different pattern: **conversation**. Send overthinker to evaluate a strategy, then resume with pushback when its first answer feels too cautious. Got 3 retracted recommendations after challenge.

````markdown
## Overthinker as Conversation

Overthinker excels when used iteratively — not as a one-shot oracle. After its first response, **read carefully and challenge any recommendation that feels overcautious or hand-wavy**. Common patterns the orchestrator should push back on:

- "Hold for operator decision" without specifying what decision is needed → push: "Cite file/line evidence for why this is a product decision rather than a mechanical resolution."
- "Close as superseded by X" without verification → push: "Read the current state of <file> and check whether feature Y from this bead is actually present."
- "Run separate small beads" or "run one big bead" without rationale → push: "Pick one and explain operationally — cost difference, conflict expectations, reviewer scope."

Resume with explicit ammunition (specific file/line refs, current branch state, links). Overthinker's second-round answers were significantly more grounded after the push.

When done, close the bead and capture the conversation in the session-close-report's "Specialist Dispatches" section under the overthinker entry — it's high-value handoff context.
````

### A7. Sleep timer + cron pattern for autonomous runs

For long autonomous runs (hours of orchestration without operator), the orchestrator must monitor specialists. Two complementary mechanisms emerged this session:

````markdown
## Long Autonomous Runs — Monitoring Pattern

For sessions where the operator is offline (overnight, async windows), use both:

1. **Bash sleep timers per dispatch**, sized to specialist role expectations:
   - sync-docs / changelog-keeper: `sleep 60`
   - code-sanity / security-auditor: `sleep 60`
   - reviewer: `sleep 90`
   - explorer / debugger / planner / overthinker: `sleep 120` initial, `sleep 90` follow-up
   - executor: `sleep 180` initial, `sleep 120` follow-up
   - test-runner: `sleep 120` initial, scale with suite size
2. **External cron loop** (Claude Code: `/loop 180s sp ps`) to refresh specialist state at fixed cadence regardless of orchestrator's bash sleeps. The cron acts as a heartbeat that catches specialists that finished while the orchestrator was busy reading other results.

The two complement: bash sleep waits for an expected completion; cron catches unexpected completions and stalls.

After every dispatch:
```bash
sleep 10 && sp ps   # confirm started, not stuck queued
sleep <role-typical-duration> && sp ps   # check state
sp result <job-id>  # consume immediately when done
```

If a job exceeds 2× its typical duration, inspect with `sp feed <job-id>` before assuming hang.
````

### A8. Memory-gate batch-close workflow

Closing many beads at once requires per-id memory acks. The skill should document the loop pattern.

````markdown
## Batch-Close Workflow (Memory Gate Compliance)

`bd close` is blocked until `memory-acked:<id>` exists. For batch-closing many orchestrator-internal beads (sanity beads, reviewer beads, etc.), use:

```bash
for id in xtrm-aaa xtrm-bbb xtrm-ccc; do
  bd kv set "memory-acked:$id" "nothing novel — orchestrator-internal sanity/reviewer bead"
  bd close $id --force --reason="chain complete"
done
```

`--force` is safe here because the parent chain's bead has already captured the substantive insight. If the parent itself has novel insight, save via `bd remember "..."` BEFORE closing the parent (set `memory-acked:<parent>` to `saved:<key>`).

Common orchestrator-internal beads that don't need novel memory:
- Sanity beads (xtrm-aaaa) created to dispatch code-sanity on a parent
- Reviewer beads (xtrm-bbbb) created to dispatch reviewer on a parent
- Re-review beads after fix turns
- Decomposition tracker beads created by planners (memory captured in children)
````

### A9. Session-close-report integration (MANDATORY at session end)

The skill currently doesn't reference the session-close-report skill. Add a closing reference.

````markdown
## At Session End — Mandatory Handoff

Before declaring the session done:

1. Run `/session-close-report` (or the `session-close-report` skill).
2. Fill every `<!-- FILL -->` marker in the generated skeleton. Don't leave them.
3. Sync `CHANGELOG.md` for user-facing changes (see the report skill's Step 6).
4. Re-run the cleanup checks (worktree list, sp ps, ps -ef for stale serena/gitnexus, tmux ls for sp-*).
5. Commit the report (and CHANGELOG if updated) before push.

A session that lands code but skips the close-report leaves the next agent cold-starting blind. That cost compounds across sessions.
````

---

## Part B — Targeted edits to existing sections

### B1. "Monitoring And Steering"

**Add subsection: "Reviewer cumulative-diff workaround (until xtrm-axwq is fixed)"**

```markdown
### Reviewer cumulative-diff workaround

The reviewer's "injected diff context" frequently shows only the latest checkpoint commit (or AGENTS/CLAUDE refresh noise) instead of the cumulative branch diff. Until this is fixed upstream, EVERY reviewer dispatch should include explicit cumulative-diff commands in its bead's SCOPE field:

```text
SCOPE: Cumulative diff in feature/<bead>-executor (job <id>). Use:
  cd /path/to/.worktrees/<bead>/<bead>-executor
  git log <fork-base>..HEAD --oneline
  git diff <fork-base>...HEAD --stat
  git diff <fork-base>...HEAD -- <key-files>
  npm test ...
IGNORE injected docs-only diff. Issue PASS/PARTIAL/FAIL based on cumulative output.
```

If the reviewer FAILs on first turn with "docs-only diff contradicts claimed", resume with the same cumulative-diff command. Most second-turn verdicts come back PASS.
```

### B2. "What Stays Out"

**Add:** mention `session-close-report` and `releasing` skills explicitly (orchestrator should know they exist and when to invoke them).

### B3. "Hard Rules"

**Add rule 12:**

```markdown
12. The orchestrator NEVER edits code directly. Conflict resolution, even mechanical, goes through a debugger or executor specialist. Manual conflict resolution is the only escalation that must always go to the operator.
```

### B4. "Failure Recovery"

**Add to "When something fails":**

```markdown
- If a chain's reviewer keeps FAILing on injected-diff, switch to cumulative-diff workaround (see B1).
- If `sp run` returns silently with `Warning: job started but ID not yet available`, check `sp ps --bead <id>` after 30s. If still empty, the dispatch was likely refused (epic guard, base-staleness). Retry with `--force-stale-base`. If still empty, run `sp run` in foreground to see the error message.
- If bd commands fail with `database "jaggers_agent_tools" not found`, the per-project Dolt has spawned. Kill it (`ps aux | grep "<repo>.beads/dolt" | awk '{print $2}' | xargs kill -9`), re-add `dolt.shared-server: true` to `.beads/config.yaml` (it sometimes gets stripped after branch switches), and retry. This is documented friction (xtrm-hhiu).
- If Dolt journal corrupts mid-session (`possible data loss detected at offset N`), DO NOT auto-recover. Operator-only. The `dolt fsck --revive-journal-with-data-loss` flag has explicit data-loss warning.
```

### B5. "What Orchestrator Does Differently Because Of This Skill"

**Add to the bullet list:**

- Maps file-overlap surface BEFORE dispatching parallel waves.
- Uses overthinker as a conversation, not a one-shot oracle.
- Smokes every npm script and entry point before declaring integration done.
- Files friction beads as encountered, not retrospectively at session end.
- Commits debugger-restitch results via FF or cherry-pick of the named commit, not the checkpoint commit above it.

---

## Part C — Active workarounds (until upstream fixes)

These belong in a new appendix `## Known Workarounds (filed for upstream fix)`:

````markdown
## Known Workarounds

Until the listed friction beads are fixed in their upstream repos, the orchestrator must apply these workarounds.

### Reviewer injected-diff bug (xtrm-axwq)
**Workaround:** explicit `git diff <base>...HEAD` command in every reviewer bead SCOPE. See B1.

### sp merge hardcoded to main (xtrm-nr05)
**Workaround:** manual cherry-pick + debugger-restitch pattern (A1+A2). Don't use `sp merge` for chains forked from non-main branches.

### bd-in-worktree fails (xtrm-hhiu)
**Workaround:** orchestrator owns bead lifecycle from main repo. Specialists never run `bd close` from inside their worktree (their attempts will fail with `database not found`; that's expected and documented).

### Chain noise pollution (xtrm-ombq)
**Workaround:** filter checklist at every cherry-pick (see A1 "Chain noise filter checklist"). Until idempotent AGENTS/CLAUDE generation lands (xtrm-i4uu/9xg2.*), every commit will pull in the gitnexus stat refresh — filter at squash time.

### Epic guard refuses sub-bead dispatches (xtrm-5sz2)
**Workaround:** `--force-stale-base` flag for initial dispatches on epic children. Subsequent reviewer/sanity dispatches under the same chain may fail silently — retry with `--force-stale-base` again, or dispatch in foreground to see the refusal reason.

### Per-project Dolt respawns after branch switch (related to xtrm-hhiu)
**Workaround:**
```bash
ps aux | grep "<repo>/.beads/dolt" | grep -v grep | awk '{print $2}' | xargs -r kill -9
echo "" >> .beads/config.yaml
echo "dolt.shared-server: true" >> .beads/config.yaml
sleep 2
bd ready  # should now route to ~/.beads/shared-server/
```
Repeat as needed; the flag gets stripped on some bd auto-init paths.

### Dolt journal corruption (xtrm-yb0u)
**Recovery:** operator-only. Stop further bd writes. Snapshot `~/.beads/shared-server/dolt`. Run `dolt fsck` (read-only) first to assess. Decide on `--revive-journal-with-data-loss` only after reviewing the warning.
````

---

## Part D — Editing instructions

To apply this proposal:

1. Read the current `specialists/config/skills/using-specialists-v3/SKILL.md` (734 lines, version 3.2).
2. Add Part A sections in this order: A1 (after "Merge And Publication"), A2 (right after A1), A3 (right after A2), A4 (after "Hard Rules"), A5 (after "Dependency Graph Shapes"), A6 (in "Mini-Flows For Under-Promoted Specialists"), A7 (after "Monitoring And Steering"), A8 (in "What Stays Out" or as separate "Bead Lifecycle Workflow"), A9 (last section before "What Orchestrator Does Differently").
3. Apply Part B targeted edits inline to existing sections.
4. Append Part C as the final appendix.
5. Bump version to `3.3` in frontmatter.
6. Update SKILL.md description to mention "integration phase" and "debugger-restitch pattern" so the skill triggers on those keywords too.

The session that produced this proposal is captured in `xtrm-tools/.xtrm/reports/2026-05-09-31d59db.md` with full context (75 dispatches, 22 chains, 6 friction beads, debugger-restitch deployments, overthinker conversation).
