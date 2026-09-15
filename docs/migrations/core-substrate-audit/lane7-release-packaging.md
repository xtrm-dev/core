# Lane 7 — Release / packaging / compatibility audit (Core)

Read-only architecture audit. No source, config, lockfile, or runtime state was modified. The only
file created is this report. Allowed read-only evidence used: `git log/tag/show`, `npm view`,
`gh release list`, and streaming reads of the published tarballs (no download to disk).

Statement classes: **VERIFIED** = cited source/registry read in this session. **INFERRED** = derived
from verified facts. **RECOMMENDATION** = proposal. **UNRESOLVED** = cannot be decided from evidence.

---

## 0. Baseline re-verification and corrections

| Fact | Prompt claimed | Actually observed | How verified |
|---|---|---|---|
| Core | `xtrm-dev/core` main `e3c09927f115a9ad551953ede2262c91a9bbb431` | Confirmed | `git rev-parse HEAD` in worktree and in `/home/dawid/dev/core` |
| Substrate upstream | `12e71d743a32c7b27af6c3e792574cfa08e7b81a` | Confirmed | `git -C /home/dawid/dev/xtrm rev-parse origin/main` |
| Specialists upstream | `67100f1362c01f0972e081795be805297be8e8a9` | **CORRECTED**: `origin/master` = `31887a4e55d25a57b90f06feef580ae148e29e9d`; `67100f13` is the parent, one commit behind | `git -C /home/dawid/dev/specialists rev-parse origin/master`; `git log --oneline -2 origin/master` |
| Published npm | `@jaggerxtrm/substrate@0.1.2`, `@jaggerxtrm/specialists@3.21.6`, `xtrm-tools@0.12.0` | Confirmed; also `@jaggerxtrm/pi-extensions@0.12.0`, `@jaggerxtrm/xtmux@0.2.5` latest | `npm view <pkg> dist-tags version` |
| Worktree | clean | Clean; only this lane's `docs/migrations/` is untracked | `git status --short` |

Context-dependent upstream observed this session: Specialists `origin/master` is one commit past the
prompt baseline; Substrate main already carries an unreleased post-`0.1.2` work pile under the same
version string (`packages/substrate/package.json` = `0.1.2`; npm `@jaggerxtrm/substrate@0.1.2`
`gitHead` = `27d2a32e24ddbd6f09a1555af22eedc375862673`). INFERENCE: the live master tip is not the
published artifact for either repo. UNRESOLVED: whether either project will bump before the next
Core release (see §7).

Authority model used for Target owner: Substrate owns durable work; Specialists owns participant
runtime; Core owns installation/launch/UX/compatibility/composition; Git owns code truth.

---

## (A) Package / version / enforcement table

Legend: **Published?** = does this repo publish it to a public registry today.

| # | Package / artifact | Declared version | Published? | Declared range(s) elsewhere | Enforcement point(s) | Consumes Substrate? | Consumes Specialists? | Confidence |
|---|---|---|---|---|---|---|---|---|
| A1 | `xtrm-tools` (root `package.json`) | `0.12.0` | Yes (npm latest `0.12.0`, 2026-09-04T14:46:02Z) | none against siblings | `prepublishOnly` chain; `ci.yml`; `publish.yml` | No npm dep — shells to `sb` | No npm dep — git-ref vendoring | VERIFIED |
| A2 | `xtrm-cli` (`cli/package.json`, `private: true`) | `0.12.0` (synced from root) | No (packed inside A1) | devDep `@xtrm/contracts ^0.11.1` | `sync:cli-version` (prebuild, version lifecycle) | via `cli/src/core/substrate.ts` | via `runtime-compat.ts` | VERIFIED |
| A3 | `@jaggerxtrm/pi-extensions` (`packages/pi-extensions/package.json`) | `0.12.0` | Yes (latest `0.12.0`) | none | own `prepublishOnly` = `verify:runtime` only; `publish.yml` step | No | No | VERIFIED |
| A4 | `@xtrm/contracts` (`packages/contracts/package.json`) | `0.11.1` | **No — npm E404** | cli devDep `^0.11.1`; workspace resolution in monorepo | `build:contracts`; no publish step in any release script | No | No | VERIFIED |
| A5 | `@jaggerxtrm/specialists` (consumed) | — | Yes (latest `3.21.6`) | `docs/runtime-compatibility.json` `>=3.21.0 <4` | `xt claude`/`xt pi` launch preflight only | No | yes | VERIFIED |
| A6 | `@jaggerxtrm/xtmux` (consumed) | — | Yes (latest `0.2.5`) | `docs/runtime-compatibility.json` `>=0.1.0 <0.3` | launch preflight only | No | No | VERIFIED |
| A7 | `node` (engine) | — | n/a | root+cli `engines.node >=24.0.0`; contract `core.requires.node` | `scripts/check-runtime-compatibility.mjs` (build) + launch preflight | No | No | VERIFIED |
| A8 | `@jaggerxtrm/substrate` (bin `sb`, consumed) | — | Yes (latest `0.1.2`) | **NONE declared anywhere** | none (see §5 F-1) | yes | No | VERIFIED |
| A9 | `@xtrm/substrate` (stale name in code) | — | **No — npm E404** | `dependency-maintenance.ts` TOOLS; `substrate.ts` docheader/code | `runDependencyMaintenance` (report only) | yes (stale) | No | VERIFIED |
| A10 | `gitnexus` (bin) | — | Yes (`gitnexus` on npm) | none | `runDependencyMaintenance` latest-check only | No | No | VERIFIED |
| A11 | Pi package set (root `pi.packages[]`, 16 entries) | mostly `@latest` / git URLs | n/a | `package.json` ⇔ `install-schema.json` ⇔ `settings.json.template` | `cli/test/pi-packages-parity.test.ts` | No | No | VERIFIED |
| A12 | Vendored skills `.xtrm/skills/default/**`, `optional/**` | content, not version | shipped in A1 | `.xtrm/specialists-source.json` `resolved_sha = 5d2f2907…` | `check:specialists-vendor`, `check:vendored-specialists-parity`, `check:registry-pack-parity` | No | yes (vendored bytes) | VERIFIED |
| A13 | Specialists catalog pins (upstream) | per-catalog e.g. gitnexus `0.6.4`, python-kernel, service-knowledge, native | shipped in A11-sibling (specialists pkg) | caret-of-baseline comparator | Specialists runtime gate + `sp doctor` | No | yes | VERIFIED |

Specials note on A5: `docs/runtime-compatibility.json:7` states the check is enforced at interactive
worktree launch only, and that "A sibling that is absent or unresolvable is never an incompatibility."
`XTRM_SKIP_RUNTIME_COMPAT=1` overrides. This is the only compatibility enforcement Core has.

---

## (B) Release-path change inventory

Columns exactly as requested:
`Current surface | Current behavior | Current owner | Target owner | Target primitive | Evidence | Action | Upstream dependency | Ordering | Acceptance proof | Migration hazard | Release impact | Confidence`

| Current surface | Current behavior | Current owner | Target owner | Target primitive | Evidence | Action | Upstream dependency | Ordering | Acceptance proof | Migration hazard | Release impact | Confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Root `package.json` name/version/bin/`files[]` | Version `0.12.0`; bin `xtrm`/`xt`/`ghgrep`; packs `cli/dist`, `docs/runtime-compatibility.json`, `.xtrm/{config,hooks,skills/default,skills/optional,registry.json}`, `packages/pi-extensions` | Core | Core | Single authoritative version; keep `files[]` contract | `package.json:1-44` | KEEP | none | — | `npm pack --dry-run` includes `docs/runtime-compatibility.json`; `runtime-compat.test.ts:105-111` asserts it | none | none | VERIFIED |
| `cli/package.json` | `private: true`, version mirrored from root, own bin; packed inside A1 | Core | Core | keep | `cli/package.json:1-25`; `scripts/sync-cli-version.mjs` | KEEP | none | — | `sync:cli-version` idempotent | hand-editing cli version diverges from root | none | VERIFIED |
| `packages/pi-extensions` publish path | Published by `npm publish -w … --provenance --access public` in `publish.yml:121-124` and `release:pi-extensions`; its `prepublishOnly` runs only `verify:runtime` | Core | Core | give it the same sibling-compat evidence as A1 | `packages/pi-extensions/package.json:35-38`; `publish.yml:121-124` | ADAPT | Specialists (indirect) | after root build | parity/compat evidence on the pi-extensions publish step | workspace publish bypasses root `prepublishOnly` gates | new gate may block a pi-extensions-only publish | VERIFIED |
| `packages/contracts` | Version `0.11.1`, `publishConfig.access=public`, but never published (E404); only consumed as a workspace/devDep | Core | Core | decide: publish it, or drop public `publishConfig` | `packages/contracts/package.json:6-8,43-56`; `npm view @xtrm/contracts` E404 | ADAPT | npm | before any external consumer relies on `^0.11.1` | `npm view @xtrm/contracts version` resolves | `cli` devDep `^0.11.1` breaks for any non-workspace install | latent: an accidental `npm publish` publishes an undeclared public package | VERIFIED |
| `scripts/sync-cli-version.mjs` | Root version is authority; propagates to `cli` and `packages/pi-extensions`; `prebuild` + `version` lifecycle | Core | Core | keep | `scripts/sync-cli-version.mjs:1-55`; `package.json:54,71` | KEEP | none | before every build | idempotent run | none | none | VERIFIED |
| npm `version` lifecycle | `changelog:update --tag v$version && sync:cli-version && git add CHANGELOG.md cli/package.json packages/pi-extensions/package.json` | Core | Core | keep; consider adding the frozen-release pin file to the same atomic commit | `package.json:71` | ADAPT | git-cliff | at bump time | `npm version patch --no-git-tag-version` produces expected diff | partial version bump if interrupted | none | VERIFIED |
| `prepublishOnly` chain | 20-step chain: sync → ownership → managed-skills → deprecations → pi-manifest → runtime-compat → **re-vendor specialists from `${resolved_sha}`** → gen-registry → parity → payload hygiene → vendor verify → layout guards → … → build | Core | Core | deterministic, frozen inputs at publish time | `package.json:82`; `scripts/vendor-specialists-from-manifest.mjs:16-31` | ADAPT | Specialists repo (git) | before `npm publish` | chain green on a clean checkout | re-vendoring at publish mutates `.xtrm/skills/**` and `.xtrm/registry.json` in the working tree; the *published* registry is not the committed one (§F-8) | any re-vendor failure blocks publish | VERIFIED |
| `npm run release` / `release:all` | `npm publish --tag latest` (+ pi-extensions) — direct publish path, distinct from `publish.yml` | Core | Core | one release entrypoint | `package.json:83-85` | ADAPT | npm | — | documented single path | two publish paths can diverge (local vs GitHub release) | operator could publish without the fresh-machine smoke | VERIFIED |
| `cli/src/commands/release.ts` (`xt release prepare` / `xt release publish`) | `prepare` needs xt reports in range then calls `sp script changelog-keeper --read-only`; `publish` tags `v<cli version>`, `git push --follow-tags`, optional `gh release create` | Core | Core | keep as the tagging surface; keep scope guard | `cli/src/commands/release.ts:24-135`; `cli/src/tests/release.test.ts:31-76` | KEEP | Specialists (`sp`), git, gh | after changelog prepare | `release.test.ts` scope/tag assertions | scope allowlist `CHANGELOG.md`, `cli/package.json`, `cli/dist/**`, `dist/**` rejects a version-pin file unless added | tags a release even if `publish.yml` later fails | VERIFIED |
| `publish.yml` `resolve_ref` | Reads `.source.resolved_sha // .source.ref` from `.xtrm/specialists-source.json` (a **git SHA/ref**) and passes it as `specialists_ref` | Core | Core | resolve a **frozen release identifier** (npm version + integrity), not a moving ref | `publish.yml:8-32` | ADAPT | Specialists repo | first job | resolved value is an immutable release id present on npm | moving `master` fallback if `resolved_sha` ever absent | changes DAG order of checks | VERIFIED |
| `publish.yml` `fresh_machine_smoke` | `workflow_call` into `fresh-machine-smoke.yml` with the resolved git ref; publish is blocked until it passes | Core | Core | keep gate; feed it frozen tarballs | `publish.yml:34-38` | ADAPT | Specialists tarball | before `publish` | smoke job green | smoke currently packs Specialists **from the source checkout** | stronger freeze may surface new failures | VERIFIED |
| `publish.yml` `publish` steps | 6 gates then `npm publish --provenance`; then `npm publish -w @jaggerxtrm/pi-extensions --provenance --access public` | Core | Core | keep provenance; extend gates | `publish.yml:40-125` | ADAPT | npm, Specialists source | last | tarball installed + help/doctor smoke (`install-update-ux-smoke.mjs`) | none | adds publish time | VERIFIED |
| `pre-publish-readiness.yml` | Operator dry-run of the exact publish chain minus `npm publish`; resolves the same git ref | Core | Core | keep as the dry-run of whatever freeze the release selects | `pre-publish-readiness.yml` | ADAPT | Specialists | before tagging | "all jobs passed" implies `publish.yml` passes | drifts if `publish.yml` changes and this is not updated | low | VERIFIED |
| `fresh-machine-smoke.yml` | Checks out `Jaggerxtrm/specialists@specialists_ref`, runs `npm pack` **in the source tree**, installs `xtrm-tools.tgz` + `specialists.tgz` globally, runs `xt init -y`/`xt update`/`sp init/doctor/list`; asserts 3 skills, no symlinks, no "Source and destination must not be the same" | Core | Core | install **published** frozen tarballs by version+integrity; keep the 3 assertions | `fresh-machine-smoke.yml` (`Prepare specialists tarball`, `Validate release-contract assertions`) | ADAPT | published Specialists + Substrate artifacts | before publish | repeatable from registry, not from a source checkout | source checkout can carry uncommitted/unpublished dist drift | changes what the smoke proves | VERIFIED |
| `install-order-matrix.yml` | `workflow_dispatch`-only 4-leg install-order regression; documented as not release-gating | Core | Core | keep advisory | `docs/release.md` (`install-order-matrix scope clarification`); workflow | KEEP | third-party (`@beads/bd`, `oh-pi`, …) | manual | 4 legs green | non-deterministic third-party postinstalls | none | VERIFIED |
| `docs/runtime-compatibility.json` `core.requires` | `{specialists: ">=3.21.0 <4", xtmux: ">=0.1.0 <0.3", node: ">=24.0.0"}`; shipped in `files[]` | Core | Core | **Mechanism (a): the operator-facing compatibility RANGE** | `docs/runtime-compatibility.json:10-17`; `package.json:22` | ADAPT | none | bump with the release PR that requires it | file present in packed artifact; `check-runtime-compat` passes | range is a hand-maintained string; no cross-check against the validated artifact (§F-3) | edits the operator contract | VERIFIED |
| `scripts/check-runtime-compatibility.mjs` | Validates shape, `schema_version`, presence of the three keys, `node` vs `engines.node`, and schema-id regex. **Does not validate the specialists/xtmux range strings.** | Core | Core | add range-shape validation + a link to the frozen artifact | `scripts/check-runtime-compatibility.mjs:25-76` | ADAPT | none | CI + prepublish | any malformed range fails the gate | currently `core.requires.specialists = "potato"` passes | low | VERIFIED |
| `cli/src/core/runtime-compat.ts` + launch site | Comparator for space-separated comparators; `resolveInstalledVersion` walks PATH→package.json; `checkRuntimeCompatibility` skips absent siblings; `runtimeCompatibilityError` honors `XTRM_SKIP_RUNTIME_COMPAT`; called once at `launchWorktreeSession` before worktree creation | Core | Core | **Mechanism (a) enforcement**; consider adding `substrate` to `SIBLINGS` | `cli/src/core/runtime-compat.ts:41-44,136-174`; `cli/src/utils/worktree-session.ts:2534-2553` | ADAPT | Specialists/xtmux installs | at launch only | unit tests `runtime-compat.test.ts:53-130`; launch fails before worktree | `xt update`/`xt doctor` deliberately ungated (repair path) | fail-closed only for interactive launch | VERIFIED |
| `packages/contracts/schemas/xtrm.runtime-compatibility.v1.json` | Schema for the contract file | Core | Core | **Mechanism (a) schema**; extend if suite identity is added | `packages/contracts/schemas/xtrm.runtime-compatibility.v1.json`; `docs/runtime-compatibility.json:26` | KEEP | none | with (a) changes | shape validation in `check-runtime-compatibility.mjs` | none | none | VERIFIED |
| `.xtrm/specialists-source.json` | v2 manifest: `source {kind:'ref', ref:'master', resolved_sha:'5d2f2907…', repo_path:'../specialists', source_path:'config/skills'}` + per-file git-blob SHAs + placements | Core | Core | **Mechanism (c): vendored source/skill identity pin** | `.xtrm/specialists-source.json`; `scripts/verify-specialists-vendor.mjs:53-75` | KEEP | Specialists repo | before vendoring | blob SHAs match mirror | `ref` is human-readable and `resolved_sha` authoritative; code now prefers `resolved_sha` | `resolved_sha` is 242 commits behind `origin/master` (§7) | VERIFIED |
| `scripts/vendor-specialists-from-manifest.mjs` + `vendor-specialists-skills.mjs` | Prefer immutable `resolved_sha` over `ref`; record the concrete checkout; restore operator-facing `ref`/`repo_path` | Core | Core | keep | `vendor-specialists-from-manifest.mjs:1-52`; `vendor-specialists-skills.mjs:1-120` | KEEP | Specialists repo | at vendor time | `check:specialists-vendor` green | CI `SPECIALISTS_REPO_PATH` temp path can leak into regenerated `registry.json` (§F-8) | none | VERIFIED |
| `scripts/verify-specialists-vendor.mjs` | Fails unless manifest v2 / digest `git-blob-sha1` / every vendored file's blob matches the manifest | Core | Core | keep | `verify-specialists-vendor.mjs:53-75` | KEEP | none | CI + publish | pass/fail per file | none | none | VERIFIED |
| `scripts/check-vendored-specialists-skill-parity.mjs` | Compares vendored bytes to `git rev-parse ${resolved_sha}:${source_path}/…`; **exits 0 with `SKIP` when no Specialists checkout is found** | Core | Core | keep, but make the skip explicit/CI-visible | `check-vendored-specialists-skill-parity.mjs:24-31`; `package.json:81`; `ci.yml` "Vendored Specialists skill parity guard" (no `SPECIALISTS_REPO_PATH`) | ADAPT | Specialists checkout | CI + publish | parity runs in CI, not only publish | in PR CI this is a silent no-op unless `../specialists` exists | none | VERIFIED |
| `scripts/gen-registry.mjs` → `.xtrm/registry.json` | Rebuilds per-file sha256 + `version: <root pkg version>` and embeds the **whole** `.xtrm/specialists-source.json` under `specialists_source` | Core | Core | keep, but do not embed a machine-local `repo_path` in the published artifact | `gen-registry.mjs:44-52,145,153-158`; `.xtrm/registry.json:993-1000` | ADAPT | none | prepublish | parity check passes | packed `specialists_source.repo_path` observed as `../../../../../../tmp/sp-pin-0253e3e4` | published artifact carries a CI temp path; also packed registry ≠ committed registry | VERIFIED |
| `scripts/check-registry-pack-parity.mjs` | Registry ↔ `npm pack --dry-run` file-set parity for managed roots (`.xtrm/config`, `.xtrm/hooks`, `.xtrm/skills/default`, `.xtrm/skills/optional`); explicit allowlist incl. retired beads hooks | Core | Core | keep | `check-registry-pack-parity.mjs:18-53,97-136`; `cli/test/registry-pack-parity.test.ts:34-80` | KEEP | none | CI + prepublish | counts + probe test | allowlist is exact-path (tested no-glob) | none | VERIFIED |
| `.xtrm/skills/default/**`, `.xtrm/skills/optional/**` | 11 default skill dirs, 10 optional packs; vendored from Specialists at `5d2f2907` | Core | Core | **Mechanism (c) payload** | `ls .xtrm/skills/default .xtrm/skills/optional`; `.xtrm/specialists-source.json` | KEEP | Specialists repo | vendoring | `check:specialists-vendor` + parity | staleness vs live master | shipping stale skills | VERIFIED |
| `cli/src/core/dependency-maintenance.ts` | TOOLS = `sb` (`@xtrm/substrate`) and `gitnexus`; `sb` latest lookup deliberately skipped because the name is unpublished; upgrade for `sb` returns `failed` with "not published to npm" | Core | Core | point at the published name; report `sb` version against a declared range | `dependency-maintenance.ts:30-33,83-85,106-111` | REPLACE | `@jaggerxtrm/substrate` on npm | with (a) `substrate` range | `xt doctor` reports substrate current/outdated correctly | package rename must land before a range can be enforced | currently reports `sb` as unpublishable — stale since 0.1.2 shipped 2026-09-12 | VERIFIED |
| `cli/src/utils/npm-latest.ts` | `XTRM_PACKAGES = ['xtrm-tools','@jaggerxtrm/xtmux','@jaggerxtrm/specialists']`; npm-latest with 24h cache; `@latest` equality only, no range | Core | Core | **Mechanism (a) informational advisor**; add substrate; optionally compare to `core.requires` ranges | `npm-latest.ts:9-13,106-110,166-182`; `cli/src/tests/npm-latest.test.ts` | ADAPT | npm | — | `xt version --check-updates`, `xt doctor` rows | equal-version comparison hides an installed version outside the range | none | VERIFIED |
| `cli/src/core/substrate.ts` | Documented `sb` contract (`--version`, envelope `substrate-cli/v1`, `doctor --json`, `project`, `import beads`, `integrations/setup.ts` `check`/`plan`); verified against live `sb 0.1.0` (@xtrm/substrate, xtrm PRs #163/#168); never asserts a version minimum | Core | Core | add a minimum-version precondition at the consumer boundary | `substrate.ts:1-41,75-113,290-330` | ADAPT | Substrate CLI contract | before any `sb` mutation | envelope/`doctor` fail-closed checks | contract documented against `0.1.0`; no guard against a future incompatible envelope | none | VERIFIED |
| `scripts/install-update-ux-smoke.mjs` | Installs the candidate tarball into a temp HOME, asserts help, retired-token failure, ownership-safe clean, packaged Pi resolver, global prompt sync, redaction | Core | Core | keep | `install-update-ux-smoke.mjs:41-198` | KEEP | none | publish gate | `assert` failures abort | none | none | VERIFIED |
| `scripts/smoke-container/` | Docker global-surface smoke; defaults `TAG=latest`; `--branch <repo>=<ref>` packs unpublished refs | Core | Core | keep; consider making branch/tag mandatory pre-release | `docs/release.md` ("Global-surface smoke container"); `scripts/smoke-container/verify.sh:18,475-477` | ADAPT | core/specialists/xtmux repos | before + after publish | exit 0 | a bare pre-release run tests the already-published release | operator error risk | VERIFIED |
| `scripts/verify-asset-contract.mjs` | sha256 of shipped skills against Specialists `dist/asset-contract.json`; hard-named must-haves `using-specialists`, `update-specialists` | Core | Core | **Mechanism (b)/(c) cross-check** — ties vendored bytes to a Specialists build | `docs/release.md` §2; `publish.yml:96-97` | KEEP | Specialists `dist/asset-contract.json` | publish gate | sha256 match | contract is consumed from the source checkout, not a registry artifact | none | VERIFIED |
| Tests (release/compat/registry/pi-parity/npm-latest) | `release.test.ts` = scope/tag/template helpers; `runtime-compat.test.ts` = comparator + install resolution (hardcodes its own `REQUIRES`, including xtmux `<0.2` vs the contract's `<0.3`); `registry-pack-parity.test.ts` = allowlist + probe; `pi-packages-parity.test.ts` = 3-surface parity; `npm-latest.test.ts` = cache/classify | Core | Core | assert contract **values**, not only mechanics | `cli/src/tests/release.test.ts:1-76`; `runtime-compat.test.ts:13,40-86`; `cli/test/registry-pack-parity.test.ts`; `cli/test/pi-packages-parity.test.ts`; `cli/src/tests/npm-latest.test.ts` | ADAPT | none | CI | tests green; contract drift caught | no test fails when `docs/runtime-compatibility.json` changes to a nonsense range | none | VERIFIED |
| `docs/release.md` | "single source of truth"; rules 1–12; "Resolved (was deferred)"; gate table; known issues | Core | Core | update to describe the three mechanisms and the frozen-release path | `docs/release.md` | ADAPT | none | with mechanism changes | doc matches workflows | doc already says workflow file wins on conflict | none | VERIFIED |
| `.xtrm/registry.json` version stamp | Every entry carries `version: <root pkg version>`; committed registry at tag `v0.12.0` carries `0.11.4` while root is `0.12.0`; packed registry carries `0.12.0` | Core | Core | keep stamp; accept that the packed registry is generated, not committed | tarball `package/.xtrm/registry.json` diff vs `git show v0.12.0:.xtrm/registry.json` (non-version diff lines = 20, all specialists-source + 6 skill hashes) | ADAPT | none | prepublish | `check:registry-pack-parity` green | the committed registry is not byte-identical to the shipped one | low | VERIFIED |

### Action counts

| Action | Count |
|---|---|
| KEEP | 13 |
| ADAPT | 21 |
| DELETE | 0 |
| REPLACE | 1 |
| COMPAT | 0 |
| **Total rows** | **35** |

---

## 1. `.xtrm/specialists-source.json` — what it pins, who writes/reads it, identity vs baseline

**VERIFIED structure** (`.xtrm/specialists-source.json`):

```json
{ "version": 2, "digest": "git-blob-sha1",
  "source": { "kind": "ref", "ref": "master",
              "resolved_sha": "5d2f2907f49877f6c4dcf32de95e8cb945c067c7",
              "repo_path": "../specialists", "source_path": "config/skills" },
  "skills": ["update-specialists","using-specialists"],
  "placements": { … },
  "files": { "<skill>": { "<relpath>": "<git-blob-sha1>", … } } }
```

**What it pins.** The exact **git blob SHA-1** of every vendored file, plus the Specialists commit
(`resolved_sha`) those blobs came from. It pins *content identity at one commit* — not a version
range and not an npm version. At the workspace baseline it pins `5d2f2907` (authored
2026-09-06, "Merge pull request #283 … skills-v4-runtime-doctrine"). `ref: master` is retained only
as human-readable provenance; every executable reader prefers `resolved_sha`:
`vendor-specialists-from-manifest.mjs:19` (`manifest.source?.resolved_sha || originalRef`),
`publish.yml:24-26` (`sha="${resolved_sha}"; resolved="${sha:-$ref}"`),
`pre-publish-readiness.yml` (same), `check-vendored-specialists-skill-parity.mjs:18-19`.

**Who writes it.** `scripts/vendor-specialists-skills.mjs` (invoked by
`vendor-specialists-from-manifest.mjs`) writes/updates it at vendor time. It records the concrete
checkout HEAD as `resolved_sha` and then restores the operator-facing `ref`/`repo_path`
(`vendor-specialists-from-manifest.mjs:35-52`). No CI job writes it; CI **reads** it and fails if the
mirror or the committed manifest drifted (`ci.yml` "Verify specialists vendor and package registry
freshness" runs `git diff --exit-code -- .xtrm/skills/default .xtrm/skills/optional
.xtrm/specialists-source.json .xtrm/registry.json`).

**Who reads it.** `scripts/verify-specialists-vendor.mjs` (local mirror ⇔ manifest), 
`scripts/check-vendored-specialists-skill-parity.mjs` (mirror ⇔ upstream git at `resolved_sha`),
`scripts/gen-registry.mjs:44-52,153-158` (embeds the entire manifest into `.xtrm/registry.json` under
`specialists_source`), `publish.yml` + `pre-publish-readiness.yml` (`resolve_ref`), and
`scripts/vendor-specialists-from-manifest.mjs`.

**Identity check or compatibility baseline?** It is an **identity check** (exact per-file content
pin / reproducibility), *not* a compatibility baseline. This is the opposite of the Specialists
catalog pin. Evidence from upstream commit `a5635b96`
("catalog pins are compatibility baselines, not identity checks", PR #353): a catalog's `version` is
"the build its tool surface was verified against, but three call sites compared it with `!==` and
treated any difference as incompatible"; the fix replaced `!==` with a **caret-of-baseline**
comparator (`resolveCatalogVersionVerdict` in `src/specialist/tool-catalog.ts`: same major for
1.x+, same minor for 0.x.y, exact for 0.0.x, prerelease/unparseable fails closed). Commit `081522d7`
(PR #355) then added `describeCatalogCompatibility()` with levels `ok|ahead|out_of_range|absent`,
surfaced in `sp doctor` "Extension catalogs"; `ahead` is informational (still compatible) and only
`out_of_range` fails. So there are **two distinct upstream mechanisms**:
- catalog `version` pins = **compatibility baselines** (ranges via caret-of-baseline), and
- `.xtrm/specialists-source.json` = **byte-exact identity pins**.
Do not use either for the other job (see §4). Note also that `@/tmp/audit/specialists-master` is a
filesystem snapshot without `.git`; upstream history claims were verified against
`/home/dawid/dev/specialists` (which does contain both commits).

---

## 2. Frozen Substrate + frozen Specialists releases: what the Core release/smoke path must change

Numbers/versions below are EVIDENCE, not assumptions. Observed today:

- Specialists is consumed as a **git SHA** (`.xtrm/specialists-source.json.resolved_sha`,
  `publish.yml` checkout + `npm pack` from the source tree). There is **no** Specialists npm version
  declared anywhere in Core. The only exact Specialists-version statement is prose in
  `changelog/release-notes/v0.12.0.md:5`: "Coordinated release counterpart to `Specialists 3.21.6`
  (`@jaggerxtrm/specialists@3.21.6`, tag `v3.21.6`). Install with matching versions for project-pack
  resolution parity."
- Substrate is **not in the release path at all** — no npm dependency, no pin, no smoke install, no
  `core.requires` entry, no `npm-latest` entry.

**Required change set (RECOMMENDATION; each row is in table B):**

1. Add a published-version **selection step** to `resolve_ref` so the release job resolves
   `@jaggerxtrm/specialists@<exact>` + `@jaggerxtrm/substrate@<exact>` + `@jaggerxtrm/xtmux@<exact>`
   from the registry (version + `dist.integrity`), and record it as a release artifact.
2. Change `fresh-machine-smoke.yml` to install those **registry tarballs** rather than `npm pack`
   from a source checkout, so the smoke proves the frozen artifact, not a branch.
3. Add a `substrate` entry to `docs/runtime-compatibility.json` `core.requires` and to
   `runtime-compat.ts` `SIBLINGS`, then enforce it at the `sb` boundary in `cli/src/core/substrate.ts`.
4. Keep `.xtrm/specialists-source.json` as mechanism (c) — the smoke's vendored-skills assertions
   must remain tied to the same Specialists build that produced `dist/asset-contract.json`
   (`verify-asset-contract.mjs`).
5. Fix the package-name seam (`@xtrm/substrate` → `@jaggerxtrm/substrate`) in
   `dependency-maintenance.ts` and `substrate.ts` before any range can be enforced.
6. Add Substrate + Specialists to `XTRM_PACKAGES` (`npm-latest.ts`) so `xt doctor`/`xt version
   --check-updates` can report a frozen-release drift.

**Clean-install behaviour today.** `xt init -y` and `xt update --apply` install/resolve Specialists
and Substrate as external global packages; the compatibility preflight is **not** run during
install/init/update (deliberate, so a drifted install stays repairable — `runtime-compat.ts:10-13`,
`docs/runtime-compatibility.json:6`). INFERENCE: a clean install can land a Substrate/Specialists
outside the intended window and the first signal is a refused `xt claude`/`xt pi` launch.

**Upgrade behaviour today.** `runDependencyMaintenance` (`dependency-maintenance.ts:152-160`) reports
`sb` and `gitnexus` and will `npm install -g <pkg>` for `gitnexus`; for `sb` it returns `failed` with
"not published to npm" because it still looks up `@xtrm/substrate` (E404). It never upgrades
Specialists. `xt update --apply` is the documented refresh path for the Core-managed surface, not for
the sibling runtimes.

---

## 3. (C) Proposed compatibility contract — DESIGN ONLY

Three mechanisms, three artifacts. Do not collapse them.

### (a) Compatibility RANGE expressed to operators

| Field | Value |
|---|---|
| Artifact | `docs/runtime-compatibility.json` → `core.requires.{specialists,xtmux,substrate,node}` (shipped in root `package.json` `files[]`) |
| What it is | A *window*, e.g. the current `specialists >=3.21.0 <4`, `xtmux >=0.1.0 <0.3`, `node >=24.0.0`, plus a new `substrate` entry |
| Owner | Core |
| Written by | Hand-edited in the release PR that first requires the minimum (`docs/runtime-compatibility.json:8`) |
| Read/enforced by | `scripts/check-runtime-compatibility.mjs` (build-time shape, node cross-check) and `cli/src/core/runtime-compat.ts` + `cli/src/utils/worktree-session.ts:2534-2553` (launch preflight); optionally `npm-latest.ts`/`xt doctor` for advisory rows |
| Operator-facing statement | "Core 0.12.x supports Specialists ≥3.21.0 <4, xtmux ≥0.1.0 <0.3, Substrate ≥X.Y.Z <X+1" |
| Must NOT be | used as the exact validation artifact; the range is intentionally wider than the validated pair |

**UNRESOLVED (a):** the live release work does not select a Substrate window. The current matrix has
no substrate row, and Substrate main is `0.1.2` with unreleased work. The correct range for the next
Core release cannot be derived from Core's source (`e3c09927`) — it depends on which Substrate release
ships first. Exact question in §6.

### (b) EXACT artifact used for release validation

| Field | Value |
|---|---|
| Artifact | A dedicated release-validation record. Proposed: `.xtrm/release-pins.json` (new, committed at tag time) capturing `{specialists:{version,integrity,sha}, substrate:{…}, xtmux:{…}, node, specialists_source_sha, asset_contract_sha256}` |
| Current *de facto* equivalent | scattered: prose in `changelog/release-notes/v0.12.0.md:5,42` (Specialists 3.21.6 / project-pack parity), `.xtrm/specialists-source.json.resolved_sha` (git SHA), `dist/asset-contract.json` sha256 checked by `verify-asset-contract.mjs` |
| Owner | Core release process |
| Written by | the release job at tag time; recorded into the GitHub Release body and `GITHUB_STEP_SUMMARY` (publish.yml already records `specialists_ref`/`specialists_sha`, `publish.yml:58-65`) |
| Read/enforced by | `fresh-machine-smoke.yml` (must install these exact versions from the registry), `pre-publish-readiness.yml` (same), and an advisory `xt doctor` row |
| Must NOT be | a range, and must not be the Specialists `master` ref |

RECOMMENDATION: mechanism (b) is the only place an exact Specialists/Substrate version may appear.
The observed `changelog/release-notes/v0.12.0.md` statement is exactly this mechanism, but it is prose
and unenforced.

### (c) Vendored skill/source pins

| Field | Value |
|---|---|
| Artifact | `.xtrm/specialists-source.json` (v2, `digest: git-blob-sha1`) + the vendored bytes under `.xtrm/skills/default/**`, `.xtrm/skills/optional/**`, mirrored into `.xtrm/registry.json.specialists_source` |
| What it is | A byte-exact content identity pin at one Specialists commit (`resolved_sha`) |
| Owner | Core vendoring (`vendor-specialists-from-manifest.mjs`) |
| Read/enforced by | `check:specialists-vendor`, `check:vendored-specialists-parity`, `check:registry-pack-parity`, `verify-asset-contract.mjs` (publish gates) |
| Must NOT be | treated as a compatibility statement. A different `resolved_sha` is a vendoring event, not an incompatibility; and an in-range Specialists install is compatible even when its SHA differs |

**Fourth, upstream-owned mechanism (not Core's to design):** Specialists **catalog `version` pins**
are compatibility *baselines* (caret-of-baseline; `a5635b96`, `081522d7`), enforced by the Specialists
runtime gate and reported by `sp doctor`. Core must not re-implement or duplicate this comparator;
Core's `runtime-compat.ts` comparator is intentionally the same *shape* (space-separated
comparators) but is a distinct code path with a distinct job.

---

## 4. Fail-open and hard-fail inventory

### Fail-open (Core silently accepts a mismatched or absent Substrate/Specialists)

| ID | Surface | Behaviour | Evidence |
|---|---|---|---|
| F-1 | Substrate version | **No declared range, no check, anywhere.** Core shells to `sb` and consumes its contract without asserting any version. A `sb` of any version (or the wrong package) is accepted. | `docs/runtime-compatibility.json` (no substrate key); `runtime-compat.ts:41-44` (`SIBLINGS` = specialists, xtmux only); `substrate.ts:9-41` (documented vs `0.1.0`, never enforced) |
| F-2 | Absent sibling | `checkRuntimeCompatibility` `continue`s on `null`; `resolveInstalledVersion` returns `null` when the binary is off PATH or its package.json is unreadable; docs say absence is never an incompatibility | `runtime-compat.ts:102-133,142`; `docs/runtime-compatibility.json:7` |
| F-3 | Unreadable/malformed contract | `loadRuntimeRequirements` returns `null` on any `existsSync` miss or parse error → *no check at all*, silently | `runtime-compat.ts:76-94` |
| F-4 | Operator override | `XTRM_SKIP_RUNTIME_COMPAT=1` short-circuits the only enforcement point | `runtime-compat.ts:163`; `worktree-session.ts:2550` |
| F-5 | Enforcement scope | Compatibility is checked **only** at interactive worktree launch. `xt init`, `xt update`, `xt doctor`, `xt spec apply`, `sp` dispatch from Core, and every non-interactive path are unchecked | `worktree-session.ts:2534` is the sole production call site; `grep runtimeCompatibilityError cli/src` shows only this + tests |
| F-6 | Range-string validation | `check-runtime-compatibility.mjs` never validates the `specialists`/`xtmux` range strings, so an unparseable or nonsensical range ships and is then either always-true or always-false at launch | `check-runtime-compatibility.mjs:40-57` (validates presence and `node` cross-check only) |
| F-7 | Vendored-parity in PR CI | `check-vendored-specialists-skill-parity.mjs` prints `SKIP` and exits 0 when no Specialists checkout is on the fallback paths; `ci.yml` runs it without `SPECIALISTS_REPO_PATH`. In PR CI this gate is a no-op unless `../specialists` happens to exist locally. | `check-vendored-specialists-skill-parity.mjs:24-31`; `ci.yml` "Vendored Specialists skill parity guard" |
| F-8 | Published-artifact reproducibility | `prepublishOnly` re-vendors and re-generates `.xtrm/registry.json` at publish time. The packed registry is **not** the committed registry, and it embeds `specialists_source.repo_path` from the CI checkout — observed as `../../../../../../tmp/sp-pin-0253e3e4`. A machine-specific path ships inside the published tarball. | `package.json:82`; tarball `package/.xtrm/registry.json` vs `git show v0.12.0:.xtrm/registry.json` (20 non-version diff lines); `gen-registry.mjs:44-52,153-158` |
| F-9 | Artifact ↔ release identity | `xtrm-tools@0.12.0` has **no `gitHead`** on npm, and no provenance attestation was retrievable (`registry.npmjs.org/-/npm/v1/attestations/xtrm-tools@0.12.0` → `{"error":"Not found"}`; `dist.attestations` absent). Nothing in the registry pins the artifact to a commit; commit correspondence must be reconstructed from tags + content hashes. | `npm view xtrm-tools@0.12.0 --json` (`gitHead: None`); attestation endpoint |
| F-10 | Substrate "unpublished" assumption | `dependency-maintenance.ts` still treats the package as unpublished and skips its latest lookup; `substrate.ts` resolves `@xtrm/substrate` under `npm root -g` / `node_modules/@xtrm`. The published name is `@jaggerxtrm/substrate`. So the installed-Substrate resolver fails open (returns undefined) and the maintenance row reports `failed`/`skipped` on a healthy install. | `dependency-maintenance.ts:83-85,106-111`; `substrate.ts:318-366`; `npm view @jaggerxtrm/substrate` = 0.1.2; `npm view @xtrm/substrate` = E404 |
| F-11 | `@xtrm/contracts` | Declares `publishConfig.access=public` but has no release step and is not on npm. A future external consumer of the `^0.11.1` range gets a workspace-only package. | `packages/contracts/package.json:6-8`; `cli/package.json:56`; npm E404 |

### Hard-fail today

| ID | Surface | Behaviour | Evidence |
|---|---|---|---|
| H-1 | Out-of-range Specialists/xtmux at interactive launch | `xt claude`/`xt pi` print the violation list and `process.exit(1)` **before** any worktree/branch/tmux is created | `runtime-compat.ts:136-156,162-174`; `worktree-session.ts:2534-2553` |
| H-2 | Out-of-range Node at interactive launch | Same rejection (parser handles `v24.15.0`) | `runtime-compat.ts:147-149`; `runtime-compat.test.ts:83-85` |
| H-3 | Build-time contract shape | Missing file / wrong `schema_version` / missing `core.requires.{specialists,xtmux,node}` / `node` ≠ `engines.node` / malformed contract id → `check-runtime-compatibility.mjs` exits 1 | `check-runtime-compatibility.mjs:26-76` |
| H-4 | Vendored mirror drift | File-set or blob mismatch → `verify-specialists-vendor.mjs` exits 1; `check-vendored-specialists-skill-parity.mjs` exits 1 when a checkout exists and bytes differ | `verify-specialists-vendor.mjs:68-71`; `check-vendored-specialists-skill-parity.mjs:74-80` |
| H-5 | Registry ↔ pack drift | A managed pack file absent from the registry (or vice versa, minus exact-path allowlist) exits 1 | `check-registry-pack-parity.mjs:109-128` |
| H-6 | Publish gate chain | `prepublishOnly` / `publish.yml` run the same gates; a failure blocks `npm publish` | `package.json:82`; `publish.yml:40-119` |
| H-7 | Asset contract | sha256 drift on a shipped skill, or a missing must-have (`using-specialists`, `update-specialists`) fails the publish gate | `publish.yml:96-97`; `docs/release.md` §2, §4 |
| H-8 | Specialists runtime catalog gate (upstream) | An installed extension outside a catalog pin's compatibility line makes that catalog's tools unavailable (fail-closed, with a named reason) | Specialists `src/specialist/tool-catalog.ts` `resolveCatalogVersionVerdict`; commits `a5635b96`, `081522d7` |
| H-9 | Substrate `--json` contract (consumer side) | `getSbDoctorJson`/`runSetupCheck`/`runSetupPlan` fail closed on non-zero exit, unparseable JSON, `ok !== true`, or a missing/short `enrollment[]` | `substrate.ts:153-172,414-449,458-480` |

---

## 5. Does the published `xtrm-tools@0.12.0` correspond exactly to main `e3c09927`?

**Verdict: NO. The published artifact corresponds to tag `v0.12.0` (= commit
`04c1867bd2055065f2f7951b444b4321f85cdd5e`), which is 236 commits behind main `e3c09927`.**
Confidence: **VERIFIED** (byte-level content comparison + ancestry), with one known
non-reproducible file.

Evidence:

| Check | Result |
|---|---|
| `git merge-base --is-ancestor v0.12.0 e3c09927` | true (tag is an ancestor of main) |
| `git rev-list --count v0.12.0..e3c09927` | `236` |
| `git describe e3c09927` | `v0.12.0-236-ge3c09927` |
| `git rev-list -n1 v0.12.0` | `04c1867…`; tagger date Fri Sep 4 13:06:02 2026 +0200; tag type `tag` (annotated) |
| npm publish time | `xtrm-tools@0.12.0` 2026-09-04T14:46:02.955Z; `@jaggerxtrm/pi-extensions@0.12.0` 2026-09-04T14:48:15.408Z — same release event, ~4h after the tag |
| **Content hash**: tarball `cli/dist/index.cjs` sha256 | `5c3248e9c04b46f163567c4edad529420e53fed85574bf45e6a5cc2ceac13300` = tag `v0.12.0` (`git show v0.12.0:cli/dist/index.cjs`); ≠ main `e3c09927` (`7ed1e644…`) |
| **Content hash**: tarball `packages/pi-extensions/src/index.ts` | matches both tag and main (file unchanged across the 236 commits) |
| Git tags at/after `0.12.0` | `git tag --sort=-v:refname` → `v0.12.0` is the newest; no post-0.12.0 tag |
| npm versions after `0.12.0` | none (`time` last entry `0.12.0`) |
| CHANGELOG at main | `## [Unreleased]` empty; top released section `## [0.12.0] - 2026-09-04` |
| `cli/package.json` version at tag and at main | both `0.12.0` (no bump on the 236 unreleased commits) |
| `gitHead` on npm | absent → no registry-side commit pin (see F-9) |

Caveat (VERIFIED, small): the tarball's `.xtrm/registry.json` is **not** byte-identical to
`git show v0.12.0:.xtrm/registry.json`. The diff is 1322 lines, of which 1320 are the per-entry
`version` field (`0.12.0` vs the committed `0.11.4`) and **20** are specialists-source metadata plus 6
skill hashes — because `prepublishOnly` runs `vendor-specialists-from-manifest.mjs` and
`gen-registry.mjs`, regenerating the registry in the working tree before packing
(`package.json:82`; `gen-registry.mjs:145,153-158`). So the shipped **code** is exactly tag
`v0.12.0`; the shipped **registry manifest** is a build-time regeneration of it. The published
artifact corresponds to `v0.12.0`; it does not correspond to main `e3c09927`.

---

## 6. UNRESOLVED items (exact questions)

1. **What Substrate window should the next Core release declare?** Live Core source contains no
   substrate range. Substrate main is `0.1.2` with unreleased work under the same version string.
   Decide: `substrate >=0.1.2 <0.2`? Or wait for the next Substrate release and set the floor to it?
   Owner: release operator + Substrate maintainer.
2. **Which exact Specialists release is the validated pair for the next Core release?** Today only
   `changelog/release-notes/v0.12.0.md:5` names `3.21.6`. Upstream `origin/master` is 293 commits past
   `v3.21.6` at version `3.21.6`. Is the next pair `3.21.6` again, or a new `3.21.x`/`4.0.0`?
3. **Does Specialists intend a 4.0.0 boundary?** `docs/runtime-compatibility.json` currently excludes
   `>=4`; the CHANGELOG has no 4.0 / breaking-change marker (grep found only unrelated `4.0.0` skill
   versions). Core cannot derive the intent; it needs an upstream statement.
4. **Should the vendored mirror move off `5d2f2907`?** It is 242 commits behind the live
   `origin/master` tip; four upstream commits since it explicitly touch catalog trust and
   service-knowledge pinning. Is a re-vendor part of the next release, or is the frozen mirror
   intentional?
5. **Should `@xtrm/contracts` be published, or have its `publishConfig.access` removed?** It is
   currently a public-shaped, unpublished workspace package referenced by a `^0.11.1` range.
6. **Is the release-validation artifact to be created as `.xtrm/release-pins.json`, or is a
   `devDependencies` exact pin + provenance record sufficient?** This is a design choice for the
   operator; this lane recommends the dedicated committed file because the existing statements are
   prose-only.

---

## 7. Upstream release/versioning posture (Task 7)

### Specialists (`xtrm-dev/specialists`)

| Fact | Value | Evidence |
|---|---|---|
| `origin/master` | `31887a4e55d25a57b90f06feef580ae148e29e9d` ("refactor(SPECIALISTS-49): remove dead Beads coupling…", PR #361) | `git rev-parse origin/master`; `git log --oneline -2` |
| `package.json` version on master | `3.21.6` | `git show 31887a4e:package.json` |
| Latest tag / npm | `v3.21.6` (tag 2026-09-03); npm latest `3.21.6` (2026-09-03T15:38:18Z) | `git log -1 v3.21.6`; `npm view @jaggerxtrm/specialists time` |
| Commits master past `v3.21.6` | `293` | `git rev-list --count v3.21.6..origin/master` |
| CHANGELOG top | `## [Unreleased]` with Added/Fixed/Other/Project-maintenance groups; no 4.0 marker | `CHANGELOG.md` head |
| `release-attestation.json` (at `3.21.6`) | `attestation_status: "candidate_template"`, `source_commit`/`git_head`/`sha256` = `"not-generated"`, `publication_authorized: false`; `host_read_isolation.provided: false` with an approved bounded waiver expiring on release `3.21.7` or 2026-10-03 | `/tmp/audit/specialists-master/release-attestation.json` |
| Boundary inferred | The document is a **candidate template**, not a publication proof. The next boundary is at minimum a `3.21.7` (waiver expiry) and plausibly a large `3.21.x`/minor step given 293 unreleased commits. **INFERRED.** | — |
| npm `gitHead` for `3.21.6` | absent | `npm view @jaggerxtrm/specialists@3.21.6 gitHead` (empty) |

### Substrate (`xtrm-dev/xtrm`, `packages/substrate`)

| Fact | Value | Evidence |
|---|---|---|
| `origin/main` | `12e71d743a32c7b27af6c3e792574cfa08e7b81a` | `git rev-parse origin/main` |
| `packages/substrate/package.json` version | `0.1.2` | `/tmp/audit/xtrm-main/packages/substrate/package.json` |
| Published | `@jaggerxtrm/substrate` `0.1.0`→`0.1.2` on 2026-09-12; latest `0.1.2`; `gitHead` = `27d2a32e24ddbd6f09a1555af22eedc375862673` | `npm view @jaggerxtrm/substrate versions dist-tags time gitHead` |
| Contract stated in code | `substrate-cli/v1` envelope, `cli/schema.json` version `1.0.0`, described as **additive-only compat**; README "Issues v0" | `packages/substrate/README.md` |
| Boundary inferred | 0.x line with an additive-only CLI contract; the next plausible boundary is `0.2.0` for any non-additive change. **INFERRED; no scheduled boundary found.** | — |

### Core / xtmux

| Fact | Value | Evidence |
|---|---|---|
| Core latest release | `v0.12.0` / npm `0.12.0`; main 236 commits ahead with the same version string | §5 |
| xtmux latest | `0.2.5` (2026-08-22); contract window `>=0.1.0 <0.3`; npm `gitHead` `83e12521…` | `npm view @jaggerxtrm/xtmux` |

---

## 8. Surfaces searched

- Manifests: `package.json` (root), `cli/package.json`, `packages/pi-extensions/package.json`,
  `packages/contracts/package.json`, `packages/contracts/schemas/xtrm.runtime-compatibility.v1.json`,
  `.xtrm/registry.json`, `.xtrm/specialists-source.json`, `docs/skills-ownership.json`.
- Release scripts: `scripts/{check-runtime-compatibility,gen-registry,check-registry-pack-parity,
  check-payload-hygiene,sync-cli-version,verify-specialists-vendor,vendor-specialists-from-manifest,
  vendor-specialists-skills,check-vendored-specialists-skill-parity,changelog-update,
  install-update-ux-smoke}.mjs`; `Makefile`; `cli/src/commands/release.ts`.
- Core code: `cli/src/core/{runtime-compat,substrate,dependency-maintenance,installer-manifest,
  manifest,pack-metadata}.ts`; `cli/src/utils/{npm-latest,worktree-session}.ts`; `cli/src/index.ts`.
- Workflows: `ci.yml`, `publish.yml`, `pre-publish-readiness.yml`, `fresh-machine-smoke.yml`,
  `install-order-matrix.yml` (directory listing of all 13 workflow files).
- Tests: `cli/src/tests/{release,runtime-compat,npm-latest}.test.ts`,
  `cli/test/{registry-pack-parity,pi-packages-parity,install-surface,install-pi}.test.ts`,
  `cli/src/tests/install-*.test.ts` (listing + targeted reads).
- Docs: `docs/release.md`, `CHANGELOG.md`, `changelog/release-notes/v0.12.0.md`.
- Upstream: `/home/dawid/dev/specialists` (`a5635b96`, `081522d7`, `src/specialist/tool-catalog.ts`,
  `config/catalog/*.json`, `CHANGELOG.md`, tags), `/tmp/audit/specialists-master`
  (`release-attestation.json`, `package.json`), `/tmp/audit/xtrm-main` (`packages/substrate/**`),
  `/tmp/audit/pub-012`.
- Registry/git: `npm view` (versions, dist-tags, time, gitHead, dist.integrity/attestations) for
  `xtrm-tools`, `@jaggerxtrm/{pi-extensions,specialists,substrate,xtmux}`, `@xtrm/{contracts,substrate}`;
  `gh release list`; `git tag/log/show/merge-base/rev-list/describe/for-each-ref`; streaming
  `tar -xzO` reads of the published tarballs.

## 9. Not inspected

- Actual byte content of the published `@jaggerxtrm/specialists@3.21.6` and
  `@jaggerxtrm/substrate@0.1.2` tarballs beyond their `package.json`/attestation (not needed for this
  lane's verdict; Substrate artifact unpacked at `/tmp/audit/pub-012` by another lane).
- Specialists CI workflows (`release-gate.yml`, catalog guard schedule) and its own release/publish
  automation; only the catalog-pin code path and the tracked `release-attestation.json` were read.
- Substrate's own release workflow and changelog (no `packages/substrate/CHANGELOG.md` exists in the
  snapshot).
- Non-release consumers of the registry (`xt init` scaffold path internals,
  `registry-scaffold.ts`) beyond its registry surface.
- `scripts/smoke-container/verify.sh` body (README + `docs/release.md` description only).
- The full `cli/dist/**` graph of every packed file; correspondence was proven on
  `cli/dist/index.cjs` (the shipped bin) plus `packages/pi-extensions/src/index.ts`.
