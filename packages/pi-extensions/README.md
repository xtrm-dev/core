# @jaggerxtrm/pi-extensions

Unified runtime package for XTRM-managed Pi extensions.

## Publish contract

- Published as `@jaggerxtrm/pi-extensions`.
- Pi loads the raw TypeScript extension entrypoints; no separate compilation step is required for the extension payload.
- `prepublishOnly` runs `verify:runtime` to ensure required runtime assets exist:
  - `src/index.ts`
  - `src/registry.ts`
  - `extensions/`
  - `themes/`
- npm package contents are controlled by `files` in `package.json`.

## Install and ownership

The portable managed identity is:

```bash
pi install npm:@jaggerxtrm/pi-extensions
```

A Core source checkout may load `packages/pi-extensions` directly while developing the package, but machine-specific absolute source paths are never part of XTRM's portable managed package contract.

Pi discovers the package through its `pi-package` metadata and extension entrypoint. XTRM's runtime reconciler owns installation/repair; operators normally use `xt init` / `xt update --apply` rather than managing the package independently.

## Managed extensions

The authoritative enrollment list is `src/manifest.json`. Notable active extensions include:

- `xtrm-ui` — XTRM-owned Pi chrome, header, themes, editor density, and native/external tool presentation. Tool execution remains Pi-native and model-facing tool results are not rewritten by the UI. `custom-footer` is the sole footer/statusline owner. See [../../docs/xtrm-ui.md](../../docs/xtrm-ui.md).
- `python-kernel` — persistent sequential `python` tool: variables, imports, functions, and cwd state survive across calls until reset. The current version also provides Python-backed skill imports, a stdlib prelude, bounded output/truncation behavior, and a kernel-side mutation audit seam. Requires `python3` on PATH. See [extensions/python-kernel/README.md](extensions/python-kernel/README.md).
- `sp-terminal-overlay` — Specialist execution/feed overlays for operator-visible monitoring.
- `beads`, `session-flow`, `read-line-numbers`, `compact-header`, `git-checkpoint`, and `xtprompt` — runtime/lifecycle and presentation helpers according to the current manifest (`xtrm-loader` retired with the bd-memory retirement).

### Service knowledge is a separate managed package

`service-knowledge` is **not** an active extension in this package anymore. Its runtime extension was relocated to the separately managed `@jaggerxtrm/pi-service-knowledge` package so it can live with the service-knowledge subsystem.

`src/manifest.json.disabled` keeps a tombstone for the retired in-package extension. That record is migration/ownership evidence and prevents an old copy from silently becoming active again.

The earlier `service-skills` extension is likewise retired; current service-specific context/runbook freshness belongs to service-knowledge.

## Runtime reconciliation

XTRM owns Pi package and extension lifecycle through the unified runtime service:

```bash
xt init
xt update --repo .          # preview
xt update --apply --repo .  # reconcile
xt doctor
```

The broader managed Pi package baseline (GitNexus, structured-return, subagents, intercom, Claude link, structural search, worktrees, processes, and optional productivity/rendering packages) is defined in Core's Pi runtime registry, not duplicated here.

Retired extension sources may remain temporarily for migration compatibility. Entries in `src/manifest.json.disabled` are not enrolled as active XTRM extensions.
