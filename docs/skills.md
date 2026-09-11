---
title: Skills Catalog
scope: skills
category: overview
version: 4.0.0
updated: 2026-09-04
description: "Current XTRM managed-skill tiers, universal defaults, optional packs, user packs, and runtime composition"
source_of_truth_for:
  - ".xtrm/skills/default/**"
  - ".xtrm/skills/optional/**"
  - "~/.xtrm/skills/**"
domain: [skills, claude, pi, codex]
updated_at: 2026-09-04
---

# Skills

XTRM v4 keeps the always-active surface deliberately small. Managed universal skills live
in `default/`; domain/maintainer capabilities live in opt-in packs under `optional/`; user
packs are separate flat siblings and are never repaired as package-owned content.

## Tier model

```text
~/.xtrm/skills/
├── default/        # package-managed universal skills
├── optional/       # package-managed opt-in packs
├── <user-pack>/    # user-managed global packs
└── active/         # composed global runtime view

<repo>/.xtrm/skills/
├── <user-pack>/    # project-local user packs
├── active/         # composed project runtime view
└── state.json      # local enablement/runtime state
```

Do not put user-authored content in managed `default/` or `optional/`. Create a supported
flat user pack instead:

```bash
xt skills create-pack <name> --global   # ~/.xtrm/skills/<name>/
xt skills create-pack <name> --local    # .xtrm/skills/<name>/
```

## Universal defaults

The v4 default set is intentionally ten skills:

| Skill | Purpose |
|---|---|
| `using-xtrm` | system-level work, evidence and operating doctrine |
| `starting-and-resuming-work` | cold start, continuation, handoff and context-pressure recovery |
| `multiplexing` | peer/subagent messaging, coordination and reply/continuation obligations |
| `planning` | durable work contracts, board decomposition, premortem and test strategy |
| `engineering-quality` | causal debugging, review, testing, verification and reduction discipline |
| `using-specialists` | Specialists execution backend and advanced Specialists references/assets |
| `gitnexus` | code graph exploration, impact, debugging and review support |
| `skill-creator` | skill authoring/evaluation discipline |
| `find-skills` | discover/select additional skill capabilities when needed |
| `goal-prompt` | single-issue goal-prompt transform with stop-predicate payloads |

A specialized capability should not move into default merely because it is valuable. It
belongs there only when ordinary XTRM work should pay its trigger/context cost by default.

## Shipped optional packs

The current package ships these managed packs:

| Pack | Purpose |
|---|---|
| `architecture-design` | architecture and prompt/design patterns |
| `data-engineering` | data/SQL/storage engineering capabilities |
| `personal-tools` | personal opt-in tooling such as `vaultctl` |
| `research-methods` | deep/recent/documentation/code research and fact checking |
| `security-ops` | security investigation plus repository security baseline bootstrap |
| `sre-ops` | live SRE/observability, causal production debugging, deploy/capacity workflows |
| `xt-optional` | specialized XTRM CLI/operator helpers that should not be universal |
| `xtrm-development` | XTRM runtime/hook/workflow development; includes `hook-development` |
| `xtrm-maintenance` | releases, dependency updates, docs sync, Specialists update and maintenance |

Inspect the live pack rather than relying on a frozen skill list:

```bash
xt skills list --global --json
xt skills list --local --json
```

Enable or disable packs through the current CLI:

```bash
xt skills enable <pack> --global
xt skills disable <pack> --global
xt skills enable <pack> --local
```

Use `xt skills --help` for runtime-specific flags supported by the installed version.

## Specialists ownership

`using-specialists` and `update-specialists` are authored in `xtrm-dev/specialists` and
vendored into Core from a pinned Git commit. Only `using-specialists` is default;
`update-specialists` lives in `xtrm-maintenance`.

Advanced Specialists surfaces no longer consume separate active skill roots:

```text
using-specialists/
├── SKILL.md
├── references/
│   ├── kpi.md
│   ├── nodes.md
│   ├── script-class.md
│   └── specialist-definitions.md
└── scripts/specialist-definitions/
```

See `docs/skills-ownership.md` for source/placement/release invariants.

## Runtime composition

Managed/default and enabled optional packs are composed into active runtime views together
with supported user packs. Runtime adapters point Claude/Pi/Codex-compatible skill loading
at those composed views according to current Core implementation.

The active view is generated state. Do not author directly inside it and do not treat
installed symlink targets as a new source repository.

## Package and update safety

Package-owned paths can be repaired/pruned during `xt update --apply`. User packs survive
because they live outside the managed `default/` and `optional/` roots. If a user-owned
name collides with a managed skill, reconciliation should fail loudly rather than silently
overwriting it.

Release validation checks managed skill frontmatter/layout, optional `PACK.json`
declarations, Specialists vendor provenance, generated registry/package parity, and
forbidden nested runtime roots.

## Consolidation history

Skills v4 deliberately removed many top-level triggers without discarding useful
capability. The normative disposition of former v3 skills is recorded in:

`docs/skills-v4-preservation-matrix.md`

That matrix distinguishes:

```text
absorbed into a v4 root/reference
moved to an optional pack or XTRM subsystem
owned by deterministic runtime/CLI machinery
intentionally retired
```

Examples include:

- `sre-triage`/deploy/capacity reasoning -> `sre-ops`;
- old runbook updates -> `xtrm/packages/service-knowledge`;
- old one-shot board exporter -> permanent `xtrm/packages/board-audit` export branch;
- Specialist KPI/nodes/script/definition roots -> `using-specialists` references/assets;
- `security-pipeline` concrete assets -> `security-ops/security-bootstrap`;
- release/dependency/docs maintenance -> distinct `xtrm-maintenance` skills.

## Related

- `docs/skills-ownership.md` — authoring/vendor ownership and placement
- `docs/skills-v4-preservation-matrix.md` — migration preservation evidence
- `docs/skills-tier-architecture.md` — deeper runtime/tier implementation detail
- `docs/hooks.md` — deterministic policy/hook layer
