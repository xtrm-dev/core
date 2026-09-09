---
title: Pi Extensions Reference
scope: pi-extensions
category: reference
version: 3.0.0
updated: 2026-09-05
description: "Current XTRM Pi extension package, managed package baseline, runtime reconciliation, and ownership boundaries"
source_of_truth_for:
  - "packages/pi-extensions/src/manifest.json"
  - "packages/pi-extensions/extensions/**"
  - "cli/src/core/pi-runtime.ts"
  - "cli/src/commands/update.ts"
  - "cli/src/commands/doctor.ts"
domain: [pi, extensions, packages, runtime]
updated_at: 2026-09-05
---

# Pi runtime and extensions

XTRM treats Pi as a managed runtime rather than a collection of unrelated local extensions.

There are two distinct layers:

1. `@jaggerxtrm/pi-extensions` — XTRM-owned extension code such as `xtrm-ui`, `python-kernel`, Beads/session lifecycle helpers, and presentation/runtime integration.
2. the managed Pi package baseline in `cli/src/core/pi-runtime.ts` — XTRM-owned plus third-party packages that `xt init` / `xt update` reconcile for the working environment.

The manifest and runtime registry are authority. Do not maintain a second frozen package/extension list in project settings or documentation.

## Package model

The portable XTRM extension identity is:

```text
npm:@jaggerxtrm/pi-extensions
```

A Core development checkout may resolve `packages/pi-extensions` directly, but developer-specific absolute paths are never part of the portable XTRM contract.

Pi supports npm, Git, URL, and local package sources. XTRM's managed registry currently uses npm and Git package identities. npm selectors such as `@latest` remain part of the install selector while runtime health checks resolve the underlying package name. Git packages use their Pi source identity and are not treated as npm packages.

## Runtime reconciliation

Use XTRM's normal lifecycle commands:

```bash
xt init
xt update --repo .          # preview managed drift
xt update --apply --repo .  # reconcile managed runtime state
xt doctor                   # report health / remediation
```

`xt pi install` is retired. Do not document or build new flows around it.

The unified Pi runtime service owns:

- managed package inventory;
- npm and Git package identity;
- package presence/freshness checks;
- managed extension enrollment;
- XTRM theme synchronization;
- legacy extension/package cleanup;
- project/global Pi settings normalization;
- launch preflight and doctor/update integration.

`xt doctor` remains report-only. Mutation belongs to init/update/apply paths.

## Managed package baseline

The exact list lives in `cli/src/core/pi-runtime.ts` and should be inspected there or through current runtime diagnostics rather than copied into another machine-local configuration.

The baseline spans:

- code intelligence and structural search (`pi-gitnexus`, `pi-ast-grep`);
- structured returns and guardrails;
- goals, task management, background work, and subagents;
- MCP access and Mermaid rendering;
- XTRM's extension and service-knowledge packages;
- Pi↔Pi and Pi↔Claude coordination (`pi-intercom`, `pi-claude-link`);
- worktree and process helpers;
- Ponytail minimal-engineering guidance.

All baseline packages are managed. The registry's `required` flag controls health semantics; it does not mean optional managed packages are ignored by reconciliation.

## `@jaggerxtrm/pi-extensions`

Canonical source:

```text
packages/pi-extensions/
├── extensions/
├── src/
│   ├── core/
│   ├── index.ts
│   ├── manifest.json
│   └── registry.ts
└── themes/xtrm-ui/
```

`src/manifest.json` is the enrollment authority. Extension directories can remain for compatibility even when a manifest entry is disabled; presence on disk does not make an extension active.

### Current notable active extensions

#### `xtrm-ui`

XTRM's Pi presentation layer. It owns the XTRM header, themes, editor density, and native/external tool presentation while preserving Pi's execution functions and model-facing tool results.

The design intentionally keeps tool and command activity visible so an operator can understand what an agent is doing and intervene on critical work. `custom-footer` is the sole footer/statusline owner.

See [xtrm-ui.md](xtrm-ui.md).

#### `python-kernel`

A persistent sequential `python` tool backed by one Python process per session. Variables, imports, functions, and cwd state survive between calls until reset.

Current functionality also includes:

- Python-backed skills exposed as importable kernel modules;
- a small standard-library prelude;
- bounded output/truncation with shape hints and temporary-file fallback;
- abort/timeout/process-group handling;
- a kernel-side mutation-audit seam.

It runs with the user's permissions and is not a sandbox. `python3` must be available unless a configured override is used.

See `packages/pi-extensions/extensions/python-kernel/README.md`.

#### `beads` and `session-flow`

Pi-side durable-work lifecycle enforcement and session continuity. These are runtime mechanics around claim/edit/commit/stop/continuation behavior; the higher-level work doctrine lives in XTRM skills and contracts.

#### `sp-terminal-overlay`

Operator-visible Specialist execution/feed overlays inside Pi.

#### Other active manifest entries

The current manifest also controls helpers such as `custom-footer`, `compact-header`, `git-checkpoint`, `xtprompt`, and `read-line-numbers`. Read `packages/pi-extensions/src/manifest.json` for the current authoritative enrollment state (`xtrm-loader` retired with the bd-memory retirement).

## Retired / relocated surfaces

### Service knowledge

Service knowledge no longer lives as an active extension inside `@jaggerxtrm/pi-extensions`.

Its current runtime package is:

```text
npm:@jaggerxtrm/pi-service-knowledge
```

The disabled manifest entry in `pi-extensions` is an ownership/migration tombstone, not an active runtime declaration. The older `service-skills` extension is retired as well.

Service-specific topology, freshness, and runbook maintenance belong to the service-knowledge subsystem. Generic XTRM/SRE skills consume that state rather than duplicating it.

### `quality-gates` Pi extension

The old extension source can remain for migration history, but the manifest disables it because its hook lookup contract is obsolete. Current quality enforcement follows the managed hook/policy architecture documented in [hooks.md](hooks.md) and [policies.md](policies.md).

### GitNexus extension / Serena

The old in-package GitNexus extension is retired; GitNexus capability is supplied through the managed Pi package and XTRM skill/runtime integration. Serena integration is no longer XTRM-managed.

## Package identity and updates

Pi package sources are intentionally preserved in canonical Pi form:

```text
npm:package
npm:package@selector
git:github.com/owner/repo
git:github.com/owner/repo@ref
```

For npm packages, XTRM compares installed and expected versions where that information is available. For Git packages, XTRM currently verifies source presence/identity; Pi itself owns clone/ref reconciliation. A pinned Git ref remains pinned until the managed selector is deliberately changed.

Pi's own `pi update --extensions` / `pi update --all` can reconcile Pi packages, but XTRM release/operator guidance should use `xt update` when the goal is to reconcile the whole XTRM-managed runtime rather than Pi packages in isolation.

## User-owned content

XTRM removes or repairs package-owned/known-retired surfaces. It does not treat arbitrary user extensions or user package entries as XTRM-owned simply because they live in Pi settings.

The same rule applies to local Core development: a recognized local `packages/pi-extensions` checkout can satisfy the XTRM extension-package identity without XTRM adding the npm copy beside it.

## Release and validation

The Pi extension package has its own publish/runtime verification contract. Core additionally tests the unified package registry and install/update/doctor behavior.

Useful repository checks include the package/runtime verification scripts defined by the current `package.json` files and the Pi runtime safeguard tests under `cli/src/tests/`.

Do not copy command names from old docs: use the repository scripts and `xt --help` from the version under test.

## Related

- [../README.md](../README.md) — XTRM product/runtime overview
- [xtrm-ui.md](xtrm-ui.md) — Pi UI and tool presentation
- [skills.md](skills.md) — XTRM skills-v4 architecture
- [hooks.md](hooks.md) — deterministic hook/event layer
- [policies.md](policies.md) — policy compiler and runtime ownership
- [cli-architecture.md](cli-architecture.md) — install/update/doctor internals
- [xt-pi-role.md](xt-pi-role.md) — Specialist role launcher behavior
