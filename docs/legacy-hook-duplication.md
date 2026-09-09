> **Retired 2026-09-09 (bd-memory retirement, bead xtrm-aemfv):** the bd-memory gate, `memory-acked`/`memory-gate-done` KV markers, `xt memory`, and `.xtrm/memory.md` are removed. Passages below describing them are a historical record — do not implement.

# Legacy hook duplication after the global migration

## Symptom

The beads memory gate runs twice on a single `Stop`. Same for every other
xt-managed hook: the commit gate, the edit gate, quality-check, the tool logger.
Nothing is broken, but every hook pays its cost twice and gate messages appear
duplicated.

## Root cause

Claude Code merges user-scope `~/.claude/settings.json` with project-scope
`<repo>/.claude/settings.json` and runs **both** hook sets. It does not
deduplicate.

The global migration installed the xt hook block into `~/.claude/settings.json`,
tagged so it can be recognised later:

```json
{
  "hooks": [
    { "type": "command", "command": "node \"/home/you/.xtrm/hooks/beads-stop-gate.mjs\"" },
    { "type": "command", "command": "node \"/home/you/.xtrm/hooks/beads-memory-gate.mjs\"" }
  ],
  "_source": "xtrm-global",
  "_xtrm": { "version": "0.11.0", "hash": "60246f0d…" }
}
```

It did not remove the pre-migration block that `xt init` had written into each
consumer project, which points at the project's own copy of the same files:

```json
{
  "hooks": [
    { "type": "command", "command": "node \"/home/you/dev/core/.xtrm/hooks/beads-stop-gate.mjs\"" },
    { "type": "command", "command": "node \"/home/you/dev/core/.xtrm/hooks/beads-memory-gate.mjs\"" }
  ]
}
```

Note the missing `_source` on the project entry — it predates the provenance
tagging, which is why hash-based ownership checks alone don't identify it.

The hook *files* under `<repo>/.xtrm/hooks/` are byte-identical to
`~/.xtrm/hooks/`, so the two registrations execute exactly the same code. The
duplication is purely in the registration, not in the payload.

### Why the migration didn't clean it up

Two independent reasons, and the second is the one that matters.

**The hooks half of the migration never ran.** `~/.xtrm/known-repos.json`
records `skillsMigrated: true, hooksMigrated: false` for every consumer
project, all stamped `2026-07-13`. `xt migrate` covers both
(`cli/src/commands/migrate.ts:727` — *"One-time per-repo cleanup: migrate
skills/hooks to global scope"*), but only the skills phase was applied.

**Running the hooks phase now would not fix it either.** The settings cleanup
that phase performs, `cleanSettingsJsonEntries` at
`cli/src/commands/migrate.ts:623`, drops an entry only when it carries
provenance metadata:

```ts
if (source === 'xtrm-global') { changed = true; return false; }        // :662
if (xtrm && typeof xtrm === 'object' && 'hash' in xtrm) { … }          // :667
```

Those markers are written by the *global* installer. The legacy per-project
entries predate provenance tagging and carry neither — measured across all
eight consumer projects, every one of the 12–14 hook entries in
`<repo>/.claude/settings.json` has no `_source` and no `_xtrm`. The predicate
identifies globally-installed entries, not the legacy per-project entries it
needs to remove, so it filters nothing and reports no change.

This is why the duplication needs a different ownership proof: coverage by the
global block plus byte-identity of the referenced hook file, which is what the
script below uses.

## Leftover taxonomy

The audit classifies every hook registration in a project's
`.claude/settings.json` into one of four buckets. Only the first is ever
removed.

| Class | Definition | Action |
|---|---|---|
| `duplicate-of-global` | The same `(event, matcher, command)` exists in `~/.claude/settings.json` once the project's `.xtrm/hooks` path is normalised to `~/.xtrm/hooks` — **and**, if the command names a project hook file, that file is byte-identical to its global counterpart. | **safe to remove** |
| `xt-owned-drift` | References a project `.xtrm/hooks` file that exists globally but with different bytes. | **required to keep** — resolve the drift first, then re-run |
| `xt-owned-uncovered` | References a project `.xtrm/hooks` path the global install has no equivalent for. | **needs migration**, not deletion |
| `foreign` | Anything else: user-authored hooks, third-party installers, skill self-install entries. | **genuinely user-owned**, never touched |

When ownership is ambiguous the entry lands in `foreign` and is kept. The
operator can always remove more by hand; the script never removes more on its
own.

### What is *not* in scope

- Anything under `~/.xtrm/` — the global SSOT is never modified.
- `.claude/settings.local.json` — user-owned, not read or written.
- Hook *files* under `<repo>/.xtrm/hooks/` — left on disk. They stop being
  registered, but removing them is a separate decision (`xt update --apply`
  still manages that tree).
- Empty `<repo>/.xtrm/skills/default` and `optional` directories, and
  `<repo>/.xtrm/skills/local-legacy/` left behind by `xt migrate skills` — those
  are skills-migration residue, reported elsewhere, not hook registrations.

## The audit script

`docs/architecture/repair-transaction.md` is clear that repair belongs inside
`xt update` and that no new top-level `xt <verb>` should be added, with cleanup
as phase 6 (*"Claude hook state (merge with user-owned hooks, never wholesale
replace)"*). This script does not contradict that: it is a `scripts/` operator
diagnostic, not a CLI verb, and it does something `xt update` structurally
cannot — sweep *across* projects to find registrations made redundant by the
global block.

Phase 6 now applies the same coverage-plus-hash ownership proof per project
(`cli/src/core/legacy-hook-dedupe.ts`, shared with `xt migrate hooks`), so
`xt update --apply` deduplicates the repo it runs in and future migrations do
not need this script. It remains the one-shot tool for historical residue and
for the cross-project sweep.

The `runOwnedLegacyCleanup({ projectRoot, dryRun, scopes })` helper that
`repair-transaction.md:59` documents as "internal cleanup helper stays
available" **does not exist in `cli/src`** — the identifier appears only in that
doc. There was nothing to wire through, so the script is standalone. See
`xtrm-3yne6`.

```bash
node scripts/dedupe-legacy-hooks.mjs                  # dry-run over ~/dev and ~/projects
node scripts/dedupe-legacy-hooks.mjs --project ~/dev/core
node scripts/dedupe-legacy-hooks.mjs --root ~/work    # scan a different tree
node scripts/dedupe-legacy-hooks.mjs --json           # machine-readable outcome
node scripts/dedupe-legacy-hooks.mjs --apply          # opt-in; writes a backup first
```

Dry-run is the default and mutates nothing. `--apply` copies each
`.claude/settings.json` to `~/.xtrm/migration-backups/<project>-claude-settings-<timestamp>.json`
before rewriting it, and only ever removes commands classified
`duplicate-of-global`. Entries and events that become empty are dropped; every
other key in the settings file is copied through untouched.

The script refuses to run at all — exit code 2 — if `~/.claude/settings.json`
is unreadable or `~/.xtrm/hooks/` is missing, since without the global baseline
it cannot prove anything is a duplicate.

A project is treated as an xt consumer if it has any of `.xtrm/registry.json`,
`.xtrm/hooks/`, or `.xtrm/config/`.

### `--json` output

```jsonc
{
  "schema": "ReconciliationOutcome/1",
  "generatedAt": "2026-07-21T12:00:00.000Z",
  "applied": false,
  "globalSettings": "/home/you/.claude/settings.json",
  "totals": { "projects": 8, "planned": 152, "preserved": 2, "failed": 0 },
  "projects": [
    {
      "project": "/home/you/dev/core",
      "settingsFile": "/home/you/dev/core/.claude/settings.json",
      "planned":   [ { "event": "Stop", "matcher": "", "command": "…", "classification": "duplicate-of-global" } ],
      "preserved": [ { "event": "…", "matcher": "…", "command": "…", "classification": "foreign", "reason": "…" } ],
      "failed":    [],
      "backup":    "/home/you/.xtrm/migration-backups/core-claude-settings-….json"
    }
  ]
}
```

Exit code is 1 if any project recorded a failure, otherwise 0.

## Behavioural impact of running `--apply`

**Heals.** Each xt hook fires once instead of twice. The beads memory gate stops
emitting its message twice per `Stop`; `quality-check` stops running twice per
edit; `beads-claim-sync` stops doing duplicate work per Bash call. Hook latency
on the doubled events roughly halves.

**Breaks.** Nothing, provided the global block stays installed — every removed
registration was verified to have an exact counterpart there before removal.
The one real risk is the inverse: if `~/.claude/settings.json` is later reset or
hand-edited to drop the `_source: "xtrm-global"` block, a deduped project has no
project-scope fallback and its hooks go silent. Recovery is
`xt update --apply`, or restoring the per-project backup the script wrote.

Worktrees under `<repo>/.xtrm/worktrees/` inherit the parent repo's
`.claude/settings.json`, so deduping the parent fixes them too.
