# Beads → Substrate transition

`xt update --apply` refuses repo-scoped writes in a repository that still has a
legacy `.beads` board. This page explains what that gate protects, what it does
not block, and what the supported path forward is.

## What the gate does

A present `.beads` board is treated as **not yet migrated**, always — even if a
marker file claims otherwise. While that is true, `xt update --apply`:

- **blocks** registry install, skills install, project hook rewiring, service
  skills, and staging — every write under `<repo>/.xtrm`;
- **does not block** user-scoped maintenance: the global skills payload under
  `~/.xtrm`, hook rewiring, prompt sync, and Pi package assurance.

Those two sets have different blast radii. The first can interact with your
board; the second cannot reach it. A blocked repository is therefore **not** a
dead end for keeping the machine current — it only means the repository's own
managed state is frozen until the board is migrated.

## What it protects you from

`.beads` is the only copy of that board. Deleting, renaming, moving, or
hand-migrating it is irreversible work loss, so the gate fails closed and the
message it prints says so explicitly. **Do not delete `.beads`. Do not
hand-migrate it.**

## Inspecting the current state

```bash
xt doctor
```

The Substrate section reports the board state, `sb` availability, and the
transition status. For machine-readable state per repository, use the `migration`
field of `xt update --json`:

```bash
xt update --apply --json | jq '.repos[] | select(.migration.needed) | {repo, status: .migration.status}'
```

A repo with `"status": "transition-pending"` is waiting on the automated import.

## The supported path

Automated migration — export, import, preservation verification, receipt
interpretation, cleanup, and cutover — ships with the **A9 pipeline**. It has not
shipped yet. Until it does:

- **no released version of `xt` clears this gate**, so "upgrade xt and re-run"
  is not an available action. Any message telling you to do that is wrong.
- manual import exists (`sb import beads --file <export.jsonl> --project <id>`,
  with `--dry-run` to preview counts) but is **not** the supported posture: it
  carries no preservation verification and no receipt, so a partial import cannot
  be distinguished from a complete one.

Once A9 ships, run the automated migration for the repository. On success it
writes `.xtrm/.substrate-migrated.json`; only after that marker exists *and* the
board is gone does the gate stop blocking repo-scoped writes.

## Related

- Detection and planning: `cli/src/core/substrate-migration.ts`
- Gate enforcement: `cli/src/commands/update.ts` (`updateRepo`, `preflightFleetMigration`)
- ADR 43 rationale: the board must never be stranded by an automated cutover