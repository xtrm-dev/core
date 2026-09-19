# Board triage

Use when the Substrate board (Issues) is large, duplicated, stale, or no longer reflects current work.

1. Snapshot open/in-progress/blocked work and existing dependencies.
2. Find obvious duplicates mechanically, then verify semantic overlap against current
   implementation surfaces and intent.
3. Group items by real ownership/ship boundary, not similar titles.
4. Close/supersede only when evidence shows one item replaces another.
5. Parent or relate work only when the relationship helps execution or operator scan.
6. Detect dependency cycles and stale blockers after rewiring.
7. Re-evaluate priority from the resulting graph/current goal.

For large boards, use a read-only explorer/critic or code graph evidence to find shared
implementation surfaces. Do not let an AI similarity score mutate the board unattended.

## Durable board-audit export surface

Do not resurrect the old `issue-triage/resources/board-audit` one-shot ChatGPT bundle
exporter. Current XTRM board publication is owned by the `board-audit` package in the
`xtrm` repository.

Canonical gen-2 state per repository:

```text
branch:  board-audit-export-do-not-cancel
worktree: ~/.cache/xtrm/board-audit/export-worktrees/<repo-slug>/
content: only .xtrm/board-audit/**
ancestry: orphan artifact branch; never a code-development base
```

The worktree/branch is durable. Never cancel it, merge it into product code, or use it as
a normal implementation branch. Substrate state access comes from the state DB
(`sb issue list`), so the orphan worktree does not need a product-code checkout. (Historical
text below mentioning Beads/Dolt describes the retired board-audit transport, not current
authority.)

Use the package's current commands:

```bash
board-audit ensure <repo>
board-audit checkpoint <repo> --all
board-audit status <repo>
board-audit fanout
```

`checkpoint` is the normal publication operation. It is flock-serialized, exports through
`board-audit-core`, byte-compares the newest `raw-beads.jsonl` transport projection, and
is a complete no-op when board state did not change. It keeps a bounded export history,
commits only `.xtrm/board-audit/**`, and fast-forwards the permanent artifact branch.
The current fleet fanout timer can run this periodically without coupling publication to
PR creation or an operator remembering to export.

The branch is a durable evidence surface, not board authority. Substrate Issues remain the
source of truth. Consumers should use the latest export/manifest defined by the current
`packages/board-audit` contract rather than copying data back into Issues by inference.

### Legacy handoff/reconcile is different

The package still retains gen-1 `board-audit handoff` / `reconcile` transport for an
explicit remote desired-state editing roundtrip. That is not the canonical board-state
publication path. Use it only when the workflow intentionally needs editable desired
state and guarded three-way reconciliation.

For implementation details, retention, transport sanitization, timer operation, and
reconcile semantics, read the current `xtrm/packages/board-audit/README.md` rather than
embedding a second copy here.

Persist a concise triage result: what changed, what was deliberately left alone, and the
next actionable work.
