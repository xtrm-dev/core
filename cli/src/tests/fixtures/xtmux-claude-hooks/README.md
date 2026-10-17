# Vendored xtmux Claude hooks

Byte-identical copies of the Claude-runtime hooks that xtmux installs into
`~/.claude/hooks/xtmux/`. They are the units under test for
`cli/src/tests/eval-01-claude-side.test.ts` (EVAL-01 Claude column,
bead `xtrm-wiy5n.4.2.2`).

They are vendored because `@jaggerxtrm/xtmux` cannot be a Core devDependency:
its `postinstall` runs `scripts/install.mjs --from-npm`, which would rewrite
`~/.claude` on every `npm ci`. Vendoring keeps the suite deterministic in CI.
`eval-01-claude-side.test.ts` verifies every fixture against the `SHA256SUMS`
manifest next to them (CORE-2412) — it never reads the machine's installed
hooks, so the suite passes identically on CI, on main, and under load.

| File | Owner | Upstream path |
|---|---|---|
| `auto-monitor-drain-stop.mjs` | xtmux | `hooks/claude/auto-monitor-drain-stop.mjs` |
| `auto-monitor-on-send.mjs` | xtmux | `hooks/claude/auto-monitor-on-send.mjs` |
| `auto-monitor-consumed.mjs` | xtmux | `hooks/claude/auto-monitor-consumed.mjs` |
| `inbox-reminder-stop.mjs`    | core  | *(core-owned, not vendored — xtrm-wiy5n.4.24)* |

Vendored from `@jaggerxtrm/xtmux` **0.2.2**. The manifest check in
`eval-01-claude-side.test.ts` covers every file listed in `SHA256SUMS`, so a
core-owned hook that lives alongside these copies needs no upstream entry but
is still pinned against silent edits.

## Re-vendoring

Edit the hooks in the xtmux repo first — never here. Then:

```bash
for f in auto-monitor-drain-stop.mjs auto-monitor-on-send.mjs auto-monitor-consumed.mjs; do
  cp ~/.claude/hooks/xtmux/"$f" cli/src/tests/fixtures/xtmux-claude-hooks/"$f"
done
(cd cli/src/tests/fixtures/xtmux-claude-hooks && sha256sum *.mjs > SHA256SUMS)
npm test --prefix cli -- eval-01-claude-side
```

A contract break in the refreshed copy surfaces as a named scenario failure.
