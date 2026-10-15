# xtrm smoke-test container

Pre/post-release gate for the xtrm trio — `xtrm-tools` (`xt`),
`@jaggerxtrm/specialists` (`sp`), `@jaggerxtrm/xtmux` (`xtmux`). One Alpine
container installs the three packages from npm, exercises the update
mechanisms, clones the three xtrm repos as test subjects, induces drift,
re-runs `xt update --apply`, and verifies the before/after state.

`exit 0` = PASS. Nonzero = FAIL, with the failing stage named in the summary.

## Usage

```bash
docker build -t xtrm-smoke scripts/smoke-container/
docker run --rm xtrm-smoke ./verify.sh                 # currently-released packages
docker run --rm xtrm-smoke ./verify.sh --tag next      # a release candidate, in every stage
docker run --rm xtrm-smoke ./verify.sh --branch xt/foo # unreleased branch, all repos
docker run --rm xtrm-smoke ./verify.sh --branch core=xt/foo --branch xtmux=fix/bar
docker run --rm xtrm-smoke ./verify.sh --skip-live     # no tmux/sp scenario
docker run --rm -e ANTHROPIC_API_KEY=... xtrm-smoke ./verify.sh   # enables `sp run`
```

Run it twice around a coordinated release: once before publishing (against the
current `latest`) and once after (still `latest`, now the new versions). Both
must be PASS.

`--branch <repo>=<ref>` takes `core`, `specialists`, or `xtmux`. For every repo
that has the ref, the clone is moved to it and that package is packed
(`npm pack --ignore-scripts`) and installed globally — so the run tests the
branch's code, not just its files. Repos without the ref are reported `[SKIP]`.

## Stages

| Stage | What it does | Hard failure when |
|---|---|---|
| `1-install` | `npm i -g` the trio at `--tag` | a binary is missing or does not run |
| `2-update-mechanisms` | re-install at `@latest`; `xt init -y` + `xt update --apply` in a fresh git repo | update leaves no `.xtrm/registry.json` |
| `3-clone-and-init` | clone the 3 repos, `xt init -y`, snapshot | clone fails |
| `4-apply-edits-and-update` | apply `--branch` (if given), delete a hook payload to induce drift, `xt update --apply`, snapshot | — |
| `4b-global-drift` | break `~/.claude/skills`, `~/.pi/agent/skills`, and the SessionStart `--new-instance` argument; re-run `xt update --apply` (with `XTRM_GLOBAL_HOOKS=1`) + `install_xtmux`, assert each repair | pointer or hook-arg drift not restored |
| `5-verify` | run global-surface assertions (see below), compare project snapshots, run the live scenario | see below |

Snapshots record: trio versions, `.xtrm/registry.json` asset-group count,
registry parity (`declared/missing/mismatch`), hook command count in
`.xtrm/config/hooks.json`, hook payload file count, skill-root counts (repo and
global `~/.xtrm/skills/default`), and symlink count under `.xtrm`.

Stage 5 asserts, per repo: at least one wired hook command, hook payload count
not regressed against the pre snapshot, a non-empty registry, every file the
registry declares present on disk under its group's `source_dir`, a populated
global skill mirror, zero symlinks under `.xtrm`, and that `xt update --apply`
restored the hook payload stage 4 deleted. Registry *hash* mismatches are
reported as `[WARN]`, not failures — a clone of a repo's default branch
legitimately sits ahead of the released registry's hashes.

Stage 5 also runs a global-surface check — the surface the container used to
ignore entirely (bead `xtrm-wiy5n.4.32`):

- `~/.claude/skills` and `~/.pi/agent/skills` are symlinks whose targets
  actually resolve to `~/.xtrm/skills/default`. A dangling link is FAIL — a
  count is not a check.
- `~/.claude/settings.json` carries the xtmux hook events, every SessionStart
  `agent-state.sh` entry contains the `--new-instance` **argument** (bead
  `xtrm-wiy5n.4.25`), no two entries share the same command string (bead
  `xtrm-wiy5n.4.27`), and no `agent-state.sh` entry is untagged (missing
  `_source`, which lets duplicates accumulate on every re-install).
- `~/.pi/agent/settings.json` has at least one `xtmux` package and at least
  one wired hook event.
- The installed `@jaggerxtrm/specialists` package ships at least five
  `.specialist.json` files in `config/specialists/`.

Globally it also asserts the specialists-owned skill
(`using-specialists`) landed in
`~/.xtrm/skills/default`, runs the core clone's own
`scripts/check-skill-root-budget.mjs` (so the budgets live in one place, not
duplicated here), and asserts that the `Source and destination must not be the
same` fresh-machine regression did not reappear anywhere in the run.

Budget overruns are `[WARN]`. The clone's `.xtrm/skills/default` holds whatever
the *installed* package shipped, so a pre-release run legitimately reports roots
that the release being gated is about to slim — a red gate there would block the
fix. Compare the pre and post runs: overruns present in both are a real
regression.

The live scenario migrates the observability DB, asserts `xtmux-obs health`,
starts a tmux session, runs `xtmux log follow` and `xtmux-events --json` against
it, and sends a beaded `xtmux message-send`. The follower must deliver that
exact message key live, and `xtmux-events` must start and report the session it
is following. `sp run` only runs when model credentials are in the environment —
and when it does run, it gates; without credentials it is `[SKIP]`, which does
not affect PASS/FAIL. Terminal-notification delivery is always `[SKIP]`: there
is no terminal in a headless container to receive one. Use `--skip-live` where
tmux is unavailable.

Failures print the tail of the command log. `--keep` retains the work directory
(snapshots + full command log) instead of deleting it on exit.

## Proving each global-surface check fails on broken input

The container accepts an `XTRM_SMOKE_FAULT` env var that injects a single
fault right before the global assertions run. Stage `4b-global-drift` is
skipped when a fault is under test so the break survives; the assertion
downstream must trip. Every value below has been proven to force a FAIL:

```bash
# Each of these must exit nonzero and name the corresponding assertion.
docker run --rm -e XTRM_SMOKE_FAULT=broken-claude-skills xtrm-smoke ./verify.sh --skip-live
docker run --rm -e XTRM_SMOKE_FAULT=broken-pi-skills     xtrm-smoke ./verify.sh --skip-live
docker run --rm -e XTRM_SMOKE_FAULT=missing-new-instance xtrm-smoke ./verify.sh --skip-live
docker run --rm -e XTRM_SMOKE_FAULT=duplicate-hook       xtrm-smoke ./verify.sh --skip-live
docker run --rm -e XTRM_SMOKE_FAULT=untagged-agent-state xtrm-smoke ./verify.sh --skip-live
docker run --rm -e XTRM_SMOKE_FAULT=removed-pi-package   xtrm-smoke ./verify.sh --skip-live
docker run --rm -e XTRM_SMOKE_FAULT=removed-specialists  xtrm-smoke ./verify.sh --skip-live
```

An unrecognised value fails the script with a named error instead of silently
passing.

Expect roughly 12–15 minutes end to end. `xt init -y` runs `gitnexus analyze`
per repo with a 120 s internal timeout, which dominates the runtime.

## Alpine/musl caveats this container works around

These are upstream defects, not harness bugs. They are reported as `[WARN]`
rather than `[FAIL]` so the gate stays usable, but they are real:

- **`bun` on musl.** `@jaggerxtrm/xtmux` depends on the `bun` npm package, whose
  binary is glibc-only (`ENOEXEC` on Alpine), so `npm i -g @jaggerxtrm/xtmux`
  fails in its postinstall. The container installs the official
  `bun-linux-x64-musl` build to `/opt/bun/bin` (first on `PATH`) and, on
  install failure, retries with `--ignore-scripts` and drops the musl binary
  over the bundled `bun.exe`. `XTMUX_BUN` alone does **not** fix this:
  `scripts/xtmux-obs.mjs` resolves the bundled path unconditionally and
  overwrites the env var.
- **`install(1)` shadowing.** `@jaggerxtrm/specialists` declares a bin named
  `install`, so after `npm i -g` it shadows coreutils `install` for any shell
  with the npm global bin dir ahead of `/usr/bin`. Stage 5 names every global
  npm bin that shadows a system command.
- **`bd` on musl.** `@beads/bd`'s postinstall download does not resolve on
  Alpine; the image takes the `linux_amd64` release binary and adds `gcompat`.

One more `[WARN]`, not Alpine-specific: `xtmux-events` follows the journal
correctly but renders nothing, because it joins the journal's `session_id`
(`$0`) against `xtmux dashboard`'s composite `sessionId`
(`$0_name_%0_path_ts`). `xtmux log follow` delivering the same event is the
hard assertion; the render gap is reported and named.

## Architecture

Bun and beads binaries are selected from `TARGETARCH` (`amd64` → bun `x64` /
beads `linux_amd64`, `arm64` → bun `aarch64` / beads `linux_arm64`). Only the
amd64 path has been run end to end; the arm64 mapping is mechanical and
untested. Any other `TARGETARCH` fails the build with a named error rather than
installing an incompatible binary.

## Non-goals

No compose, no k8s, no CI wiring, no multi-stage build. One Dockerfile, one
bash script, host `docker` is the only dependency.
