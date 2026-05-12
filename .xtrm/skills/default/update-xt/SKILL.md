---
name: update-xt
description: >
  Update an xtrm-initialized project to match the current canonical install state.
  Use this skill whenever the user asks to update, upgrade, repair, or re-sync xtrm
  in a project — or when they say something like "xt is out of date", "skills aren't
  loading", "hooks aren't firing", "the install looks wrong", or "I just pulled new
  xtrm changes". Also triggers when the agent detects stale paths like
  .claude/skills → active/claude (old structure) or .pi/settings.json pointing to
  active/pi (old structure). Proactively suggest running this skill after any
  xtrm-tools upgrade.
---

# update-xt

Reconcile a project's xtrm installation against the current canonical state. Detect
drift, apply targeted fixes, verify everything is wired correctly.

## Canonical State (current)

This is what a correctly installed project looks like. Check each item.

### Skills wiring

| Check | Expected value |
|-------|----------------|
| `.claude/skills` symlink target | `../.xtrm/skills/active` |
| `.xtrm/skills/active/` | Flat directory of symlinks to `../default/<skill>` |
| `active/pi/` subdirectory | Must NOT exist (stale — old runtime split) |
| `active/claude/` subdirectory | Must NOT exist (stale — old runtime split) |
| `.pi/settings.json` `.skills` array | Must include `"../.xtrm/skills/active"` |
| `.pi/settings.json` `.skills` array | Must NOT include `"../.xtrm/skills/active/pi"` (old path) |

### Hooks wiring

| Check | Expected value |
|-------|----------------|
| `.claude/settings.json` or `~/.claude/settings.json` | Has `hooks` block with commands containing `/.xtrm/hooks/` paths |
| Hooks events covered | At minimum: `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop` |

### Project bootstrap

| Check | Expected value |
|-------|----------------|
| `.beads/` exists | Yes |
| `CLAUDE.md` or `AGENTS.md` exists | Yes |

## Detection

Run these in order. Report what passes and what drifts.

```bash
# 1. High-level status — shows pending syncs
xt status

# 2. Claude hook wiring
xt claude status

# 3. Skills symlink
readlink .claude/skills
# Expected: ../.xtrm/skills/active
# Stale: ../.xtrm/skills/active/claude

# 4. Stale runtime subdirs (should return nothing)
ls .xtrm/skills/active/pi 2>/dev/null && echo "STALE: active/pi exists"
ls .xtrm/skills/active/claude 2>/dev/null && echo "STALE: active/claude exists"

# 5. Pi settings skills entry
node -e "const s=require('./.pi/settings.json'); console.log(s.skills)" 2>/dev/null
# Expected to include: ../.xtrm/skills/active
# Stale if includes: ../.xtrm/skills/active/pi

# 6. Active view integrity (all entries must be valid symlinks)
for f in .xtrm/skills/active/*; do [ -L "$f" ] || echo "NOT A SYMLINK: $f"; done
```

## Implementation Self-Check

Do not trust the surface commands alone. Before claiming that `xt init` handles
drift correctly, verify the underlying implementation behavior in the CLI source.

Required checks:

| File | What to verify |
|------|----------------|
| `cli/src/core/drift.ts` | Drift is classified by comparing installed user file hashes against registry hashes from the package payload |
| `cli/src/core/registry-scaffold.ts` | Drifted files are reported and skipped by default unless `force` is enabled |
| `cli/src/commands/init.ts` | `xt init` calls the registry install step with `force: false` |

What you must confirm from code before reporting success:

- `xt init` does check for local drift between the user's `.xtrm` files and the
  package payload that bootstrapped them.
- That check is hash-based for registry-managed `.xtrm` files, not just a loose
  status heuristic.
- `xt init -y` is non-destructive for drifted `.xtrm` files by default. It
  preserves local edits unless a separate force path is used.

If the implementation no longer matches those rules, stop and report the mismatch
instead of repeating this skill's older assumptions.

## Remediation

Two commands cover almost all drift. Know which fixes what:

| Command | Fixes |
|---------|-------|
| `xt claude install` | Hooks wiring only (settings.json hooks block) |
| `xt init -y` | Skills symlink, active/ view rebuild, Pi settings, all phases |

### Fix: Skills symlink stale or active/ view wrong

`xt claude install` does NOT rebuild skills. Only `xt init` does (Phase 6b).
`xt init -y` will repair missing/outdated registry-managed files, but it will
preserve locally drifted `.xtrm` files by default.

```bash
xt init -y
```

### Fix: Stale active/pi or active/claude subdirs

`xt init` rebuilds `active/` atomically — it does NOT remove old subdirs left over
from a previous layout. After `xt init -y` confirms the flat view is working, remove
the stale dirs manually:

```bash
rm -rf .xtrm/skills/active/pi
rm -rf .xtrm/skills/active/claude
```

Verify flat active/ is intact:
```bash
ls .xtrm/skills/active/
# Should show skill dirs directly (clean-code, deepwiki, ...) — NOT pi/ or claude/ subdirs
```

### Fix: Hooks not wired

```bash
xt claude install
```

Rewires from `.xtrm/config/hooks.json` into `.claude/settings.json`.

### Fix: Pi settings stale path

Covered by `xt init -y`. If you need to target it alone:
```bash
xt pi install
```

### Fix: beads not initialized

```bash
bd init
```

## If updating xtrm-tools itself (not a consumer project)

After merging changes to `cli/src/`, the dist must be rebuilt before `xt` picks up
the new logic. Skipping this causes verification to report stale errors even after
`xt init` runs.

```bash
cd cli && npm run build
xt init -y   # now runs with updated code
```

## Verification

After all fixes, confirm canonical state is restored:

```bash
xt claude status
# Should show: ✓ Claude hooks wired
# Should show: ✓ claude CLI available

xt status
# Should show no pending changes (or only optional ones)

readlink .claude/skills
# Must output: ../.xtrm/skills/active

node -e "const s=require('./.pi/settings.json'); console.log(s.skills.includes('../.xtrm/skills/active'))" 2>/dev/null
# Must output: true
```

Also restate the implementation-level conclusion in your report:

- `xt init` verified drift against package registry hashes
- local drifted `.xtrm` files were preserved by default
- no forced overwrite path was used unless explicitly requested


If `xt status` still shows drift after targeted fixes, run the full sync:
```bash
xt init
```

## Multi-Repo Sweep (Fleet Update)

For updating **many repos at once** after an xtrm-tools upgrade — much lighter than
running `xt init -y` per repo. The right pattern when you've just rebuilt xtrm-tools
locally or pulled a new tag.

### Dry-run discovery first

```bash
xt update --root ~/dev               # walk the tree
xt update --root ~/projects/mercury  # walk another tree
```

Output classifies each discovered repo by `.xtrm/` state:

| Status | Meaning | Action |
|--------|---------|--------|
| `refreshed` | `.xtrm/registry.json` present; drift vs current package detected | `--apply` will reinstall managed assets |
| `already-current` | `.xtrm/registry.json` present; no drift | no action |
| `incomplete` | `.xtrm/` directory exists but `.xtrm/registry.json` is missing | needs manual `xt init` or `cp` of registry.json from xtrm-tools (see "Bootstrapping incomplete repos" below) |
| `failed` | Hard error during drift check or install | inspect reason — common: PACK metadata drift, missing source files, fs-extra refusing to copy onto a symlink |

Transient worktree paths under `.worktrees/` (specialists) or `.xtrm/worktrees/`
(`xt claude` / `xt pi`) are **skipped** automatically — they're not real repos to
refresh.

### Apply

```bash
xt update --apply --root ~/dev
xt update --apply --root ~/projects/mercury
```

What `--apply` does for each managed repo:
- Runs the install flow with `force=true` — refreshes `.xtrm/config`, `.xtrm/hooks`, `.xtrm/skills/default` (mirror), `.pi/settings.json`, `.mcp.json`.
- Writes `dolt.shared-server: true` into `.beads/config.yaml` if not already set (so the worktree's bd routes to the shared dolt server instead of spawning per-worktree subprocesses).
- Globally installs any missing xt-managed Pi packages.
- Does NOT touch `incomplete` repos (deliberate — auto-fix would be destructive).

### Bootstrapping `incomplete` repos

Two scenarios:

**A. The repo legitimately needs full xtrm management:**

```bash
cd <repo>
xt init -y                                            # scaffold .xtrm/{config,hooks,skills}
cp /path/to/xtrm-tools/.xtrm/registry.json .xtrm/      # seed the registry snapshot
xt update --apply --repo .                            # bring everything in sync
```

(Filed `xtrm-ya2i` — `xt init`'s Project Bootstrap phase should seed `registry.json` automatically; until that lands, the `cp` step is required.)

**B. The repo is intentionally not xtrm-managed.** Leave the `.xtrm/` partial dir
alone; `incomplete` is just a status row, not an error. If you want it to stop
appearing, remove the orphaned `.xtrm/` directory.

### When a repo fails

Common failure modes and fixes:

| Error | Cause | Fix |
|-------|-------|-----|
| `Source and destination must not be the same` | `npm link`'d xtrm-tools + repo has symlinked `.xtrm/skills/default → xtrm-tools` (link chain collapses to same canonical path) | Skip — the repo is already in sync via the live symlinks. Not a real failure. |
| `PACK_METADATA_MISMATCH: metadata-only: X, filesystem-only: Y` | A user-skill-pack (`.xtrm/skills/user/packs/<name>/PACK.json`) lists a skill that has been renamed on disk | Edit `PACK.json` so the listed skill names match the directory names; re-run. |
| `Cannot read properties of null (reading 'dolt')` | Repo's `.beads/config.yaml` is comments-only (fresh `bd init` default); pre-`xtrm-16ec` xtrm crashes parsing it | Upgrade xtrm-tools to ≥ 0.7.18; the parse result is coerced to `{}` defensively now. |

## Pre-Release Validation Methodology

Before publishing a new xtrm-tools version, validate the operator-facing CLI locally
against every consumer repo. This is the procedure that surfaced two release-blockers
in 2026-05-12 alone (`xtrm-16ec` yaml-null crash, `xtrm-ny61` worktree over-discovery).

### Procedure

```bash
# 1. Build dist from the local checkout
cd /path/to/xtrm-tools && npm run build --workspace cli

# 2. Link globally so `xt` runs local source
npm link

# 3. Sweep across all consumer trees (dry-run first)
xt update --root ~/dev
xt update --root ~/projects/mercury

# 4. Identify failed/incomplete rows. Fix any real bugs in xtrm-tools FIRST,
#    then re-build + re-link + re-sweep.

# 5. Once dry-run is clean, apply across the fleet:
xt update --apply --root ~/dev
xt update --apply --root ~/projects/mercury

# 6. Cut the public release only after the local apply succeeds end-to-end.
```

### Why this beats publishing first and patching later

- A published `0.7.X` that crashes on a default-config consumer repo wastes a
  version number — users see "upgrade and immediately break" and lose trust.
- Bugs that only manifest on real consumer state (comments-only YAML, transient
  worktrees, drifted PACK metadata) are invisible from xtrm-tools' own test
  suite — only a real sweep catches them.
- `npm link` flips between local-source-globally and published-version-globally
  in seconds (`npm unlink` reverts), so the validation cost is minimal.

### Watch-fors during the sweep

- **Pi packages shown as `missing` when `npm ls -g` confirms them installed** —
  detection bug, filed at `xtrm-ntf8`. Not a real problem; packages work.
- **xtrm-tools itself appearing as `failed` with "Source and destination..."** —
  expected when xtrm-tools is npm-linked into itself; not a release blocker.

## Reporting to the user

After completing detection + remediation + verification, give the user a concise
summary:

```
## xtrm update complete

✓ .claude/skills → ../.xtrm/skills/active
✓ active/ view: N skills (flat, all valid symlinks)
✓ active/pi and active/claude stale dirs: removed
✓ Hooks wired (X events, Y commands)
✓ .pi/settings.json skills entry: current

[Any items that could not be auto-fixed, with manual instructions]
```

If anything could not be fixed automatically (e.g. missing `.pi/settings.json`,
no beads config), explain the manual step clearly — don't just report failure.
