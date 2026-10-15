# Quality baseline

Set up the deterministic floor before relying on review. A tool checks every line on every
run; a prose checklist (OCR's rules, a reviewer's memory) checks what a model notices. When a
checklist item is mechanical, move it into a tool and keep review for judgment.

## The floor, per repo

Every repo with production code has, wired into one command each and into CI:

| Check | Why |
|---|---|
| Formatter | Removes style from review entirely |
| Linter, default rule set | Mechanical defects: unused code, unsafe calls, comparisons |
| Typecheck, strict where the language allows | Null/shape errors before runtime |
| Tests, including one regression test per fixed bug | Behaviour, not just shape |
| Secret scan in pre-commit | Credentials never reach history |
| Dependency audit | Known-vulnerable versions surface on change |
| CI gate on the PR | The floor is enforced, not remembered |

## Per language

| Language | Format | Lint | Types | Extra |
|---|---|---|---|---|
| TS/JS | biome or prettier | oxlint or biome (eslint when plugins needed) | `tsc --noEmit`, `strict: true` | `npm audit` |
| Python | `ruff format` | `ruff check` (add `B`, `S`, `SIM`) | pyright or mypy | `pip-audit` |
| Go | `gofmt` | `go vet`, staticcheck, errcheck (golangci-lint bundles them) | compiler | `go test -race`, govulncheck |
| Rust | `rustfmt` | `cargo clippy -- -D warnings` | compiler | `cargo audit` |
| Shell | `shfmt` | shellcheck | — | — |

## OCR checklist items that a tool owns

OCR's default rules (`ocr delegate rule`) mix mechanical items with judgment. These are the
mechanical ones; once the tool runs in CI, review skips them.

| OCR rule item | Tool rule |
|---|---|
| JS `var`, `==`, nested ternary | oxlint/eslint `no-var`, `eqeqeq`, `no-nested-ternary` |
| JS dead code, unused variables | `no-unreachable`, `no-unused-vars`; TS `noUnusedLocals` |
| JS `eval` / `Function()` | `no-eval`, `no-implied-eval`, `no-new-func` |
| TS `any` | `no-explicit-any` (typescript plugin) |
| Python mutable default arguments | ruff `B006` |
| Python bare / blind except | ruff `E722`, `BLE001` |
| Python `== None`, `is` with literals | ruff `E711`, `F632` |
| Python unclosed files | ruff `SIM115` |
| Python `eval` | ruff `S307` |
| Go unchecked errors | errcheck |
| Go leaked context cancel, copied locks | `go vet` (`lostcancel`, `copylocks`) |
| Go data races | `go test -race` |
| Rust `unwrap` in library code | clippy `unwrap_used` |
| Rust `unsafe` without a `SAFETY:` comment | clippy `undocumented_unsafe_blocks` |
| Typos in identifiers and messages | typos or cspell |

Judgment stays with review: error-handling intent, concurrency design, API shape, security
boundaries, test adequacy. That is where OCR rules and reviewers add value.

## Practices the tools cannot enforce

- Small PRs with one purpose; refactors land separately from behaviour changes.
- The commit body says why; the PR names the Issue and the evidence.
- A bug fix carries a test that failed before the fix.
- Fail loudly at trust boundaries; never swallow an error to make a check pass.
- Delete dead code instead of commenting it out.

## Adopting it in an existing repo

1. Audit what exists (cell below). Do not add a second tool for a job one already does.
2. Add the missing tool with its default rule set. Do not hand-tune rules first.
3. Run it once. Fix trivial violations; baseline the rest (tool baseline file or per-path
   ignores), so new code is held to the rule from day one.
4. Wire it into the repo's `lint`/`check` script, pre-commit where fast, and CI.
5. Ratchet: shrink the baseline when touching those files; add rules only after the defaults
   are clean.

Audit in one codemode cell (Pi); in Claude Code, run the same probes in one Bash call:

```js
const out = (r) => (typeof r === "string" ? r : r.output);
const probes = {
  scripts: "jq -r '.scripts // {} | keys[]' package.json 2>/dev/null | grep -E 'lint|type|test|format|check'",
  configs: "ls -a | grep -E '^(biome|\\.oxlintrc|eslint|tsconfig|ruff|pyproject|\\.golangci|clippy|rustfmt|\\.pre-commit|\\.editorconfig)'",
  ci: "ls .github/workflows 2>/dev/null",
  precommit: "grep -E 'id: ' .pre-commit-config.yaml 2>/dev/null",
};
const r = await Promise.allSettled(Object.values(probes).map((command) => tools.bash({ command })));
return Object.fromEntries(Object.keys(probes).map((k, i) =>
  [k, r[i].status === "fulfilled" ? out(r[i].value).trim().split("\n") : r[i].reason.message]));
```

Record the gaps as Issues; the floor is repo work, not a review finding against one PR.
