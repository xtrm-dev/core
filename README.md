# XTRM

> [!WARNING]
> **Documentation freshness**
>
> XTRM is evolving quickly. Long-form documentation can lag behind the current runtime.
> For the exact revision or installed version you are using, treat these as the operational authorities:
>
> 1. the source and generated contracts at that revision;
> 2. `xt --help` and `xt <command> --help`;
> 3. the canonical workflow skills, especially `/using-xtrm`, `/multiplexing`, and `/using-specialists`;
> 4. `CHANGELOG.md`, release notes, and merged pull requests.
>
> The README is an orientation surface, not a substitute for the live command contract.


**XTRM (`xt`) is a durable multi-agent coding runtime for Pi, Claude Code, Codex, and Specialists.**

> [!NOTE]
> **Naming**
>
> **XTRM** is the whole stack. **Core** is its control-plane component and this repository’s name.
> Core is currently distributed on npm as `xtrm-tools`; that package name is transitional
> and is planned for retirement as the repositories converge.


It gives coding workers an isolated place to work, a durable contract to work from, the tools and skills they need, and a way to coordinate with other workers without rebuilding the whole system from chat history every time.

```text
xt pi / xt claude / xt codex
            │
            ├── isolated worktree + durable session
            ├── project/system context
            ├── skills + tools + deterministic hooks
            ├── Bead work contract + tracked state
            ├── native/extension peer coordination
            └── Specialists when the work is role-shaped
```

Pi is the harness I use most and the richest XTRM integration, but the runtime is deliberately harness-aware rather than Pi-only.

> **Give every worker a great contract.**

That is the principle most of XTRM grows out of.

## Planning is part of the runtime

One thing we keep removing from agents is the need to rediscover the system before they can do the job.

In XTRM, that system is the codebase.

Before substantial work is dispatched, planning is a real stage. We want to know what changed recently, which code paths are involved, what already exists and should be reused, the blast radius, dependencies, constraints, likely failure modes, and what will actually prove the work is complete.

Then we write the Bead.

Not a better side prompt. A durable work contract.

A dispatchable contract has these baseline fields:

```text
PROBLEM
SUCCESS
SCOPE
NON_GOALS
CONSTRAINTS
VALIDATION
OUTPUT
```

For substantial, ambiguous, high-risk, or review-sensitive work, add explicit `SCRUTINY` so the worker also knows what deserves adversarial attention.

Two rules matter a lot:

1. **A draft task can exist, but it cannot run.** A draft may still contain unknowns; dispatch requires a grounded contract.
2. **For tracked work, the Bead is the prompt.** If an important requirement exists only in the orchestrator's head, chat history, or an extra side prompt, the contract is wrong. Fix the contract.

The worker should spend its turn solving the job, not reconstructing what the job was supposed to be.

[Beads](https://github.com/Jaggerxtrm/beads) is the durable issue/work-state dependency underneath this model: roughly an agent-native Jira-like board backed by Dolt. It gives contracts identity, dependencies, claims, state, history, evidence, and a place for the next worker to resume. Beads is an important substrate; it is not the definition of XTRM.

## The model call is downstream

The same failure mode shows up outside software.

A coding agent can be given a repository and waste half a turn rediscovering what changed, what matters, and which abstractions are real. A market agent can be handed raw feeds and produce a convincing answer while silently reconstructing the wrong market state.

The architecture is the same:

```text
CODE

repository
  → system understanding
  → planning
  → work contract
  → worker


MARKETS

feeds
  → domain model
  → structured market state
  → agent
```

More raw context does not decide what matters. Somebody has to understand the domain well enough to structure it first.

Better models help downstream of that work. They do not remove the need to understand your own system or domain. If anything, agents make expertise more valuable because encoded expertise can be reused across workers instead of re-explained in every session.

**Not agents replacing expertise. Making expertise executable.**

## One system, multiple workers

XTRM workers are told that they are participating in a multi-agent system rather than acting as isolated chats.

The launcher gives each worker an isolated worktree/session and can inject role-specific system context, tools, skills, and the Bead contract:

```bash
xt pi feature-name
xt claude feature-name
xt codex feature-name

xt pi --role executor --bead <id>
xt claude --role reviewer --bead <id>
```

The normal choice is the smallest execution shape that fits the job:

- keep coherent work in the current session when it already has the right context;
- use native subagents for bounded independent questions;
- use `xt pi`, `xt claude`, or `xt codex` peers for long-lived or isolated parallel work;
- use Specialists for governed role-shaped execution;
- use deterministic scripts/tools for mechanics that do not need model judgment.

### Coordination is native-first

XTRM does not require tmux message scraping to make agents talk to each other. The `multiplexing` skill defines coordination semantics—ownership, send/ask/reply behavior, continuation, wakeup, and durable handoff—while using the best native or extension transport available.

In the Pi environment I use:

- [`pi-intercom`](https://github.com/nicobailon/pi-intercom) by [@nicopreme](https://x.com/nicopreme) for targeted Pi ↔ Pi communication;
- [`pi-claude-link`](https://github.com/alonw0/pi-claude-link) by [@alonw0](https://github.com/alonw0) for Pi ↔ Claude Code communication through Claude's cross-session messaging protocol;
- Claude Code's own peer/team messaging (`SendMessage` and related native surfaces) for Claude ↔ Claude coordination when available.

Peer messages are coordination input, not a substitute for user authority or durable work state. The durable source remains the contract, repository, Bead, and recorded execution evidence.

## Pi is the deepest XTRM integration

Pi is my preferred harness because its extension model lets XTRM expose the runtime without hiding what the agent is doing.

### `xtrm-ui`

XTRM ships its own Pi UI layer as part of `@jaggerxtrm/pi-extensions`.

I tailored it around how I supervise agents: I usually want to see the commands they run, which tools they call, how those tools are being used, and enough output to intervene when critical work starts going in the wrong direction.

`xtrm-ui` therefore keeps execution visible while making it denser rather than opaque. It owns XTRM's Pi header, themes, editor density, and native/external tool presentation. Tool execution remains Pi-native; the UI changes presentation rather than mutating model-facing results. XTRM's `custom-footer` extension owns the compact status/footer surface.

See [docs/xtrm-ui.md](docs/xtrm-ui.md).

### Persistent Python kernel

The Pi extension package also ships `python-kernel`, a persistent sequential `python` tool. Variables, imports, and functions survive across calls until reset. The current implementation also supports Python-backed skills as importable kernel modules, a small standard-library prelude, bounded output/truncation behavior, and a mutation-audit seam.

The goal is the same as elsewhere in XTRM: do not make the worker reconstruct useful machinery repeatedly when a stable runtime primitive can provide it.

### Managed Pi environment

`xt init` / `xt update` manage the Pi environment XTRM expects rather than leaving every machine to accumulate a different ad-hoc package set.

The managed set includes code intelligence, structured returns, guardrails, goals/tasks/background work, subagents, MCP access, Mermaid rendering, XTRM extensions/service knowledge, inter-agent communication, structural code search, worktrees, and process helpers.

Representative packages include:

```text
pi-gitnexus
@robhowley/pi-structured-return
@aliou/pi-guardrails
@narumitw/pi-goal
DietrichGebert/ponytail
@tintinweb/pi-tasks
pi-background-tasks
@gotgenes/pi-subagents
pi-mcp-adapter
pi-mermaid-viewer
@jaggerxtrm/pi-extensions
@jaggerxtrm/pi-service-knowledge
pi-intercom
alonw0/pi-claude-link
pi-ast-grep
@zenobius/pi-worktrees
@aliou/pi-processes
```

The live managed registry in Core is authority for exact install selectors. Local Core development may load `packages/pi-extensions` from the checkout, but the portable managed identity is `npm:@jaggerxtrm/pi-extensions`—never a developer-specific absolute path.

## Understand the codebase before changing it

XTRM treats codebase understanding as part of execution rather than optional browsing.

GitNexus is a default code-intelligence dependency and skill surface for graph exploration, blast-radius analysis, debugging, refactoring, and review. `pi-ast-grep` adds structural code search to the Pi environment. Normal text/CLI/repository search remains available where it is the better primitive.

For regressions, `engineering-quality` requires causal reconstruction rather than speculative patching:

```text
symptom
  → first bad observation
  → failing code / data / control path
  → recent relevant change
  → commit body + diff
  → PR / Bead / worker intent
  → causal mechanism
  → smallest correction that preserves valid intent
  → regression proof
```

The point is not to blame the newest commit. It is to understand what changed, why it changed, how that change reached the failing path, and whether it introduced the defect, exposed an older defect, or is merely correlated with it.

## Deterministic enforcement where judgment is unnecessary

Skills teach procedures and judgment. Hooks/extensions enforce lifecycle rules. Scripts handle deterministic mechanics.

XTRM currently uses deterministic runtime machinery for things such as:

- Bead claim/edit/commit/stop lifecycle;
- worktree boundaries and stale-worktree checks;
- quality checks;
- claim/compact/session restoration;
- Specialist execution boundaries;
- GitNexus enrichment;
- pending coordination/reply reminders;
- debug/runtime event logging.

This keeps critical workflow rules out of prose that a model might simply forget.

See [docs/hooks.md](docs/hooks.md) and [docs/policies.md](docs/policies.md).

## Skills v4

The always-active skill surface is intentionally small:

| Skill | Purpose |
|---|---|
| `using-xtrm` | system doctrine, contracts, evidence, multi-agent behavior |
| `starting-and-resuming-work` | cold start, continuation, handoff, context-pressure recovery |
| `multiplexing` | native-first peer coordination and continuation |
| `planning` | contracts, decomposition, board triage, tests, premortem |
| `engineering-quality` | causal debugging, review, testing, verification, reduction |
| `using-specialists` | Specialists execution plus advanced Specialist references/assets |
| `gitnexus` | code-graph exploration, impact, debugging, refactoring, review |
| `skill-creator` | skill authoring, scripts, evals and promotion discipline |
| `find-skills` | governed discovery/import of additional skills |

Domain-specific capabilities stay opt-in so every worker does not pay their context/routing cost:

`architecture-design`, `data-engineering`, `personal-tools`, `research-methods`, `security-ops`, `sre-ops`, `xt-optional`, `xtrm-development`, and `xtrm-maintenance`.

See [docs/skills.md](docs/skills.md) and [docs/skills-v4-preservation-matrix.md](docs/skills-v4-preservation-matrix.md).

## Specialists

[`@jaggerxtrm/specialists`](https://www.npmjs.com/package/@jaggerxtrm/specialists) is XTRM's governed role/job execution backend.

`using-specialists` is the single runtime skill entry point. KPI analysis, NodeSupervisor, script-class execution, and Specialist-definition authoring live underneath it as references/assets rather than four more always-visible skills.

Use the live CLI/registry when exact roles matter:

```bash
specialists list --full
sp help
```

## SRE and service knowledge

The optional `sre-ops` pack applies the same causal-reconstruction idea to production incidents. It correlates metrics, Grafana dashboards/panel queries, traces, logs, service topology, deploy identity, commits, PRs, Beads, and worker intent.

For observability MCP servers, XTRM prefers the low-context `mcpq` CLI rather than injecting every Grafana/Prometheus/Tempo/OpenTelemetry schema into the agent by default:

```bash
mcpq servers
mcpq <server> list-tools
mcpq <server> describe <tool>
mcpq <server> call <tool> ... --json
```

Service-specific topology/runbook freshness belongs to the `service-knowledge` subsystem. Generic SRE reasoning should consume that knowledge, not duplicate it.

## Durable board state

Beads/Dolt remains board authority. For durable external/export inspection, the current board-audit gen-2 mechanism publishes only board transport artifacts to the permanent orphan branch:

```text
board-audit-export-do-not-cancel
```

That replaces the old one-shot `issue-triage` exporter.

## Quick start

```bash
npm install -g xtrm-tools @jaggerxtrm/specialists

xt bootstrap
xtrm init

xt --version
sp --version
xt doctor
```

Start work:

```bash
xt pi feature-name
xt claude feature-name
xt codex feature-name

# tracked role-shaped work
xt pi --role executor --bead <id>
xt claude --role reviewer --bead <id>

# resume / finish
xt attach
xt end
```

Inspect skills and optional packs:

```bash
xt skills list --global --json
xt skills list --local --json
xt skills enable sre-ops --global
```

Update managed runtime state:

```bash
xt update --repo .          # preview
xt update --apply --repo .  # reconcile
xt doctor
```

Use live `xt <command> --help`, `sp help`, and `specialists list --full` for exact flags and runtime-specific capabilities.

| [XTRM-GUIDE.md](XTRM-GUIDE.md) | full architecture and workflow reference |
| [docs/worktrees.md](docs/worktrees.md) | `xt` worktrees, attach/end/reap and isolation |
| [docs/xt-pi-role.md](docs/xt-pi-role.md) | role launcher and Specialist behavior |
| [docs/xtrm-ui.md](docs/xtrm-ui.md) | XTRM Pi UI/themes/tool rendering |
| [docs/pi-extensions.md](docs/pi-extensions.md) | Pi extension/runtime integration |
| [docs/skills.md](docs/skills.md) | current skills-v4 catalog and tier model |
| [docs/skills-v4-preservation-matrix.md](docs/skills-v4-preservation-matrix.md) | v3 → v4 capability disposition |
| [docs/skills-ownership.md](docs/skills-ownership.md) | Core/Specialists skill ownership and vendoring |
| [docs/hooks.md](docs/hooks.md) | deterministic hooks and event wiring |
| [docs/policies.md](docs/policies.md) | policy compiler and runtime parity |
| [docs/cli-architecture.md](docs/cli-architecture.md) | install/update/composition internals |
| [docs/testing.md](docs/testing.md) | validation checklist |
| [docs/release.md](docs/release.md) | release/publish contract |
| [CHANGELOG.md](CHANGELOG.md) | version history |

---

**Version 0.12.0** · MIT License
