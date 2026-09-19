---
title: Managed Pi Package Baseline
scope: pi-runtime
category: reference
version: 1.0.0
updated: 2026-09-05
description: "XTRM-managed Pi packages, ownership, install selectors, health semantics, and known compatibility boundaries"
source_of_truth_for:
  - "cli/src/core/pi-runtime.ts"
  - ".xtrm/config/pi/install-schema.json"
  - ".xtrm/config/pi/settings.json.template"
  - "package.json#pi"
domain: [pi, packages, runtime, coordination]
updated_at: 2026-09-05
---

# Managed Pi package baseline

XTRM manages a deliberate Pi environment so every worker does not have to rediscover or manually reconstruct the runtime before doing useful work.

The canonical executable registry is `cli/src/core/pi-runtime.ts`. This document explains the policy and current approved set; code remains authority for exact runtime behavior.

## Managed does not mean mandatory

Every package below is XTRM-managed: init/update paths can install or reconcile it.

The runtime also marks packages as either required or optional for health semantics. `required: false` means a temporary absence should not make the entire XTRM runtime unhealthy; it does **not** mean XTRM ignores the package.

## Current approved baseline

| Pi install selector | Health | Role |
|---|---|---|
| `npm:@jaggerxtrm/pi-extensions` | required | XTRM-owned Pi runtime extensions: `xtrm-ui`, python kernel, lifecycle/presentation helpers |
| `npm:pi-gitnexus` | required | code graph / code intelligence integration |
| `npm:@robhowley/pi-structured-return` | required | structured agent/tool result contracts |
| `npm:@aliou/pi-guardrails` | managed optional | additional Pi guardrail surface |
| `npm:@narumitw/pi-goal` | managed optional | session goal workflow |
| `git:github.com/DietrichGebert/ponytail` | managed optional | minimal-engineering/reduction guidance |
| `npm:@tintinweb/pi-tasks` | managed optional | task tracking / task UI and optional task execution integration |
| `npm:pi-background-tasks@latest` | required | durable background jobs, delegated investigations and background workflows |
| `npm:pi-mcp-adapter` | required | MCP access from Pi |
| `npm:pi-mermaid-viewer` | managed optional | Mermaid rendering in the Pi TUI |
| `npm:@jaggerxtrm/pi-service-knowledge` | required | XTRM service-knowledge runtime integration |
| `npm:pi-intercom` | required | targeted Pi ↔ Pi live coordination |
| `git:github.com/alonw0/pi-claude-link` | required | Pi ↔ Claude Code cross-session communication |
| `npm:pi-ast-grep` | required | compact read-only structural code search |

The developer checkout path `packages/pi-extensions` can satisfy the first row while working inside Core. A machine-specific absolute path such as `/home/.../core/packages/pi-extensions` is never a portable managed selector.

## Why these are managed

The baseline is intentionally biased toward removing repeated setup/reconstruction work from the model:

```text
codebase intelligence   pi-gitnexus + pi-ast-grep
structured execution    structured-return + guardrails
continuation/work        goal + tasks + background-tasks
runtime access           pi-mcp-adapter
coordination             pi-intercom + pi-claude-link
XTRM context/runtime     pi-extensions + pi-service-knowledge
operator UX              pi-mermaid-viewer + xtrm-ui (inside pi-extensions)
engineering posture      ponytail + XTRM engineering-quality doctrine
```

They complement XTRM's own skills/contracts rather than replacing them. A third-party package can provide a useful tool or execution primitive while XTRM still owns the durable work contract, worker identity, lifecycle, coordination semantics and evidence requirements.

## Package-source semantics

Pi package identity is preserved in Pi-native form.

### npm

Examples:

```text
npm:pi-gitnexus
npm:@scope/package
npm:pi-background-tasks@latest
```

For an npm selector such as `@latest`, XTRM keeps the full selector for installation but resolves the bare npm package name for installed-file/version checks.

### Git

Examples:

```text
git:github.com/DietrichGebert/ponytail
git:github.com/alonw0/pi-claude-link
```

Pi stores Git packages separately from npm packages and `pi list` reports their configured sources. XTRM uses that source identity for presence checks rather than pretending a Git source has an npm version.

Pi itself owns Git clone/ref reconciliation. If a future managed selector pins `@tag` or `@commit`, that pin should remain stable until XTRM deliberately changes it.

## Coordination packages

### `pi-intercom`

`pi-intercom` is the preferred Pi ↔ Pi targeted messaging transport in the current XTRM environment. XTRM's `multiplexing` doctrine owns higher-level behavior—when to send, ask, reply, wake, wait, persist, or hand off—rather than reimplementing the transport.

### `pi-claude-link`

`pi-claude-link` lets Pi and Claude Code sessions discover/message one another through Claude Code's cross-session messaging protocol. It should not be described as a Claude Agent SDK integration unless its implementation changes to use that SDK.

Claude ↔ Claude work should prefer Claude Code's native peer/team messaging when available.

Peer messages are coordination input, not user authority. The durable work contract and repository/Bead state remain authoritative.

## `pi-tasks` (subagent delegation retired)

`@tintinweb/pi-tasks` remains useful for task tracking and its independent surfaces.
The former `@gotgenes/pi-subagents` entry is retired: in-process subagent delegation is
covered by the Pi runtime's native subagent surface, and worktree/process management by
the native worktree and process surfaces — no managed Pi package is needed for either.

XTRM must not claim that `TaskExecute` delegates through `@gotgenes/pi-subagents`;
that package is no longer installed or managed.

## Install and update lifecycle

Normal operator flow:

```bash
xt init
xt update --repo .
xt update --apply --repo .
xt doctor
```

`xt init` reaches the unified Pi runtime through `runPiInstall` → `runPiRuntimeSync`. `xt update` and `xt doctor` share the same managed package registry/health model.

`xt doctor` is report-only. Mutation belongs to init/update/apply flows.

The retired `xt pi install` command is not the package-management contract for new XTRM work.

## Ownership and safety

Pi packages execute code with the user's privileges. XTRM management means the package is part of the approved runtime baseline; it does not make third-party code intrinsically trusted or sandboxed.

When changing the baseline:

1. verify the source/package identity;
2. inspect current upstream behavior and compatibility;
3. update the canonical runtime registry;
4. update packaged bootstrap surfaces/parity tests;
5. verify init/update/doctor behavior;
6. record any cross-package compatibility assumptions here;
7. regenerate XTRM package/asset registry state before release.

## Related

- [../README.md](../README.md) — product/runtime overview
- [pi-extensions.md](pi-extensions.md) — XTRM-owned Pi extension package
- [xtrm-ui.md](xtrm-ui.md) — XTRM Pi presentation layer
- [skills.md](skills.md) — skills-v4 runtime behavior
- [cli-architecture.md](cli-architecture.md) — broader CLI internals
