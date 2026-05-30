
# Updating Service Skills

> Detailed **update / drift-sync** flow for the `service-skills` router.
>
> **Path model:** `.claude/skills/<service>/SKILL.md` shown below is the **Claude-Code view** (a symlink). The canonical home for per-service skills is under `.xtrm/skills/user/packs/<pack>/` — scripts resolve it via `bootstrap.get_service_skill_path_str`. Machinery scripts live at `.claude/skills/service-skills/scripts/` (the active view of this skill).

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
Use '/updating-service-skills' to sync the Database Expert documentation.
```

---

## Manual Sync Process

> **Cadence:** the automatic sync pipeline runs **post-merge on master only** (not on
> feature-branch merges) — that is the single canonical point where the code is final.
> Drift is measured semantically since the service's `last_sync_ref`, not by file mtime alone.

### Step 1 — Scan for all drift (gitnexus-default)

```bash
python3 "$CLAUDE_PROJECT_DIR/.claude/skills/service-skills/scripts/drift_detector.py" scan
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
  rule on it (no index / no `last_sync_ref` / CLI error). `tier=unknown` means **fall back
  to manual inspection** — the fallback is visible, never silent. (`--no-gitnexus` forces
  mtime-only.)

### Step 2 — Read the current skill

```
Read: .claude/skills/<service-id>/SKILL.md
```

The skill's section structure is defined by the canonical contract
`creating-service-skills/references/service_skill_contract.json` (SSOT). If the file
predates the devops sections (no `Cross-Service Health Check` / `Failure Modes` /
`Deploy & Runbook`), run the **migrator** first to add the missing skeleton without
touching human content:

```bash
python3 "$CLAUDE_PROJECT_DIR/.claude/skills/service-skills/scripts/skill_migrator.py" \
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

### Step 5 — Mark as synced

```bash
python3 "$CLAUDE_PROJECT_DIR/.claude/skills/service-skills/scripts/drift_detector.py" \
  sync <service-id>
```

`sync` stamps both `last_sync` (timestamp) and `last_sync_ref` (current `HEAD`) so the next
`scan` measures the committed range since this point.

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
- ✅ `.claude/skills/service-registry.json` — territory and sync timestamp updates

Avoid:
- ❌ Modify source code (read-only access to service territories)
- ❌ Delete skills or registry entries

---

## Sync Output Format

```
✅ Skill Synced: `<service-id>`

Updated:
- log_hunter.py: added 2 new patterns from exception handlers
- SKILL.md: Failure Modes table updated with OAuth expiry scenario
- Territory: unchanged

Next sync: triggers on next modification to <territory-patterns>
```

---

## Related Skills

- `/using-service-skills` — Discover and activate expert personas
- `/creating-service-skills` — Scaffold new expert personas
