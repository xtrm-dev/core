---
title: Test Suites
scope: testing
category: reference
version: 1.1.0
updated: 2026-11-23
description: "Which command runs which test suite in this repository, which packages each one covers, and why there is no single root script"
source_of_truth_for:
  - vitest.config.ts
  - package.json scripts.test, scripts.test:scripts, scripts.test:contracts
  - cli/package.json scripts.test
  - .github/workflows/ci.yml
domain: [testing, ci, cli, pi-extensions, contracts]
updated_at: 2026-11-23
---

# Test Suites

This repository does not have one test runner. Four suites run under three different
runners, and CI runs all four. No single root script runs them in CI's order; the
reason is at the end of this document.

Run every command from the repository root unless the working directory is named.

## The split

| Suite | Command | Covers |
|---|---|---|
| CLI | `npm test --workspace cli` | `cli/src/**/*.test.ts`, `cli/test/**/*.test.ts` |
| Pi extensions | `bun test packages/pi-extensions` | `packages/pi-extensions/**/*.test.ts` (colocated and under `tests/`) |
| Repository scripts | `npm run test:scripts` | `scripts/__tests__/*.test.mjs` |
| Contracts | `npm run test:contracts` | `packages/contracts` (via `npm test --workspace @xtrm/contracts`) |

CI also runs one command that is not a test suite:
`node .xtrm/skills/default/engineering-quality/scripts/ocr-preflight.mjs selftest`
(the OCR pre-flight has no other harness).

## A new test file is only run if a suite's glob reaches it

The suites are disjoint by directory, and nothing warns when a test lands in a
directory no runner covers. Check placement against the table above before writing the
test, not after — a test file that no command runs is green by absence.

The proof is one throwaway file. `packages/pi-extensions/tests/` is covered by
`bun test packages/pi-extensions` and by nothing else:

```
$ cat > packages/pi-extensions/tests/visibility-probe.test.ts <<'EOF'
import { describe, expect, it } from "bun:test";

describe("XTRM-961 visibility probe", () => {
    it("is observed only by the runner that covers packages/pi-extensions", () => {
        expect("probe").toBe("probe");
    });
});
EOF

$ bun test packages/pi-extensions | grep -c visibility
1                                    # the runner that owns the tree sees it

$ bun test packages/pi-extensions | tail -2
Ran 1113 tests across 65 files       # 1112 / 64 without the file

$ npx vitest run | grep -c visibility
0                                    # the root command does not
```

Delete the probe afterwards. If a test must live somewhere none of the four suites
covers, the fix is a glob in the owning runner's config or a move — not a new root
script, for the reason in the last section.

## Why `npx vitest run` at the root is not the CLI suite

`vitest.config.ts` exists at the root solely to stop `npx vitest run` from globbing
test files across every `.xtrm/worktrees/*/cli/src/tests/` tree, which would multiply
any failure by the number of worktrees present. Its `include` is
`['cli/src/**/*.test.ts', 'cli/test/**/*.test.ts']` and its `exclude` drops
`**/node_modules/**`, `**/dist/**`, `.xtrm/worktrees/**`, `.git/**`.

The canonical entry point is `npm test --workspace cli`. The root config is a safety
net, not an entry point: it covers the CLI suite only and does not run
`packages/pi-extensions`, `scripts/__tests__`, or `packages/contracts`.

It also does not configure that suite. `cli/vitest.config.ts` sets
`testTimeout: 30000`, `setupFiles: ['./test/setup.ts']`,
`globalSetup: ['./test/tmp-leak-guard.ts']`, and a `retry` on
`ENOENT|EPERM|ECONNREFUSED`; the root config sets none of them, so the same files run
against vitest's 5 s default and no setup. The two commands therefore share a file set
and not a result: at `9966d453` the CLI command reported 4 failing tests and the root
command reported 58, over the identical 203 files. One file shows it without any other
variable:

```
$ npx vitest run cli/test/end-autonomy.test.ts          # from the repository root
 Test Files  1 failed (1)
      Tests  2 failed | 1 passed (3)

$ cd cli && npx vitest run test/end-autonomy.test.ts
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

Read a root run as evidence about which files exist, never as evidence about whether
the CLI suite passes.

## Observed counts

Measured on 2026-11-23 at `9966d453`, on a clean install (`npm ci` at the repository
root, `npm ci --prefix cli`, then `npm run build:contracts`). A worktree whose
`node_modules` are symlinked to another checkout produces spurious failures — missing
`dist/index.cjs`, and cwd-derived paths under the wrong `.xtrm/worktrees` entry — so
the install is part of the measurement, not a preliminary.

- `npm test --workspace cli` — 203 test files (198 passed, 2 failed, 3 skipped),
  3016 tests (2949 passed, 4 failed, 63 skipped).
- `npx vitest run` (repository root) — the same 203 files (185 passed, 15 failed,
  3 skipped), 3016 tests (2895 passed, 58 failed, 63 skipped). The difference is
  environment, not scope; see the section above.
- `bun test packages/pi-extensions` — 1112 tests across 64 files (1104 pass, 5 skip,
  3 fail).
- `npm run test:scripts` — 114 tests, 15 suites, all pass.
- `npm run test:contracts` — 175 tests across 4 files, all pass.

The failures above are pre-existing at that head. The CLI suite's four are three
`review-posting` local-store cases that assert empty stderr and receive Node's
`ExperimentalWarning: SQLite is an experimental feature`, and one
`buildBufferedRuntimeCommand` timing case. The Pi extensions suite's three are two
`Monitor` ws-mode cases at their 5 s budget and one refused-connection case. None of
them are evidence about a change under review; all of them are evidence that a green
count must name the head and the runner it came from.

Treat the counts as a size, not a target. They move with every merge.

## CI order

`ci.yml` step **Run Tests** runs, in this order:

1. `npm test --prefix cli`
2. `npm run test:scripts`
3. `node .xtrm/skills/default/engineering-quality/scripts/ocr-preflight.mjs selftest`
4. `bun test packages/pi-extensions`

`npm run test:contracts` and `npm run build:contracts` run earlier in the workflow.
`XTRM_TMP_STRICT: "1"` is set for the step because the temp-dir guard fails the job on
a survivor on any platform that sets `TMPDIR`.

## No single root script

There is deliberately no `npm test` that runs all four suites in CI's order.

Each suite has its own runner (`vitest`, `bun test`, `node --test`), its own
configuration, and its own environment requirements, and the Pi extensions suite is
asserted to be cwd-independent so that it can run from the root. A root script would
have to reproduce that order and those environments, and it would then be a second
definition of the test surface that can diverge from `ci.yml` silently — the same
defect this document exists to describe. The workflow file is the single definition;
this page names it and the commands it runs.

Contributors who want everything should run the four commands in the order above.
Contributors iterating on one package should run that package's command only.

## Related

- `docs/testing.md` — the production live-testing checklist (hooks, skills, release
  gates), which is a different document.
- `CLAUDE.md` § Local validation — the short list of gates to run while working.
