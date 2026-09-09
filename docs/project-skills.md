---
title: Project Skills (Residual State)
scope: project-skills
category: reference
version: 3.0.0
updated: 2026-07-08
description: "Residual per-repo skills state after global migration: user packs, service-skills output, and composed active view"
source_of_truth_for:
  - ".xtrm/skills/user/**"
  - ".xtrm/skills/active/"
  - ".xtrm/skills/state.json"
domain: [skills, claude, pi]
updated_at: 2026-07-08
---

<!-- INDEX: auto-generated -->
| Section | Summary |
|---|---|
| [Overview](#overview) | Residual per-repo state after global migration |
| [Directory Layout](#directory-layout) | Project-scoped skills structure |
| [User Packs](#user-packs) | Project-specific user-authored packs |
| [Service-Skills Output](#service-skills-output) | Generated service skill packages |
| [Composed Active View](#composed-active-view) | Global + local resolution |
| [Migration Reference](#migration-reference) | Legacy per-repo default/optional cleanup |
| [Related Docs](#related-docs) | Global skills architecture and migration |
---

# Project Skills (Residual State)

After the global skills migration (Batches A–F, epic `xtrm-bq7yd`), per-repo skills contain only **residual state**:

- User-authored packs (`.xtrm/skills/<pack>/`)
- Service-skills output (`.xtrm/skills/<repo>-services/`)
- Composed active view (`.xtrm/skills/active/`)
- Project delta state (`.xtrm/skills/state.json`)

The `default/` and `optional/` tiers now exist **only at global scope** (`~/.xtrm/skills/`). They are no longer materialized per-repo.

See [docs/plans/global-skills-migration.md](plans/global-skills-migration.md) for the canonical migration architecture.

## Directory Layout

```
.xtrm/skills/
├── user/                      # Project user-authored packs
│   ├── packs/
│   │   ├── README.txt
│   │   ├── my-project-pack/   # Project-specific pack
│   │   │   ├── PACK.json
│   │   │   └── <skill>/SKILL.md
│   │   └── <repo>-services/   # Generated service-skills umbrella
│   │       └── service-skills/
│   │           └── services/
│   │               ├── <svc1>/
│   │               └── <svc2>/
│   └── README.txt
│
├── active/                    # Composed runtime view
│   ├── using-xtrm -> ../../~/.xtrm/skills/default/using-xtrm
│   ├── planning -> ../../~/.xtrm/skills/default/planning
│   ├── my-project-pack -> ../user/packs/my-project-pack
│   └── <repo>-services -> ../user/packs/<repo>-services
│
├── state.json                 # Project delta overrides on global state
└── INVARIANTS.md              # Contract documentation
```

## User Packs

Project-specific user-authored packs live at `.xtrm/skills/user/packs/`:

```
.xtrm/skills/user/packs/my-project-pack/
├── PACK.json
└── my-skill/
    └── SKILL.md
```

### PACK.json Schema

```json
{
  "name": "my-project-pack",
  "version": "1.0.0",
  "description": "Project-specific skills",
  "runtime": ["claude", "pi"],
  "skills": ["my-skill"]
}
```

### Enablement

Enable project pack locally:

```bash
xt skills enable my-project-pack --local --claude
```

This writes to `.xtrm/skills/state.json` as a delta override on global state.

## Service-Skills Output

Service-skills system generates per-repo service skill packages:

```
.xtrm/skills/user/packs/<repo>-services/
└── service-skills/
    └── services/
        ├── <svc1>/
        │   ├── SKILL.md
        │   └── services.json
        └── <svc2>/
            └── SKILL.md
```

Generated from Docker Compose topology by service-skills drift detector and umbrella generator. Reconciled on `xt update --apply`.

> **v2 (epic `xtrm-b86y5`):** the former service-skills quartet plus bundle are now **one** skill at `skills/service-skills/`. Per-repo service skills live under `.xtrm/skills/user/packs/<pack>/service-skills/services/<svc>/` with a generated `<repo>-services` umbrella.

## Composed Active View

Project active view (`.xtrm/skills/active/`) is a **composed symlink directory** merging:

1. Global default skills (`~/.xtrm/skills/default/`)
2. Global enabled optional packs (`~/.xtrm/skills/optional/`)
3. Global user packs (`~/.xtrm/skills/user/packs/`)
4. Project user packs (`.xtrm/skills/user/packs/`)
5. Service-skills output (`.xtrm/skills/user/packs/<repo>-services/`)

Resolution order: project wins on path conflict.

Rebuilt by `rebuildProjectActiveView()` on:

- `xt skills enable/disable` (local scope)
- `xt update --apply` (service-skills reconciliation)
- `xt init` (initial scaffold)

## Migration Reference

### Legacy Layout (Pre-Migration)

```
.xtrm/skills/
├── default/                   # → ../../skills (symlink to repo) — REMOVED
├── optional/                  # Managed packs — REMOVED
├── user/packs/                # User packs — KEPT
├── active/                    # Runtime view — KEPT (now composed)
└── state.json                 # Enablement state — KEPT (now delta overrides)
```

### Migration Steps

1. **Bootstrap global tree**: `xt bootstrap`
2. **Verify runtime pointers**: `readlink ~/.claude/skills`
3. **Run migration**: `xt migrate skills --apply`
4. **Verify cleanup**: `ls .xtrm/skills/default/` (should be absent)

Full workflow: [docs/plans/global-skills-migration.md](plans/global-skills-migration.md)

### Current Source Layout

Use assets from:

- `~/.xtrm/skills/default/` — Global baseline skills (SSOT)
- `~/.xtrm/skills/optional/` — Global optional packs
- `.xtrm/skills/user/packs/` — Project user packs (residual)
- `.xtrm/skills/active/` — Composed runtime view

## Installer Expectations

- `install-service-skills` tests and command paths should resolve assets from `skills/service-skills` (repo source)
- Runtime activation targets composed project-local `.xtrm/skills/active/` through active skill links
- Service-skills output lives at `.xtrm/skills/user/packs/<repo>-services/`

## Related Docs

- [plans/global-skills-migration.md](plans/global-skills-migration.md) — Canonical migration architecture and operator workflow
- [skills.md](skills.md) — Skills tier architecture overview
- [skills-tier-architecture.md](skills-tier-architecture.md) — Full tier model reference
- [pi-extensions.md](pi-extensions.md) — Pi runtime wiring
- [README.md](README.md) — User-facing overview
