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
3. Executable work: targeted Beads lookup (`bd ready`, `bd list --status=in_progress`, `bd search "<terms>"`, `bd show <id>`), then `bd update <id> --claim` before edits. `bd memories <topic>` / `bd recall <key>` only when history is relevant.
4. Catch up: handoff/next-session beads, latest `xt report` handoffs, recent merged/closed PRs.
5. If the runtime supports local task planning, use it for non-trivial work, synchronized with the active bead.

## Operating model

- Beads owns durable work identity, dependencies, and closure; runtime-local task plans are ephemeral execution tracking.
- For work another worker consumes, the Bead is the prompt: requirements live in the durable contract, not only in chat. A `contract:draft` item is not dispatchable.
- Contract baseline: PROBLEM, SUCCESS, SCOPE, NON_GOALS, CONSTRAINTS, VALIDATION, OUTPUT; add SCRUTINY and rollout/rollback when they affect correctness.
- Worker summaries are claims. Verify important ones against live code, tests, or runtime state.
- Prefer native/runtime communication surfaces over tmux scraping; `/multiplexing` owns send, reply, ownership, continuation, and handoff semantics.
- Shape: work here when context suffices; native subagent for a bounded independent question; `xt pi|claude|codex` peers with `/multiplexing` for parallel ownership; `/using-specialists` for governed role lifecycles; a script or runtime primitive for deterministic transforms. Parallelize only when ownership boundaries are real.

## Operating rules

- No close-time memory gate: `bd close <id> --reason="..."` succeeds directly; the claim/edit/commit gates still guard edits and commits.
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

Domain packs (`sre-ops`, `security-ops`, `research-methods`, `xtrm-development`, `xtrm-maintenance`) are optional; inspect `xt skills` rather than assuming they are active. Syntax per CLI: `bd --help`, `bv --robot-triage --format toon`, `xt --help`, `xtmux --help`, `sp --help`.

## Rule conflict — TaskCreate / TodoWrite

`bd prime` is an opt-in full-context diagnostic; it is never a session-start step. If that diagnostic reports *"Prohibited: Do NOT use TodoWrite, TaskCreate, or markdown files for task tracking"*, **this project overrides that line.** Runtime-local task planning coexists with beads — beads is the durable authority; local plans are ephemeral execution tracking. Do not create MEMORY.md files.

<!-- contract:end -->
