# Service-skills auto-reconcile (Phase B)

Per-repo enablement guide for the post-merge auto-reconcile pipeline that keeps
`SKILL.md` documentation in sync with implementation drift.

## What it is

A reusable GitHub Action that, on every merge to a default branch:

1. Scans for service-skills drift (Phase A).
2. (Optional, opt-in) Calls an LLM to rewrite the drifted `SKILL.md` files.
3. Opens an auto-PR (`xtrm-auto-reconcile/<sha>`) with the reconciled docs.

When the operator merges that auto-PR, drift is closed. The next merge with no
drift produces no comment and no auto-PR.

## Architecture

```
default branch merge
    ↓
xtrm-dev/core/.github/workflows/service-skills-drift-sweep.yml@main  (reusable)
    │
    ├── drift-sweep job  (Phase A — always runs)
    │     scan_drift → drift > 0 → sticky comment on merged PR
    │
    └── auto-reconcile job  (Phase B — gated on reconcile-enabled + drift > 0)
          pip install httpx==0.28.1
          python3 .xtrm/skills/default/service-skills/scripts/reconcile.py --json
          peter-evans/create-pull-request@<v7-SHA>  →  xtrm-auto-reconcile/<sha>
```

The reconcile script lives in the consumer repo at
`.xtrm/skills/default/service-skills/scripts/reconcile.py` (installed by
`xt update --apply`).

## Per-repo enablement

### 0. Vendor the reconcile script (do this first)

The reusable workflow runs `python3 .xtrm/skills/default/service-skills/scripts/reconcile.py` against the consumer repo's working tree. Make sure that file is present and current before opting in:

```sh
xt update --apply
```

If the consumer repo's `.xtrm/skills/default/service-skills/scripts/` only contains `drift_detector.py` (older snapshot), Step 1+ will succeed but the auto-reconcile job will exit 2 with `No such file or directory`. Re-run `xt update --apply` whenever `xtrm-tools` ships changes to that directory.

### 1. Configure the API key secret

```sh
gh secret set PROVIDER_API_KEY --repo <org>/<repo>
```

The secret is forwarded to the workflow as `provider-api-key`. The legacy
secret name `nano-gpt-api-key` is still accepted (see "Multi-provider support"
below).

### 2. Add (or update) the caller workflow

`.github/workflows/service-skills-drift.yml`:

```yaml
name: Service-skills drift

on:
  pull_request:
    types: [closed]
    branches: [main]

jobs:
  drift:
    if: github.event.pull_request.merged == true
    uses: xtrm-dev/core/.github/workflows/service-skills-drift-sweep.yml@main
    permissions:
      contents: write          # required for auto-PR
      pull-requests: write
    with:
      reconcile-enabled: true  # opt in to Phase B
    secrets:
      provider-api-key: ${{ secrets.PROVIDER_API_KEY }}
```

### Multi-provider support

The workflow is provider-agnostic. By default it targets `nano-gpt`
(`moonshotai/kimi-k2.6`); to target a different OpenAI-compatible provider
override the `provider-*` inputs:

```yaml
    with:
      reconcile-enabled: true
      provider-name: openrouter
      provider-base-url: https://openrouter.ai/api/v1
      provider-model: anthropic/claude-sonnet-4.6
      # provider-api defaults to 'openai-completions' (covers openrouter, vllm, etc)
    secrets:
      provider-api-key: ${{ secrets.OPENROUTER_API_KEY }}
```

The legacy inputs (`nano-gpt-model`, `nano-gpt-api-url`, `specialists-model`)
and legacy secret (`nano-gpt-api-key`) still work but emit deprecation warnings.
Note: the Phase B fallback (`reconcile.py`) is **nano-gpt-only**; when
`provider-name` is anything else, Phase B is skipped and the specialist path
is the only route.

Pin `@main` for "always latest" or to a specific commit SHA for stability.

### 3. Verify

Open a no-op PR; the workflow should run and report no drift (no comment, no
auto-PR). Then introduce a real drift to test the full path — see "Smoke
testing" below.

## Disabling

Set `reconcile-enabled: false` (or remove the input entirely; default is
`false`). The workflow reverts to Phase A behavior (sticky comment only). The
secret can stay configured.

## Configuration

| Knob | Where | Default |
|---|---|---|
| Opt in / out | caller workflow `with.reconcile-enabled` | `false` |
| API key | repo secret forwarded as `provider-api-key` (or legacy `nano-gpt-api-key`) | unset |
| Provider key | input `provider-name` | `nano-gpt` |
| Provider api adapter | input `provider-api` | `openai-completions` |
| Provider base URL | input `provider-base-url` | `https://nano-gpt.com/api/v1` |
| Provider model | input `provider-model` | `moonshotai/kimi-k2.6` |
| Token cost cap | env `XTRM_AUTO_RECONCILE_COST_LIMIT_TOKENS` on the auto-reconcile job | unset (no cap) |
| Drift detector source path | input `scripts-path` | `.xtrm/skills/default/service-skills/scripts` |
| Sticky-comment marker | input `comment-marker` | `<!-- service-skills-drift-sweep -->` |

Cost cap example:

```yaml
    with:
      reconcile-enabled: true
    env:
      XTRM_AUTO_RECONCILE_COST_LIMIT_TOKENS: "50000"
```

## Failure behavior (Phase A fallback)

The auto-reconcile job exits 0 (annotation only, not a workflow error) when any
of these conditions hold:

| Condition | Annotation in workflow logs |
|---|---|
| `reconcile-enabled: false` | "auto-reconcile disabled; Phase A drift comment behavior preserved" |
| Both `provider-api-key` and `nano-gpt-api-key` absent | "skipped because neither provider-api-key nor nano-gpt-api-key secret is set" |
| `pip install httpx==0.28.1` fails | "skipped because httpx install failed with exit N" |
| `reconcile.py` exits non-zero | "skipped because reconcile.py exited N" |
| `status != success` or `reconciled_count == 0` | "produced no PR because <reason>" |
| Cost cap hit mid-run | partial-result JSON; no PR opened |

In all cases, the Phase A sticky comment is still posted on the merged PR.

## Concurrency

The workflow uses `concurrency: group: service-skills-drift-${{ github.ref }}`
with `cancel-in-progress: false` — successive merges to the same branch are
**queued, not cancelled**. Losing reconcile work to a cancellation is worse
than a slow queue.

Two PRs merged within 30s will produce two sequential workflow runs, each
opening its own `xtrm-auto-reconcile/<sha>` branch.

## Anti-loop

The auto-reconcile job has an explicit guard:

```yaml
if: !startsWith(github.event.pull_request.head.ref, 'xtrm-auto-reconcile/')
    && github.event.pull_request.user.login != 'github-actions[bot]'
```

When the auto-PR itself is merged, the workflow runs (drift = 0 expected), but
the auto-reconcile job is skipped via this guard — no loop.

## Troubleshooting

| Symptom | Likely cause | Where to look |
|---|---|---|
| Phase A comment present, no auto-PR | `reconcile-enabled` not `true`, secret absent, or reconcile error | Auto-reconcile job logs — annotation explains |
| Auto-PR opens but workflow doesn't run on it | GitHub Actions security: GITHUB_TOKEN commits don't trigger workflows | Use "Approve and run" on the PR |
| reconcile job fails on `import drift_detector` | Repo missing `.xtrm/skills/default/service-skills/scripts/` | Run `xt update --apply` in repo |
| reconcile job 401/403 from nano-gpt | Wrong / revoked API key | Rotate `NANO_GPT_API_KEY` repo secret |
| Workflow queued forever | Another run in same concurrency group still active | Wait or cancel the head run |

## Refs

- Workflow: `xtrm-dev/core/.github/workflows/service-skills-drift-sweep.yml`
- Reconcile script: `.xtrm/skills/default/service-skills/scripts/reconcile.py`
- Bead epic: `xtrm-lwpcn`
- Bead: `xtrm-pm5d8`
