# Coverage audit (AgentRun DSL)

Classifies a sync range's changed files into `new_skill` / `extend_territory` /
`leave_unowned` / `unclear` with a Jev judge per item. Proven on the
`780d4afb..c3b27bd` market-data range (55 PRs + 14 theme groups, holdout-gated).

## Layout

- `snapshot-prs.mjs` — deterministic snapshot: PR merges in `BASE..HEAD` with per-PR
  file lists + registry owner counts (project matcher semantics: fnmatch plus
  base-prefix fallback, same as `drift_detector.py`). Writes
  `results-prs/pr-files.json` with `ranAt`.
- `snapshot-coverage.mjs` — same for theme groups (fallback view).
- `workflows/pr-coverage-gaps.mjs` — the DSL workflow: class judge (4 labels) →
  boolean confirm judge on the deterministic candidate → code transcription.
  Judge-only: no extract/call nodes, needs `runJudge` only.
- `workflows/coverage-gaps.mjs` — theme-group variant.
- `run-prs.mjs` / `run-coverage.mjs` — harness: inspect + validate, `--inspect-only`,
  <1h snapshot freshness gate, Jev judge, read-only proof (HEAD + registry hash
  unchanged), holdout gate (`run-prs.mjs` only: `#936`/`#884`/`#933` must match or the
  batch is discarded with exit 4), results json + md.

## Setup

Requires Node >= 22, `@parcha/agentrun-dsl` + `@parcha/agentrun-jev` resolvable from
the run directory (symlink a `node_modules` that has them, or `npm i` them here),
a Typesafe key at `~/.secrets/typesafe_api_key.txt`, and (extract workflows only) a
`commandcode` entry in `~/.pi/agent/models.json`.

```bash
SK_REPO=/path/to/consumer node snapshot-prs.mjs
node run-prs.mjs --inspect-only   # must print validate=ok
node run-prs.mjs                  # judge run; exits 4 if the holdout gate fails
```

## Rules carried over from the pilot

- Inspect before run; never run what does not inspect clean.
- Snapshot fresh within 1h of the run; stale snapshot refuses.
- Verdicts are claims: a batch that fails the holdout/sample check is discarded,
  not applied. Single-label Jev verdicts wobble on multi-flag items — split mixed
  groups and re-run instead of forcing them.
- No workflow writes to the repo, Substrate, or GitHub. Humans apply verdicts
  (territory edits, new-skill scaffolds) through the update/create flows.
