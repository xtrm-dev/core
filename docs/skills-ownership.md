---
updated_at: 2026-09-04
---

# Skills ownership and placement

Machine-readable source: `docs/skills-ownership.json`.
Release mirror metadata: `docs/skills-ownership.release.json`.

## Authority

Core-owned skills are authored in `xtrm-dev/core` and shipped through the package/global
materialization path. Installed copies under `~/.xtrm/skills/**`, `.claude/skills`, or
runtime views are generated/managed state, not an independent authoring source.

Specialists-owned skills are authored in `xtrm-dev/specialists/config/skills` and vendored
into Core from an immutable `source.resolved_sha`. The vendor operation reads runtime
material from that exact Git commit; it must not copy the current checkout working tree
and then merely label the result with a pin.

`releasing` remains Core-owned.

## Specialists-owned distributed surface

The v4 distribution intentionally exposes only one Specialists-owned skill root:

| Skill | Placement | Reason |
|---|---|---|
| `using-specialists` | `default` | Universal Specialists execution-backend doctrine used by ordinary XTRM agents. |

KPI analysis, NodeSupervisor, script-class execution, and Specialist-definition authoring
are advanced surfaces of the same execution backend and therefore live under
`using-specialists/references/*` with deterministic authoring helpers under
`using-specialists/scripts/specialist-definitions/*`. They are not separate active skill
triggers or an extra `specialists-advanced` pack.

`using-specialists-auto` is intentionally retired. Automatic routing is handled by normal
XTRM contract/execution selection rather than a duplicate Specialist skill.

The placement contract is declared in `docs/skills-ownership.json`.
`scripts/vendor-specialists-skills.mjs` materializes declared runtime files and writes
`.xtrm/specialists-source.json` v2 with the immutable upstream commit, placement, and Git
blob identities. Evaluation fixtures/workspaces remain upstream in Specialists and are not
part of the Core runtime payload.

## Managed skill tiers

```text
~/.xtrm/skills/
├── default/       package-managed universal skills
├── optional/      package-managed opt-in packs
├── <user-pack>/   user-managed global packs
└── active/        composed runtime view
```

Project user packs live under `.xtrm/skills/<pack>/`. Package-managed `default/` and
`optional/` are reconstructed from the package registry; do not put user-authored content
there.

Enable optional packs through the current `xt skills` CLI, for example:

```bash
xt skills enable sre-ops --global
xt skills enable xtrm-maintenance --global
xt skills enable xtrm-development --local
```

Use live `xt skills --help` for exact syntax.

## Update/materialization safety

Registry-owned paths may be repaired or pruned on update:

- `~/.xtrm/skills/default/**`
- `~/.xtrm/skills/optional/**`
- managed runtime-view symlinks resolving into those roots

User-owned global/project packs are preserved. A user-owned collision with a managed skill
name must fail loudly rather than being overwritten.

Do not hand-edit a managed installed copy as a durable repair. Change the owning source,
regenerate/vendor the package payload, regenerate `.xtrm/registry.json`, and verify
materialized parity.

### Retired managed-skill prune

`xt update --apply` and `xt clean --skills-only` remove default-tier skills that a previous
install owned and the current registry no longer ships. The proof of ownership comes from the
installer manifest (global skills root) or the previous `registry.json` snapshot (project
scope). Prune is not a general cleanup command:

1. **Guard.** A prune that retires at least half of the previously managed set, or shrinks that
   set by half or more, refuses by default. Nothing is deleted. The operator re-runs with
   `--yes` to accept the contraction.
2. **Snapshot.** Before the first removal, the skills root is archived to
   `~/.xtrm/migration-backups/global-skills-<timestamp>.tgz` with a `.sha256.json` sidecar
   (same verified helper as `ensureGlobalSkillsBootstrapped`). A prune never deletes without a
   restorable snapshot.
3. **Audit log.** Every prune appends one `prune.retired-managed` event to
   `~/.xtrm/logs/skills-migration.jsonl` before touching disk, recording the registry source
   path, the managed-set digest, counts, removed names, swept link count and the backup path.
   Outcomes are `ok`, `planned` (dry run), `refused` and `override` (explicit `--yes`).
4. **Active views.** The sweep removes only symlinks whose target is the retired
   `default/<name>` entry, in both layouts: the v1 flat `active/<name>` and the v2 per-runtime
   `active/<runtime>/<name>` (`pi`, `claude`, `codex`). Real directories and symlinks into user
   packs stay.

A dry run (`--dry-run`) reports the same removals and appends a `planned` log line without
snapshotting or deleting anything.

## Release invariants

A Core release is not skill-clean unless:

1. every Specialists-owned distributed skill appears exactly once at its declared placement;
2. retired duplicate roots (`using-specialists-auto`, `specialists-advanced`) are absent;
3. vendored runtime files match the pinned Specialists Git commit/blob identities;
4. vendor, ownership, and release manifests agree on source SHA and placements;
5. optional `PACK.json` files declare every placed optional skill;
6. generated registry and npm package payload agree;
7. no nested runtime roots (`.claude`, `.agents`, `.pi`) exist inside a managed skill root;
8. default roots remain the small universal XTRM operating surface;
9. removed v3 capabilities have a recorded disposition in `docs/skills-v4-preservation-matrix.md`.

Relevant release guards include `check:skills-ownership`, `check:managed-skills`,
`check:specialists-vendor`, `check:vendored-specialists-parity`,
`check:registry-pack-parity`, layout/root-budget guards, and package/build/tests.
