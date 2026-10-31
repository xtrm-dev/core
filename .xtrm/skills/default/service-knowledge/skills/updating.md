
# Updating Service Knowledge

> Detailed **update / drift-sync** flow for the `service-knowledge` router.
>
> **Path model:** `.claude/skills/<service>/SKILL.md` shown below is the **Claude-Code view** (a symlink). The canonical home for per-service skills is under `.xtrm/skills/<pack>/` — scripts resolve it via `bootstrap.get_service_skill_path_str`. Machinery scripts live at `.xtrm/skills/default/service-knowledge/scripts/` (the active view of this skill).

## Role: The Librarian

You are the **Service Skills Librarian**. Your job is to keep expert persona
documentation in sync with the actual implementation as the codebase evolves.

---

## Automatic Drift Detection

After any `Write` or `Edit` operation, the `PostToolUse` hook runs
`drift_detector.py check-hook`. It reads the modified file path from stdin JSON
and checks whether it falls within a registered service territory.

If drift is detected, you will see this in your context:

```
[Skill Sync]: Implementation drift detected in 'db-expert'.
File 'src/db/users.ts' was modified.
Use '/updating-service-knowledge' to sync the Database Expert documentation.
```

> **Hook wiring is mandatory, not optional, and automatic.** The
> `SessionStart` (cataloger), `PreToolUse` (skill_activator) and `PostToolUse`
> (drift_detector) hooks are the system — without them the umbrella and per-service
> skills exist but never fire. They ship via the canonical `.xtrm/config/hooks.json`
> and are wired into the consumer's `.claude/settings.json` automatically on every
> `xt update --apply` (and `xt init`), idempotently. A repo that migrated to v2 but
> whose hooks were never wired (the historical dormant-hooks failure, xtrm-0p7bp)
> self-heals on the next `xt update --apply` — no manual settings edit required.

---

## Manual Sync Process

> **Cadence:** drift markers are touches-gated advisories (`post-merge`/`post-checkout`/`post-rewrite`
> write `.xtrm/.service-knowledge-drift-pending` only when the landed range touches registered
> territory) — not a default-branch-only sweep. Freshness is read-time: every index read compares
> `source_ref` to HEAD and rebuilds under lock on mismatch. Drift is measured semantically
> since the service's `last_sync_ref`, not by file mtime alone.
>
> **Automatic backstop.** Managed `post-merge`/`post-checkout`/`post-rewrite` git hooks
> (`post_merge_drift_sweep.py` et al.) are wired into every service-registry repo on the
> foolproof path (`service-knowledge install`, via the installer's `--hooks-only` step). On a
> landing that touches registered territory they print a notice and drop a pending marker at
> `.xtrm/.service-knowledge-drift-pending`. The hooks only **surface** drift — they never rebuild
> the index and never auto-run a model-backed specialist — so reconcile by running
> `/updating-service-knowledge` (the `service-knowledge-sync` specialist), which syncs the
> drifted SKILL.md and advances `last_sync_ref`. The in-session PostToolUse nudge is the
> proactive signal; these touches-gated sweeps are the guaranteed backstop so drift can no
> longer accumulate silently.

### Step 1 — Scan for all drift (gitnexus-default)

```bash
python3 "$CLAUDE_PROJECT_DIR/.xtrm/skills/default/service-knowledge/scripts/drift_detector.py" scan
```

`scan` uses **gitnexus by default**: a cheap mtime walk pre-filters candidates, then a
committed-range gitnexus `compare` (`last_sync_ref..HEAD`) tiers each drift. Every line
carries explicit provenance — **read the tier before doing any work**:

```
Found 1 drifted service(s):
  db-expert: src/db/users.ts (last sync: 2026-05-01T..Z)
    gitnexus_status=ok tier_source=gitnexus tier=high symbols=… processes=… cross_territory=…
```

- `tier_source=gitnexus tier=cosmetic` → no semantic change; **fast-path to
  audited-and-unchanged**, just re-`sync`. Do not rewrite prose.
- `tier=medium|high` → real change; proceed to triage below.
- `tier_source=mtime` / `gitnexus_status=absent|no_ref|cli_error` → the graph could not
  rule on it (no index / no `last_sync_ref` / CLI error). `tier=unknown` does **not** excuse
  semantic triage. **Repair gitnexus first**, then re-triage: `npx gitnexus analyze` to build
  the index, and `xt update --apply` if the machinery/`last_sync_ref` is missing (a
  `drift_detector not available` / `absent` signal almost always means the consumer is
  un-updated, not that the audit may be downgraded — xtrm-0p7bp). Only if gitnexus genuinely
  cannot run do you drop to manual reads — and a service triaged that way **cannot** be
  labelled `audited-and-unchanged` (see the verdict taxonomy below); it gets the weaker
  `synced (string-level only)` verdict. The fallback is visible, never silent. (`--no-gitnexus`
  forces mtime-only and likewise forbids the strong verdict.)

> **Hard rule — a tooling failure is not a license to skip semantics.** A failed/absent
> `drift_detector` pre-script means *fall back to gitnexus directly* (`gitnexus_detect_changes`
> / `gitnexus_impact`, or the CLI), **never** to grep-only string hunting. Grep is a secondary
> cross-check, never the basis for an "unchanged" verdict.

### Worktree gotchas (read before trusting any scan output)

These bite in `xt pi` / `xt claude` **worktree** sessions (where drift is most often
reconciled):

1. **The mtime pre-filter is useless in a worktree.** Every checked-out file's mtime is
   newer than `last_sync`, so `scan` reports near-everything as drifted — and beyond
   `DRIFT_MAX_ENRICH` (default 200) it falls back to mtime-only (`tier=unknown`) entirely.
   Do **not** trust the scan's file list as ground truth. **The authoritative drifted set is
   the git diff**: `git diff <last_sync_ref>..HEAD --name-only` intersected with each
   service's territory globs. Compute that intersection in the kernel once (fnmatch); use
   it, not the scan list, for per-service triage.
2. **The drift marker is on the MAIN checkout, not the worktree.** The extension and CLI
   resolve `.xtrm/.service-knowledge-drift-pending` (or legacy `.service-skills-drift-pending`)
   by walking up from the worktree to the main checkout. Deleting the marker in the worktree
   does **not** clear it — the `drift: PENDING` note persists until the PR that deletes it
   **merges**. It is advisory; never block on it.
3. **The index follows the checkout you query from — including uncommitted
   edits.** Reads compare both `source_ref` vs HEAD *and* a fingerprint of
   the indexed inputs (registry + SKILL.md files, recorded at build time),
   so a rebuild fires on any skill change, committed or not, in any
   worktree. An edit in *this* checkout is visible to the next query in
   *this* checkout — no merge, no manual rebuild needed. (Older behavior
   keyed freshness to HEAD alone; that gap is closed.)

### Step 1b — Coverage audit at PR scale (AgentRun DSL, recommended for ranges over ~50 files)

The scan tells you *which files* drifted, not whether the registry *covers* them.
New subsystems land as unrouted files and silently stay that way unless something
classifies them. For ranges too wide to eyeball, run the coverage audit as an
AgentRun workflow — never as per-item API calls from the session (one model round
trip per item costs context on every call; the workflow snapshots once, then judges
every item with one typed call each).

```bash
CA="$CLAUDE_PROJECT_DIR/.xtrm/skills/default/service-knowledge/scripts/coverage_audit"
SK_REPO=<consumer-root> node "$CA/snapshot-prs.mjs"
node "$CA/run-prs.mjs" --inspect-only   # must print validate=ok
node "$CA/run-prs.mjs"                  # exits 4 if the holdout gate fails
```

Shape: deterministic snapshot (PR merges in `last_sync_ref..HEAD` with per-PR files +
registry owner counts) → class judge (`new_skill` / `extend_territory` /
`leave_unowned` / `unclear`) → boolean confirm judge on the deterministic candidate →
code transcription. Judge-only: needs `runJudge`, no `runNode`. Snapshot freshness gate
<1h; read-only proof (HEAD + registry hash unchanged); holdout gate discards the batch
on mismatch. Full rules: `scripts/coverage_audit/README.md`.

Read the verdicts, not just the counts: `extend_territory` names its target service
(apply through Step 4 + territory update); `new_skill` names the candidate (scaffold
through the create flow, then narrow its territory so it does not overlap); `unclear`
is a verdict, not a failure — split the group and re-run rather than forcing it.


### Step 2 — Read the current skill

```
Read: .claude/skills/<service-id>/SKILL.md
```

The skill's section structure is defined by the canonical contract
`../contracts/service_skill_contract.json` (SSOT). If the file
predates the devops sections (no `Cross-Service Health Check` / `Failure Modes` /
`Deploy & Runbook`), run the **migrator** first to add the missing skeleton without
touching human content:

```bash
python3 "$CLAUDE_PROJECT_DIR/.xtrm/skills/default/service-knowledge/scripts/skill_migrator.py" \
  .claude/skills/<service-id>/SKILL.md
```

It inserts missing canonical sections in contract order, preserves the
`<!-- SEMANTIC_START/END -->` block byte-for-byte, and is idempotent.

### Step 3 — Triage semantically with gitnexus first

Lead with the graph, not raw file reads. Use the tier/symbols/processes from Step 1, then
confirm with gitnexus and only drop to Serena for body-level detail:

```
gitnexus detect_changes --scope compare --base-ref <last_sync_ref> --repo <name>   # what changed
gitnexus impact <symbol> --direction upstream                                       # blast radius
gitnexus context <symbol>                                                           # callers/callees/flows
# then, only if needed:
serena find_symbol(<changed-function>, include_body=True)
```

Decide whether the SKILL.md text **contradicts** current code. Drift is a trigger, not a
verdict — either rewrite the affected section or justify leaving it (cite the cosmetic tier).

### Step 4 — Update the skill documentation

- Update the **Failure Modes** (symptom/cause/fix) table when new exception handlers appear.
- Refresh **Data Flows** from the gitnexus process/query graph when producer→sink paths change.
- Update **Cross-Service Health Check** / **Deploy & Runbook** when ops surface changes.
- Update log patterns in `scripts/log_hunter.py` if new log strings found.
- Update `territory` / sync fields in `service-registry.json` if scope expanded.
- **Preserve `<!-- SEMANTIC_START --> ... <!-- SEMANTIC_END -->` blocks verbatim.**

### Step 5 — Verifier gate (before you save)

**Every proposed SKILL update goes through the deterministic 13-claim-type verifier before
`atomic_write` runs.** This is not an optional lint — the `reconcile.py` driver invokes it
internally and refuses to write on a blocking verdict. Six-tier gate lattice; only `PASS` and
`PASS_WITH_ADVISORIES` are writable. Blockers: `INVALID` / `CONFLICT` / `EVIDENCE_RACE`.
`INSUFFICIENT_EVIDENCE_HIGH_RISK` opens a draft PR for human review.

The reconcile flow you'll normally run wraps all of this:

```bash
python3 -m service_knowledge.scripts.reconcile --dry-run    # preview candidates + verdicts
python3 -m service_knowledge.scripts.reconcile              # apply writable diffs
```

To verify one SKILL manually (interactive debugging):

```bash
SKILL=.xtrm/skills/<pack>/service-knowledge/services/<service-id>/SKILL.md
python3 -m service_knowledge.scripts.verifier \
    --candidate "$SKILL" --current "$SKILL" \
    --territory '<glob>' --source-root . \
    --output-format json --gate-mode
```

Concept: `service-knowledge help verifier`.

### Step 6 — Rebuild the FTS5 index

Retrieval surfaces (`knowledge_search` / `knowledge_get` / `knowledge_evidence_for_files`) and
the PreToolUse activator all read the index. Without a rebuild they keep serving the pre-update
version:

```bash
service-knowledge index build
service-knowledge index stats
```

In an `xt pi` / `xt claude` worktree, the installed `service-knowledge` CLI may not be on
PATH and the worktree cwd is NOT the consumer root. Mount the package in the python kernel
once and pass the consumer root explicitly (state persists across cells):

```python
import sys
sys.path.insert(0, "/path/to/xtrm/packages/service-knowledge/src")  # xtrm checkout
import service_knowledge
from service_knowledge import index
stats = index.build("/path/to/consumer-repo")   # consumer ROOT, not the worktree cwd
print(stats)
```

Keep `ROOT` as a kernel variable and pass it to every call — `build(Path("."))` in a
worktree scans the wrong tree. Prefer in-kernel `service_knowledge.*` calls over
`PYTHONPATH=... python3 -m` one-shots (fresh process per call, no state, noisier).

### Step 7 — Mark as synced

```bash
python3 "$CLAUDE_PROJECT_DIR/.xtrm/skills/default/service-knowledge/scripts/drift_detector.py" \
  sync <service-id>
```

`sync` stamps both `last_sync` (timestamp) and `last_sync_ref` (current `HEAD`) so the next
`scan` measures the committed range since this point.

---

## Verdict Taxonomy (be honest about what you actually verified)

Every service you touch ends with exactly one verdict. The label must match the evidence —
never claim the stronger verdict on weaker evidence.

| Verdict | Earned when | Forbidden when |
|---|---|---|
| `audited-and-unchanged` | gitnexus-backed triage ran and confirmed the SKILL.md's Architecture / Data-Flow / Failure-Mode symbols still exist with the documented signatures and no new flows/error-patterns appeared | gitnexus was unavailable, the index was stale and not rebuilt, or you only grepped for strings — **string-level evidence can never back an "unchanged" verdict** |
| `updated` | gitnexus triage found real drift and you corrected the affected SKILL.md sections | — |
| `synced (string-level only, no semantic verification)` | you could only do a string/path check (gitnexus genuinely unrunnable after a repair attempt) — paths/containers/env are correct but symbols/flows were NOT verified | you actually ran gitnexus (use the stronger label) |

If gitnexus cannot run even after `npx gitnexus analyze` + `xt update --apply`, that is a
**blocker** for any "unchanged" claim: stamp the weaker `synced (string-level only)` verdict,
record the gap, and leave the service flagged for a follow-up gitnexus pass. Do not stamp
`last_sync_ref` as if a semantic audit happened.

---

## Drift Scenarios

### New error pattern added to codebase

1. `gitnexus detect_changes --scope compare --base-ref <last_sync_ref> --repo <name>` to see the changed symbols, then `gitnexus context <handler>` for the flow
2. Add to `scripts/log_hunter.py` PATTERNS list with correct severity
3. Update the **Failure Modes** (symptom/cause/fix) table in SKILL.md

### Territory expanded (new directory added)

1. Check if current glob patterns in `service-registry.json` cover new files
2. If not, update `territory` array in `service-registry.json`
3. `sync` (re-stamps `last_sync` + `last_sync_ref`)

### Major refactor changes conventions

1. `gitnexus impact <symbol> --direction upstream` to scope the blast radius; `get_symbols_overview` only on the files it flags
2. Rewrite the relevant SKILL.md sections (Architecture / Data Flows)
3. Update health_probe.py if table structure or ports changed

---

## Tool Restrictions

Write to:
- ✅ `.claude/skills/*/SKILL.md` — skill documentation updates
- ✅ repo service registry (`.xtrm/skills/<pack>/service-knowledge/service-registry.json`) — territory and sync timestamp updates

Avoid:
- ❌ Modify source code (read-only access to service territories)
- ❌ Delete skills or registry entries

---

## Sync Output Format

```
✅ Skill Synced: `<service-id>`

Verdict: updated   (or: audited-and-unchanged [gitnexus-backed] | synced (string-level only))
Triage: gitnexus detect_changes/impact on <symbols>   (or: gitnexus UNAVAILABLE — string-level only)

Updated:
- log_hunter.py: added 2 new patterns from exception handlers
- SKILL.md: Failure Modes table updated with OAuth expiry scenario
- Territory: unchanged

Next sync: triggers on next modification to <territory-patterns>
```

The `Verdict` and `Triage` lines are mandatory: the reviewer reads them to confirm an
`audited-and-unchanged` claim is gitnexus-backed, not grep-inflated.

---

## Related Skills

- `/using-service-knowledge` — Discover and activate expert personas
- `/creating-service-knowledge` — Scaffold new expert personas
