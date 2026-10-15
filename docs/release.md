---
title: Release Playbook
scope: release-contract
category: guide
version: 1.1.0
updated: 2026-07-16
description: How operators cut releases and how agents must touch release plumbing without breaking the contract.
domain: [release, ci, specialists, vendor]
updated_at: 2026-07-16
---

# Release Playbook

This document is the single source of truth for releasing `xtrm-tools` to npm. It covers both audiences:

- **Operators** (humans cutting a release): the procedure.
- **Agents** (specialists, Claude, anything that edits this repo): the rules for modifying release plumbing.

If the procedure here disagrees with a workflow file, the workflow file is authoritative — update this doc.

---

## 1. Architecture in one diagram

```
                ┌─────────────────────────────────────────────────────────┐
                │ specialists repo (Jaggerxtrm/specialists)               │
                │   • dist/asset-contract.json   ← sha256 manifest        │
                │   • .github/workflows/release-gate.yml                  │
                └────────────────────────┬────────────────────────────────┘
                                         │ repository_dispatch
                                         │ event_type = specialists-asset-validation
                                         │ client_payload { specialists_sha, tag, package_version }
                                         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ xtrm-tools repo (this one)                                              │
│                                                                         │
│  ┌─ CI / per-PR (.github/workflows/ci.yml) ─────────────────────────┐   │
│  │ build · test · skills-ownership · specialists-vendor · layout   │   │
│  │ guards · registry↔pack parity · policy parity                   │   │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─ specialists-validation.yml (dispatch + manual) ─────────────────┐   │
│  │ checkout specialists @ SHA → verify-asset-contract.mjs           │   │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─ publish.yml  (triggered by GitHub Release published) ───────────┐   │
│  │  resolve_ref (jq .source.ref .xtrm/specialists-source.json)      │   │
│  │       ↓                                                          │   │
│  │  fresh_machine_smoke  (uses ./.github/workflows/fresh-machine-…) │   │
│  │       ↓                                                          │   │
│  │  publish: 6 gates → npm publish --provenance                     │   │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─ operator-only ───────────────────────────────────────────────────┐  │
│  │ pre-publish-readiness.yml  (workflow_dispatch readiness summary) │  │
│  │ fresh-machine-smoke.yml    (workflow_dispatch + workflow_call)   │  │
│  │ install-order-matrix.yml   (workflow_dispatch — see xtrm-5k0o)   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. What the gates enforce

The npm tarball that ships to users must match the specialists package the project was built against. Every gate exists to prevent one specific kind of drift between specialists' source of truth and xtrm-tools' shipped payload.

| Gate | Source of truth | What drifts if absent |
|------|----------------|----------------------|
| `check:skills-ownership` | `docs/skills-ownership.json` | A skill is mirrored but not declared owned by specialists, or vice versa |
| `check:specialists-vendor` | `../specialists/config/skills` (or `$SPECIALISTS_REPO_PATH`) | The mirror under `.xtrm/skills/default/` diverges from upstream specialists |
| `check:layout-guards` | `.xtrm/skills/default/` flat layout invariants | A vendored skill nests into a sub-sub-folder or a stray non-skill file lands in the layout |
| `check:payload-hygiene` | `scripts/check-payload-hygiene.mjs` denylist | An `.env`, an absolute-path leak, a `.serena/`, or other forbidden artifact sneaks into the npm tarball |
| `check:registry-pack-parity` | `.xtrm/registry.json` vs `npm pack --dry-run` | The runtime registry claims a file the tarball doesn't ship, or vice versa |
| `verify-asset-contract.mjs` | specialists' `dist/asset-contract.json` (per-file sha256) | A skill in `.xtrm/skills/default/` has the right path but a stale content hash |
| `fresh-machine-smoke.yml` | live `npm install` + `xt init -y` + `sp init` end-to-end | A fresh user can't get to a working repo (PATH bug, missing prerequisite, broken bootstrap step) |

`verify-asset-contract.mjs` enforces sha256 only for `shipped_skills[]` entries owned-by-specialists (per `docs/skills-ownership.json`). The sole must-have skill is hard-named: `using-specialists` — its absence is a fail.

---

## 3. Operator: how to cut a release

### Pre-flight (recommended, not blocking)

```bash
# 1. Confirm specialists side has shipped the asset contract you expect.
#    From specialists repo: 'jq .package_version dist/asset-contract.json'

# 2. Operator-side readiness — runs payload hygiene + asset-contract
#    against current specialists master, prints a checklist.
gh workflow run pre-publish-readiness.yml -f specialists_ref=master

# 3. Heavy end-to-end smoke (~5 min). Packs both repos, runs
#    xt init / sp init / sp doctor in a fresh git repo.
gh workflow run fresh-machine-smoke.yml

# 4. Install-order regression matrix — 4 legs, operator-triggered only
#    until xtrm-5k0o is fixed (see Known issues).
gh workflow run install-order-matrix.yml
```

None of the above gate the release. They're confidence checks.

### Global-surface smoke container — run it, before AND after

`scripts/smoke-container/` is the gate for the surface the packages install into a user's HOME:
the `~/.claude/skills` and `~/.pi/agent/skills` pointers, per-event xtmux hook coverage in
`~/.claude/settings.json`, the SessionStart `--new-instance` argument, `~/.pi/agent/settings.json`
packages, and a drift-break-and-repair stage that breaks each pointer and asserts
`xt update --apply` restores it.

This is **not** `fresh-machine-smoke.yml`. That one is wired into `publish.yml` and gates the
bootstrap path — can a fresh user get to a working repo. It would not catch a hook wired without
its argument, a dangling skills pointer, or a duplicate hook entry. This container is what catches
those (beads `xtrm-wiy5n.4.25`, `.4.27`, `.4.32`).

Nothing runs it for you. It needs docker and a few minutes, so it is not in CI.

```bash
docker build -t xtrm-smoke scripts/smoke-container/

# BEFORE publishing — MUST name the candidate. `--branch <repo>=<ref>` packs each repo
# from that ref and installs it globally, so the run tests the code you are about to ship.
docker run --rm xtrm-smoke ./verify.sh --skip-live \
  --branch core=main --branch specialists=master --branch xtmux=main

# AFTER publishing — no --branch. Now `latest` IS the new release.
docker run --rm xtrm-smoke ./verify.sh --skip-live          # <-- this one must PASS
```

**Do not run the pre-release check without `--branch` (or `--tag next`).** `verify.sh` defaults
`TAG` to `latest` and installs the three *published* packages (`verify.sh:18`, `:475-477`). A bare
run before publishing therefore tests the release you already shipped, not the one you are about
to. A global-surface regression introduced by the pending release would pass it silently.

`--branch` is trustworthy through stage 5 as of core#522 — before that, the drift-repair stage
reinstalled `@latest` over the branch build and silently discarded it.

`exit 0` is PASS. Nonzero is FAIL with the failing stage named in the summary.

**Read the pre-release run, do not "fix" it.** It runs against whatever is on `latest`, so a fix
that is merged but unpublished shows up as a FAIL. That is the gate reporting the reason for the
release. Only the post-release run is required to pass.

Useful flags:

| Flag | Effect |
|---|---|
| `--skip-live` | no tmux/`sp` scenario — faster, no API key needed |
| `--branch <repo>=<ref>` | packs and installs that repo's branch globally, so the run tests the branch's **code** |
| `--tag next` | exercise a release candidate in every stage |
| `-e ANTHROPIC_API_KEY=...` | enables the live `sp run` scenario |
| `-e XTRM_SMOKE_FAULT=<name>` | injects one break before the assertions — used to prove a check can fail |


### Cutting the release

```bash
# 1. Make sure main is green on CI.
gh pr list --base main --state open
git checkout main && git pull

# 2. Generate concise notes before creating the tag.
git-cliff --config changelog/cliff.toml --unreleased --tag vX.Y.Z > /tmp/xtrm-vX.Y.Z.md

# 3. Bump version. The npm version lifecycle runs scripts/changelog-update.mjs --tag,
#    which writes the [X.Y.Z] section from the git log, then syncs workspace versions.
npm version minor -m "release: %s"  # use patch for fix-only batches
git push --follow-tags

# 4. Create a matching GitHub Release — this fires publish.yml.
gh release create vX.Y.Z --title "vX.Y.Z — <summary>" --notes-file /tmp/xtrm-vX.Y.Z.md
```

That last step triggers `publish.yml`. The workflow:

1. `resolve_ref` reads `.xtrm/specialists-source.json` → `.source.ref` (currently `master`).
2. `fresh_machine_smoke` runs the workflow_call entry of `fresh-machine-smoke.yml` with that ref. If smoke fails, publish never starts.
3. `publish` runs the 6 gates in order, then `npm publish --provenance`.

### CHANGELOG.md: the [Unreleased] block stays empty

The committed `## [Unreleased]` heading is an **empty placeholder**. Nothing goes under it
on a branch. Step 3 above generates the whole released section from the git log, so a
committed entry adds nothing to the release.

| You want | Command |
|---|---|
| See what is pending release | `npm run changelog:preview` (prints, writes nothing) |
| CI/pre-push says the block is not empty | `npm run changelog:update` |
| Cut a release | `npm version …` — runs `--tag` for you |

This is not a style preference. The block is derived from the git log, so two branches off
the same `main` hold two different generated states of the same lines, and every merge to
`main` conflicts every other open pull request on a file nobody disagreed about — the cost
grows with the square of the open pull requests (five rebases in one day, bead
`xtrm-wiy5n.4.28`). Squash-merge also rewrites the commit ids and timestamps the entries are
keyed on, so a per-branch block cannot be kept true on `main` at all (bead `xtrm-wiy5n.4.29`).

No merge driver is configured for `CHANGELOG.md`, deliberately: `merge=union` would
concatenate both sides of a real release conflict and silently duplicate entries. With an
empty placeholder there is nothing to merge.

### If publish fails

- **Smoke job fails (`fresh_machine_smoke`)**: a real install regression. Don't override. Open the smoke logs (ERR trap dumps every `/tmp/xt-*.{log,stdout,stderr}` and `/tmp/sp-*.{log,stdout,stderr}`), identify the broken phase, fix it, cut a new release. Do not work around by skipping the gate.
- **One of the 6 publish gates fails**: see the gate-specific recovery below.
- **`npm publish` fails after all gates passed**: registry token / provenance / network issue. Safe to re-run the workflow (`gh workflow run publish.yml` won't work — it's release-triggered. Either republish the same release in the UI, or `gh release delete && gh release create` again.)

### Gate-specific recovery

| Gate | Symptom | Fix |
|------|---------|-----|
| `check:skills-ownership` | `docs/skills-ownership.json` mismatch | Update the JSON to reflect actual ownership |
| `check:specialists-vendor` | Mirror drifted from upstream specialists | Run `node scripts/vendor-specialists-skills.mjs --specialists-ref <ref>`, commit `.xtrm/skills/default/` + `.xtrm/specialists-source.json` |
| `check:layout-guards` | Stray file or nested folder under `.xtrm/skills/default/` | Move/remove the offender |
| `check:payload-hygiene` | Forbidden artifact in tarball | Add a `!` entry under `files` in package.json or fix the source dir |
| `check:registry-pack-parity` | Registry references a file `npm pack` doesn't include | Run `npm run gen-registry` and commit, or fix the missing file's `files`/exclude entry |
| `verify-asset-contract.mjs` | sha256 drift on one or more shipped skills | Re-vendor against the same specialists ref that produced the contract |
| Fresh-machine smoke | Bootstrap broke | See xtrm-5k0o family of bugs |

---

## 4. Agent rules for touching release plumbing

This section is the **load-bearing one** for any agent editing the workflows or scripts below. Every rule has a reason; ignoring it has historically caused a real failure.

### Files in scope

```
.github/workflows/ci.yml
.github/workflows/publish.yml
.github/workflows/pre-publish-readiness.yml
.github/workflows/specialists-validation.yml
.github/workflows/fresh-machine-smoke.yml
.github/workflows/install-order-matrix.yml
scripts/vendor-specialists-skills.mjs
scripts/verify-asset-contract.mjs
scripts/check-*.mjs
scripts/gen-registry.mjs
.xtrm/specialists-source.json
.xtrm/registry.json
docs/skills-ownership.json
```

### Hard rules

1. **`xt install` does not exist.** The CLI has no `install` subcommand. The canonical bootstrap is `xt init -y` (non-interactive, phased machine → Claude → Pi → project). Refresh is `xt update --apply [--repo PATH]`. Health is `xt doctor [--cwd PATH] [--json] [--check-drift]`. Verify with `node cli/dist/index.cjs <subcommand> --help` before scripting.

2. **Never use `${{ ... }}` directly inside a `run:` block.** Semgrep `yaml.github-actions.security.run-shell-injection` will block the push. Always map github-context expressions into step-level `env:` and reference `"$VARNAME"` (double-quoted) in the shell:
   ```yaml
   - name: Example
     env:
       USER_INPUT: ${{ inputs.foo }}
     run: |
       echo "got $USER_INPUT"
   ```

3. **Specialists ref is pinned in `.xtrm/specialists-source.json` (`.source.ref`).** Never hardcode `master` (or anything else) in workflow YAML. Read it with `jq -er '.source.ref' .xtrm/specialists-source.json` in a `resolve_ref` job and pass the output to downstream jobs/steps via `needs.resolve_ref.outputs.specialists_ref`.

4. **`publish.yml` is a 3-job DAG.** Order is fixed: `resolve_ref` → `fresh_machine_smoke` → `publish`. `publish.needs: [resolve_ref, fresh_machine_smoke]`. Do not collapse them into one job — that re-introduces the unblocking-fresh-machine bug from xtrm-9xg2.

5. **`fresh-machine-smoke.yml` must keep BOTH `workflow_dispatch:` and `workflow_call:` triggers.** Removing `workflow_call:` breaks `publish.yml`. Removing `workflow_dispatch:` breaks the operator pre-flight.

6. **`verify-asset-contract.mjs` parses paths, not skill names.** The specialists `asset-contract.json` schema has `shipped_skills[].path` (e.g. `config/skills/using-specialists/SKILL.md`) and `shipped_skills[].sha256` — there is no `entry.skill` or `entry.name` field. Skill name = `path.basename(path.dirname(entry.path))`, file basename = `path.basename(entry.path)`. Vendor mirror = `.xtrm/skills/default/<skill>/<basename>`.

7. **Must-have skills are hardcoded by name in the verifier.** `using-specialists`. If the bead asks you to drop or rename the must-have, push back — this is the skill xtrm-tools cannot ship without breaking the agent install flow.

8. **Never run a destructive shell command (`rm -rf`, `git reset --hard`, force-push, drop table) inside any of these workflows.** Operator confirmation only.

9. **CI gates run on every PR via `ci.yml`. Don't duplicate them into `publish.yml`** — that's why the gates are scripted (`npm run check:*`) rather than inlined. `publish.yml` re-runs them as a defence-in-depth check at release time only.

10. **Vendor script (`scripts/vendor-specialists-skills.mjs`) does NOT yet write `.source.ref` or `.source.resolved_sha` to the manifest.** Known follow-up. For now, update the manifest by hand when you change the specialists ref. Don't replace the manifest with a regenerated one that loses the `ref` field.

11. **For workflow YAML edits, validate locally before pushing.** `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/<file>.yml'))"`. Pre-push hook (semgrep + gitleaks + osv) will catch other issues but is slower than a 50ms yaml check.

12. **For specialist-tracked edits, follow the auto-mode pattern: `--worktree` executor → reviewer with `--job <exec-job>` → `sp finalize` → `sp merge`.** Direct edits are only acceptable for: pre-push hook fixes that arrive after a reviewer PASS; CI triage where the executor's auto-worktree can't see merged files (because it forks from origin/main); and clearly mechanical follow-ups. Document the deviation in the commit body or bead note.

### Resolved (was deferred, now final)

The three previously-deferred items are all closed as of `xtrm-lhqy`:

- **Vendor script writes ref + resolved_sha.** `scripts/vendor-specialists-skills.mjs` now accepts `--specialists-ref <value>` and writes both `source.ref` and `source.resolved_sha` (the git HEAD of the specialists checkout at vendor time) to `.xtrm/specialists-source.json`. No hand-edits needed; `publish.yml` reads the value via `jq`.
- **xtrm-5k0o (PATH cache) fixed.** `checkDep` in `cli/src/core/machine-bootstrap.ts` extends `process.env.PATH` with `~/.local/bin`, `/usr/local/bin`, and `/opt/homebrew/bin` on module load, so `spawnSync` finds binaries that were just installed in the same process.
- **`pre-publish-readiness.yml` is a real dry-run.** Rewritten as a 3-job DAG (resolve_ref → fresh_machine_smoke → publish_dry_run) that runs the exact same gate chain as `publish.yml` minus `npm publish`. Use it to confirm the chain is green before tagging.

### What the fresh-machine smoke actually asserts

`fresh-machine-smoke.yml` runs the full bootstrap (`xt init -y`, `xt doctor`, `xt update`, `sp init/doctor/list`) and captures every output. But its **gate assertions** are deliberately narrow — only the three things the release contract actually owns:

1. The must-have specialists skill exists at `.xtrm/skills/default/using-specialists/SKILL.md`, and `update-specialists` no longer ships.
2. No symlinks anywhere under `.xtrm/`.
3. No "Source and destination must not be the same" regression in any log.

**Explicitly NOT asserted**: `.xtrm/registry.json` (depends on Project Bootstrap phase, which needs `bd`), `sp list` output (needs the `bd` workspace + Pi extensions). Those bind to third-party packages with their own postinstall behaviour — outside the release-contract scope. `xt init -y` failing because `@beads/bd` couldn't download its native binary is **not** a release-contract violation.

### Runtime prerequisites for `sp`

`@jaggerxtrm/specialists` ships its `sp` binary with `#!/usr/bin/env bun` and declares `engines.bun >= 1.0.0`. Any environment running `sp init` / `sp doctor` / `sp list` must have Bun on PATH. CI workflows (`fresh-machine-smoke.yml`, `install-order-matrix.yml`) install Bun via `oven-sh/setup-bun@v2`. Local operators need `curl -fsSL https://bun.sh/install | bash` or equivalent.

### install-order-matrix scope clarification

`install-order-matrix.yml` stays `workflow_dispatch`-only by design — not because of a bug we can fix. The legs install third-party packages (`@beads/bd`, `oh-pi`, `dolt`, `bv`, etc.) whose bin layouts and post-install download behavior vary across environments. `@beads/bd` is a binary-downloader that drops the real `bd` into `~/.local/bin` via a postinstall script; `oh-pi` exposes only `oh-pi` (the `pi` command on dev machines is a separately-installed `@mariozechner/pi-coding-agent`). Validating those is upstream packaging concerns, not release-contract concerns. Run the matrix manually before tagging when you want a regression catcher; the actual release gating happens in `publish.yml` → `fresh_machine_smoke` which exercises the full `xt init` + `sp init` flow against the vendored mirror.

### Cross-references

- Session report that closed the contract epic: `.xtrm/reports/2026-05-13-release-contract-completion.md`
- Specialists side: `unitAI-ye5s9` (master `484aced8`), `dist/asset-contract.json` + `release-gate.yml`
- Auto-mode playbook for tracked edits: `.xtrm/skills/active/using-specialists/SKILL.md`
- CLI command reference: `node cli/dist/index.cjs --help`
