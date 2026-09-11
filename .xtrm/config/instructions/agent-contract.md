# XTRM agent contract — shared canonical body (ISSUE-136)

> Generated from ONE canonical source: `.xtrm/config/instructions/agent-contract.md`.
> `agents-top.md` and `claude-top.md` embed this body verbatim between the
> contract markers, then append a small runtime suffix. Durable edits belong HERE.
> Parity + compactness: `cli/src/tests/agent-contract-parity.test.ts`.

<!-- contract:start -->

## Canonical Sources
- CLI `--help` is canonical for syntax; skills own **when**. Managed blocks are routers, not manuals.
- Managed blocks and installed skills update via `xt update --apply`; check versions with `xt version --check-updates`.

## Session start (targeted — no bulk context dump)

1. Read repo identity + non-negotiables at the top of the root agent guide first.
2. Service/docs/project context: check `service-knowledge status` / `index stats` (rebuild when stale/absent), then `service-knowledge index query "<3-5 task terms>" --bundle`; read only the cited evidence. Skip repos without a service registry.
3. Executable work: discover the ready Issue revision, validate readiness, then claim it (`sb issue claim`) before edits. Resume continuing work via `sb issue resume` — never reconstruct state from chat alone.
4. Catch up: Journal handoff/checkpoint refs, latest `xt report` handoffs, recent merged/closed PRs.
5. If the runtime supports local task planning, use it for non-trivial work, synchronized with the active Issue claim.

## Operating model

- Substrate owns durable work; Git owns code truth. A ready Issue revision is the executable contract; runtime-local task plans are ephemeral execution tracking.
- For work another worker consumes, the Issue is the prompt: requirements live in the durable contract, not only in chat. A draft contract is not dispatchable.
- Contract baseline: PROBLEM, SUCCESS, SCOPE, NON_GOALS, CONSTRAINTS, VALIDATION, OUTPUT; add SCRUTINY and rollout/rollback when they affect correctness.
- Worker summaries are claims. Verify important ones against live code, tests, or runtime state.
- Messages coordinate; the Journal preserves continuity; neither silently modifies the Issue contract. If executable authority changes, stop and revise the Issue through planning.
- Prefer native/runtime communication surfaces over tmux scraping; `/multiplexing` owns send, reply, ownership, continuation, and handoff semantics.
- Shape: work here when context suffices; native subagent for a bounded independent question; `xt pi|claude|codex` peers with `/multiplexing` for parallel ownership; `/using-specialists` for governed role lifecycles; a script or runtime primitive for deterministic transforms. Parallelize only when ownership boundaries are real.

## Operating rules

- Release authority on completion: close or release the claimed Issue through Substrate (see `sb help --json` for current lifecycle syntax); the claim/edit/commit gates still guard edits and commits.
- Before editing existing symbols run GitNexus impact (`gitnexus_impact`) when available; before commit, run `gitnexus_detect_changes`.
- Ask before destructive, irreversible, production-impacting, or history-rewriting actions; skip repetitive "Proceed?" confirmations once scope is clear.
- Run targeted tests/build/typecheck for changed files; fix quality failures before commit.
- Use the smallest correct change; never simplify away validation, security, accessibility, rollback, or required failure handling.
- For regressions reconstruct causality before patching: symptom → first bad observation → code path → change → mechanism → smallest correction → regression proof.

## Skill routing (on demand)

| Need | Skill |
|---|---|
| XTRM doctrine, contracts, evidence, work shape | `/using-xtrm` |
| Resume, takeover, context-pressure continuation | `/starting-and-resuming-work` |
| Peer and subagent coordination, replies, continuation | `/multiplexing` |
| Contracts, decomposition, board triage, validation planning | `/planning` |
| Debug, review, test, verify, reduce | `/engineering-quality` |
| Specialists runtime and role/job lifecycle | `/using-specialists` |
| Code graph, impact, debugging, refactoring | `/gitnexus` |
| Create or improve skills | `/skill-creator` |
| Discover or import governed skills | `/find-skills` |

Domain packs (`sre-ops`, `security-ops`, `research-methods`, `xtrm-development`, `xtrm-maintenance`) are optional; inspect `xt skills` rather than assuming they are active. Syntax per CLI: `sb --help`, `sb help --json`, `xt --help`, `xtmux --help`, `sp --help`.

## Rule conflict — TaskCreate / TodoWrite

Durable work lives in Substrate, not in chat task lists. Runtime-local task planning coexists with the Issue contract — the Issue is the durable authority; local plans are ephemeral execution tracking. Resume via the Resume Capsule (`sb issue resume`); never re-derive state from conversation history. Do not create MEMORY.md files.

<!-- contract:end -->
