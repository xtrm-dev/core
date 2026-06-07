# `xt spec archive` Gate Criteria

> Archive is a one-way transition. We refuse to mark a spec archived unless
> every part of its execution lineage is closed and (for high-stakes specs)
> review evidence is on record.

## Gate criteria

`xt spec archive <path>` checks the following in order. Any failure refuses
the archive with the named code and a hint.

| Gate | Condition | Failure code |
|---|---|---|
| 1 | `spec.status` is exactly `planned` (not `draft`, `validated`, or `archived`) | `wrong_status` / `already_archived` |
| 2 | `spec.links.epic` is not null | `epic_missing` |
| 3 | `bd show <epic> --json` reports `status: closed` | `epic_open` |
| 4 | Every `spec.links.children[i]` is closed | `child_open` |
| 5 | Every `spec.links.test_issues[i]` is closed | `test_open` |
| 6 | For `scrutiny ∈ {high, critical}`: `bd kv get reviewed:<epic>` returns a non-empty string | `review_missing` |
| 7 | `xt spec status <path>` reports no drift | `drift_present` |

Gates 3–5 use `bd show` directly. Gate 7 reuses `xt spec status` internally.

## Review evidence convention

For high/critical scrutiny, the operator (or a reviewer chain) records
review evidence as a bd key-value pair:

```bash
bd kv set "reviewed:<epic-id>" "<evidence reference>"
# e.g.
bd kv set "reviewed:xtrm-ai9xl" "reviewer job-abc123 PASS — see sp result"
```

The archive gate only checks for presence, not content. Reviewer chains
can populate this key directly; for solo work the operator does it
manually after the final pass.

## What archive does

When the gate passes:

1. Writes a byte-identical snapshot to `<spec-dir>/archive/<spec.id>.yaml`.
2. Refuses if the snapshot already exists (no overwrite).
3. Mutates the original `spec.yaml` in place: `status: planned → archived`
   (preserving comments and key order).
4. Emits a `spec_archived` log event with the snapshot path.

## What archive does NOT do

- It does not close bd issues. They should already be closed before archive.
- It does not delete or hide the spec.yaml. The original remains; only the
  snapshot under `archive/` is immutable.
- It does not retract the planner bead. That bead's history is the
  reproducibility record and stays as-is.

## Idempotency

Re-running `xt spec archive` on an already-archived spec fails with
`already_archived` — no-op + non-zero exit. The snapshot is never
overwritten by a second run.
