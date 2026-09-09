---
title: Skills Tier Architecture
scope: skills-tier
category: architecture
version: 3.0.0
updated: 2026-07-08
synced_at: xtrm-bq7yd.8
description: "Global + project layered skills model: global SSOT at ~/.xtrm/skills/, residual per-repo state, and runtime composition"
source_of_truth_for:
  - "~/.xtrm/skills/**"
  - ".xtrm/skills/**"
  - "cli/src/core/skills-*.ts"
  - "cli/src/core/pack-metadata.ts"
domain: [skills, cli, architecture]
updated_at: 2026-07-08
---

<!-- INDEX: auto-generated -->
| Section | Summary |
|---|---|
| [Overview](#overview) | Global SSOT + project residual layered model |
| [Directory Structure](#directory-structure) | Global ~/.xtrm/skills/ + project .xtrm/skills/ |
| [Tier Definitions](#tier-definitions) | Global default/optional/user + project user/service-skills |
| [Runtime Active Views](#runtime-active-views) | Composed symlink directories |
| [state.json Schema](#statejson-schema) | Global state + project delta overrides |
| [PACK.json Schema](#packjson-schema) | Metadata for optional and user packs |
| [Invariants](#invariants) | Contract enforced by skill-discovery.ts |
| [CLI Commands](#cli-commands) | `xt skills list/enable/disable/create-pack` with global default scope |
| [Migration](#migration) | Per-repo to global migration workflow |
| [Related Docs](#related-docs) | Migration plan and CLI reference |
---

# Skills Tier Architecture

## Overview

Skills use a **global + project layered model**:

| Scope | Tiers | Purpose |
|---|---|---|
| **Global** (HOME) | `default`, `optional`, `user` | SSOT for baseline skills, optional packs, and global user-authored packs |
| **Project** (residual) | `user`, `service-skills`, `active` | Project-specific user packs, generated service skills, composed runtime view |

This eliminates N-copy drift across a fleet of N repos and centralizes skill updates. Per-repo `default/` and `optional/` tiers are **no longer materialized** after migration.

See [docs/plans/global-skills-migration.md](plans/global-skills-migration.md) for the canonical migration architecture and operator workflow.

## Directory Structure

### Global Scope (`~/.xtrm/skills/`)

```
~/.xtrm/skills/
├── default/                   # Tier 1: baseline skills (copied from xtrm package)
│   ├── using-xtrm/SKILL.md
│   └── ...                    # ~30 skills
│
├── optional/                  # Tier 2: managed optional packs
│   ├── README.txt             # Empty placeholder + docs
│   └── <pack>/                # Optional packs (e.g. research-methods, code-quality, security-ops)
│       ├── PACK.json
│       └── <skill>/SKILL.md
│
├── user/                      # Tier 3: user-authored overlays (global)
│   ├── packs/
│   │   ├── README.txt
│   │   └── <pack>/            # User-created packs (global)
│   │       ├── PACK.json
│   │       └── <skill>/SKILL.md
│   └── README.txt
│
├── active/                    # Runtime materialization target (global)
│   ├── using-xtrm -> ../default/using-xtrm
│   ├── planning -> ../default/planning
│   └── ...                    # + symlinks from enabled optional packs
│
├── state.json                 # Global enablement state
└── INVARIANTS.md              # Contract documentation
```

### Project Scope (`.xtrm/skills/`)

```
.xtrm/skills/
├── <pack>/                      # Project user-authored packs (flat v2 layout)
│   ├── PACK.json
│   └── <skill>/SKILL.md
│
├── active/                    # Composed runtime view
│   ├── using-xtrm -> ../../~/.xtrm/skills/default/using-xtrm
│   ├── planning -> ../../~/.xtrm/skills/default/planning
│   ├── my-project-pack -> ../my-project-pack
│   └── ...                    # + service-skills output
│
├── state.json                 # Project delta overrides on global state
└── INVARIANTS.md              # Contract documentation
```

The global `default/` entry is **no longer a symlink** to the repo `skills/` directory post-migration. It is a full copy from the xtrm package at bootstrap time.

## Tier Definitions

### Global default (Tier 1)

- **Source**: Copied from xtrm npm package on `xt bootstrap`
- **Required**: Yes — always present after bootstrap
- **Mutability**: Read-only — managed by xtrm updates
- **Discovery**: Direct child directories with `SKILL.md`

Contains the nine universal default skills: `using-xtrm`, `starting-and-resuming-work`, `multiplexing`, `planning`, `engineering-quality`, `using-specialists`, `gitnexus`, `skill-creator`, and `find-skills`.

### Global optional (Tier 2)

- **Source**: Populated from xtrm package on `xt bootstrap`
- **Required**: No — inactive until enabled per runtime
- **Mutability**: Managed — replaceable via pack lifecycle
- **Discovery**: Direct child directories with `PACK.json`

Contains add-on packs that extend or replace default definitions. Packs can provide new skills or managed replacements.

Current optional pack catalog: `architecture-design`, `data-engineering`, `personal-tools`, `research-methods`, `security-ops`, `sre-ops`, `xt-optional`, `xtrm-development`, and `xtrm-maintenance`.

### Global user (Tier 3)

- **Source**: User-authored local files at HOME scope
- **Required**: No — opt-in
- **Mutability**: User-writable — preserved across syncs
- **Discovery**: Direct child directories with `PACK.json` under `user/packs/`

Contains custom skills and override directives. Never overwritten by managed sync operations.

### Project user (Residual)

- **Source**: User-authored local files at project scope
- **Required**: No — opt-in
- **Mutability**: User-writable — preserved across syncs
- **Discovery**: Direct child directories with `PACK.json` under `user/packs/`

Project-specific custom skills and overrides. Composed with global state.

### Project service-skills (Residual)

- **Source**: Generated by service-skills system
- **Required**: No — present only in repos with Docker services
- **Mutability**: Auto-generated — reconciled on `xt update`
- **Discovery**: Direct child directories under `user/packs/<repo>-services/service-skills/services/`

Per-service expert persona skills generated from Docker Compose topology.

## Runtime Active Views

### Global Active View (`~/.xtrm/skills/active/`)

Populated by `rebuildGlobalActiveView()`:

1. Read `~/.xtrm/skills/state.json` to get globally enabled packs
2. Discover all default skills + skills from globally enabled packs + global user packs
3. Create symlinks in active view pointing to source skill directories
4. Atomic swap: build temp view, then rename to replace old view

### Project Active View (`.xtrm/skills/active/`)

Populated by `rebuildProjectActiveView()`:

1. Compose global state + project delta state
2. Discover skills from global roots + project user roots + service-skills output
3. Create symlinks with project scope winning on path conflict
4. Atomic swap

### Resolution Order (Precedence)

1. Project user packs (highest priority)
2. Service-skills output
3. Global user packs
4. Global optional packs
5. Global default skills (fallback)

The first tier providing a valid definition wins.

## state.json Schema

### Global State (`~/.xtrm/skills/state.json`)

| Field | Type | Description |
|---|---|---|
| `schemaVersion` | string | Schema version (currently "1") |
| `enabledPacks` | object | Enabled packs per runtime: `{ claude: string[], pi: string[] }` |
| `installedVersion` | string | xtrm version that bootstrapped global tree |
| `installedFrom` | string | Package path global tree was copied from |
| `installedAt` | string | ISO 8601 timestamp of bootstrap |

Example:

```json
{
  "schemaVersion": "1",
  "enabledPacks": {
    "claude": ["code-quality", "security-ops"],
    "pi": ["code-quality"]
  },
  "installedVersion": "0.7.21",
  "installedFrom": "/home/dawid/.nvm/versions/node/v24.15.0/lib/node_modules/xtrm-tools",
  "installedAt": "2026-07-08T12:00:00.000Z"
}
```

### Project State (`.xtrm/skills/state.json`)

| Field | Type | Description |
|---|---|---|
| `schemaVersion` | string | Schema version (currently "1") |
| `enabledPacks` | object | Project delta overrides: `{ claude: string[], pi: string[] }` |

Project state is interpreted as **delta overrides** on global state. Effective runtime state:

```typescript
effectiveEnabledPacks[runtime] = [
  ...globalState.enabledPacks[runtime],
  ...projectState.enabledPacks[runtime]
]
```

Example project state:

```json
{
  "schemaVersion": "1",
  "enabledPacks": {
    "claude": ["my-project-pack"]
  }
}
```

## PACK.json Schema

Located at `<pack-root>/PACK.json` for optional and user packs:

| Field | Type | Description |
|---|---|---|
| `name` | string | Pack identifier (kebab-case) |
| `version` | string | Pack version (semver) |
| `description` | string | Human-readable description |
| `runtime` | string[] | Target runtimes: `["claude"]`, `["pi"]`, or `["claude", "pi"]` |
| `skills` | string[] | Skill directories included in pack |

Example:

```json
{
  "schemaVersion": "1",
  "name": "sre-ops",
  "version": "2.0.0",
  "description": "SRE operations: health triage, incidents, deploy verification, capacity and observability",
  "skills": ["sre-ops"]
}
```

Shipped exemplar: `optional/sre-ops` (see `.xtrm/skills/optional/sre-ops/PACK.json`).

## Invariants

Enforced by `cli/src/core/skill-discovery.ts` and `cli/src/core/skills-materializer.ts`:

- `default/` contains only skill directories with `SKILL.md`
- `optional/` and `user/packs/` contain only pack directories with `PACK.json`
- `active/` contains only symlinks pointing to valid skill directories
- Symlink targets resolve within the same scope or global scope (no broken symlinks)
- `state.json` schemaVersion matches current schema
- Enabled pack names in `state.json` correspond to existing pack directories

## CLI Commands

```bash
xt skills list [--global|--local] [--claude|--pi] [--json]
xt skills enable <pack> [--global|--local] [--claude|--pi]
xt skills disable <pack> [--global|--local] [--claude|--pi]
xt skills create-pack <name> [--global|--local]
```

| Command | Default Scope | Purpose |
|---|---|---|
| `list` | `--global` | Show global inventory (default) or composed local view |
| `enable` | `--global` | Enable pack globally (default) or locally |
| `disable` | `--global` | Disable pack globally (default) or locally |
| `create-pack` | `--local` | Create project-scoped user pack scaffold |

### Scope Resolution

- `--global`: Target `~/.xtrm/skills`
- `--local`: Target `./.xtrm/skills`
- Defaults: `list`/`enable`/`disable` → `--global`; `create-pack` → `--local`

### Output Labels

`xt skills list --local` shows source labels:

```
default/
  using-xtrm [global]
  planning [global]
optional/
  code-quality [global]
user/packs/
  my-project-pack [local]
```

See [skills.md](skills.md) for full CLI reference.

## Migration

Migrate existing per-repo `default/` and `optional/` to global SSOT:

```bash
# Bootstrap global tree (one-time per HOME)
xt bootstrap

# Per-repo migration
cd <repo>
xt migrate skills --dry-run   # Preview
xt migrate skills --apply     # Execute
```

Migration performs:

1. SHA-256 verification against `~/.xtrm/skills/`
2. Tarball backup at `~/.xtrm/migration-backups/<repo>-<timestamp>-skills.tgz`
3. Delete identical per-repo assets
4. Preserve diverged files as overrides in `.xtrm/skills/user/packs/local-legacy/`
5. Clean xtrm-owned entries from `.claude/settings.json` and `.pi/agent/settings.json`
6. Log audit trail to `~/.xtrm/logs/skills-migration.jsonl`

Full workflow: [docs/plans/global-skills-migration.md](plans/global-skills-migration.md)

## Related Docs

- [plans/global-skills-migration.md](plans/global-skills-migration.md) — Canonical migration architecture and operator workflow
- [skills.md](skills.md) — Skills catalog overview
- [project-skills.md](project-skills.md) — Residual per-repo state documentation
- [cli-architecture.md](cli-architecture.md) — CLI module reference
- [skills-registry-exploration.md](skills-registry-exploration.md) — Historical design spec (superseded, kept for context)
