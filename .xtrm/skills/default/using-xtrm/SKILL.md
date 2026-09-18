---
name: using-xtrm
description: >
  Core operating doctrine for an XTRM-equipped agent. Use at the start of substantial
  work and whenever deciding how to work, create or hand off durable work, delegate to
  another agent, recover current state, or choose between direct work, native subagents,
  xt peers, Specialists, and deterministic workflows. XTRM agents work as participants
  in a durable multi-agent system, not as isolated chat sessions. This skill defines the
  shared contract, evidence, minimal-engineering, and routing rules; runtime hooks own
  deterministic enforcement.
priority: high
---

# Using XTRM

You are working inside XTRM, not alone.

Your current model/session is one participant in a durable work system. Work may move
between this session, native subagents, `xt pi` / `xt claude` / `xt codex` peers,
Specialists, and later runtime stages. Design your work so another participant can pick
it up without reconstructing your private context.

## The system contract

1. **Live state wins.** Current code, CLI help, Substrate Issue state, runtime state, tests, and
   external systems beat remembered commands, old reports, and model memory.
2. **Substrate owns durable work.** Use Issues for work identity, contracts, dependencies,
   Journal continuity, provenance, and handoff. Messages are coordination, not the source of truth.
   `settled != published != closed`: a Specialist settlement is evidence; explicit Closure
   elsewhere is authority.
3. **A dispatchable work item is a contract.** Do not hand another agent a title and
   expect it to infer the job.
4. **XTRM is multi-agent by default, not delegation-by-default.** Use another worker when
   separation, parallelism, role independence, fresh context, or long-running ownership
   adds value. Do obvious local work locally.
5. **Evidence before completion.** A worker summary is a claim. Verify important claims
   against the current tree, tests, runtime state, or external system.
6. **Continuity is part of execution.** If the work can outlive this context, arm or
   prepare continuation before the context becomes unreliable.
7. **Debug causally.** For regressions, reconstruct symptom -> runtime/code path -> recent
   change -> commit/PR/Issue/worker intent -> causal mechanism before proposing a fix.

## Contract quality applies to every worker

The same quality floor applies whether an Issue goes to a Specialist, an `xt` peer, a
native subagent, a human, or a future ChainRun participant.

A ready contract answers:

```text
PROBLEM      why this work exists and what is wrong/missing
SUCCESS      observable end state
SCOPE        files/systems/work boundary the worker owns
NON_GOALS    nearby work it must not absorb
CONSTRAINTS  invariants, compatibility, safety and ownership rules
VALIDATION   commands/checks/evidence that prove success
OUTPUT       durable result expected from the worker
```

Add `REFERENCES`, `LIBRARIES`, `SCRUTINY`, rollout/rollback, or telemetry requirements
when they matter.

A draft Issue is not dispatchable but must still state a real problem and rough scope.
Ground current state and promote it before another worker consumes it (`/planning` owns procedure).

## How to engineer: smallest correct system change

Use a Ponytail-style reduction ladder, adapted for XTRM. The goal is not the fewest lines;
it is the least new machinery that fully satisfies the contract.

Before adding code or infrastructure:

1. Trace the real call/data/control flow and current behavior.
2. Ask whether a change is actually required.
3. Prefer deleting obsolete behavior or reusing an existing project primitive.
4. Prefer a capability the current runtime/platform already provides.
5. Prefer the language standard library.
6. Prefer an already-installed dependency with the right semantics.
7. Add the smallest custom implementation that remains clear and testable.

Avoid abstractions with one speculative consumer, wrappers that only rename an API,
parallel systems that duplicate an existing authority, and configuration for hypothetical
future flexibility.

**Do not optimize away load-bearing requirements.** Minimalism never justifies removing
validation, safety checks, security boundaries, accessibility, observability, rollback,
evidence, tests, durable state, or required failure handling.

## Choose the work shape deliberately

```text
one coherent task, current context is sufficient
  -> work here

bounded independent question / fresh context helps
  -> native subagent when the harness provides it

long-lived peer, separate worktree, cross-agent collaboration
  -> xt pi|claude|codex + /multiplexing

role-shaped tracked work with native activation + settlement evidence lifecycle
  -> /using-specialists

deterministic mechanical transform or validation
  -> script/tool/runtime primitive rather than another reasoning agent
```

Parallelism is useful only when ownership boundaries are real.

## Before handing work to another agent

- Re-read the pinned Issue revision and current state; make the contract complete
  enough that the recipient needs no hidden context.
- State ownership and non-goals, exact validation/evidence, durable result location,
  and reply expectations through `/multiplexing` when coordination is required.
- Do not parallelize two workers on one surface without a defined ordering/merge owner.

## Inherited context

A handoff report, old Journal note, worker result, or prior assistant summary is a dated
lead, never authority. Confirm anything actionable against live state.
Re-derive expensive or irreversible facts before acting.

## Runtime enforcement

Do not duplicate deterministic runtime gates in prose or manually simulate them.
Depending on the installed runtime, XTRM may enforce or inject claim/edit/commit gates,
worktree boundaries, memory doctrine, compact restore, quality checks, GitNexus context,
inbox reminders, logging, and other lifecycle behavior.

Inspect the current runtime when exact behavior matters. Hooks/extensions are the
enforcement plane; skills are the judgment/procedure plane.

## Continuity: start, resume, hand off

Continuity is first-class: a session ending is normal; work disappearing with it is a failure.
Resume from durable Substrate state (Issue revision + checkpoint + Journal delta via
`sb issue resume`), never from compacted chat memory. Checklists and exact mechanics live in
`references/continuity.md`; command flags live in `references/surfaces.md` (`--help` wins on drift).

- **Cold start / takeover:** identify repo + branch; read the pinned Issue contract
  (revision + readiness/claim); check recent commits/PRs and live workers; correct
  stale inherited summaries against live state before planning.
- **Ownership map before edit/dispatch:** work item -> owner -> workspace/branch ->
  expected output -> blocker/reply state. Resolve ambiguity first; duplicate agents
  on one task are a race unless explicitly coordinated.
- **Long work:** arm continuation before a long phase (native goal/loop, peer ownership,
  Specialist job, monitor/wakeup, or human handoff). Verify the mechanism is armed.
- **Context pressure:** stop new large work while the next coherent phase still fits;
  persist facts/evidence, reconcile claim + branch + workers, record the next single
  action, hand off through a supported mechanism, verify the successor can resume.
- **Durable handoff:** contract revision + claim state, what changed + where,
  validation run (incl. failures/skips), active workers + expected returns, pending
  replies/decisions/blockers, re-verified facts, stale-assumption corrections,
  next single action, deliberate non-actions. Chat summary alone is not a handoff.
- **Stalled lanes:** distinguish still-computing / waiting-input / wakeup-not-armed /
  crashed / completed-unconsumed / obsolete-ownership; coordinate via `/multiplexing`.
- **Mechanics (Substrate-fidelity):** cut `sb journal checkpoint` with a real
  `--mechanical` row at resumability boundaries; `sb issue note` annotates while
  `sb journal append` records continuity (neither moves the revision); verify
  coordinator provenance with `sb provenance trace` before consuming worker output;
  close with `sb issue close --outcome … --reason … --result/--receipt/--validation`
  citing settlement evidence (Closure is immutable; reopen on mistake, never rewrite).

## Route to the focused skill

| Need | Skill |
|---|---|
| Cold start, takeover, context pressure, handoff, resume | `references/continuity.md` in this skill |
| Coordinate peers/subagents and replies/wakeups | `/multiplexing` |
| Build/promote contracts, decompose work, triage/test-plan | `/planning` |
| Debug regressions, review, test, verify, reduce complexity | `/engineering-quality` |
| Use supervised Specialist roles/jobs | `/using-specialists` |
| Explore code graph, callers/processes, blast radius | `/gitnexus` |
| Create or improve skills | `/skill-creator` |
| Find/import additional governed skills | `/find-skills` |
| Production/SRE investigation when pack is enabled | `/sre-ops` |

Load the focused skill when you reach that phase. Do not preload every manual.

## Completion rule

Before declaring work done, answer four questions with evidence:

1. Is the intended state actually present now?
2. Did the required validation run, and what did it show?
3. Is durable work state updated so the next participant sees reality?
4. Are there unresolved workers, replies, risks, or follow-ups that change the claim?

If any answer is unknown, report the unknown instead of converting it into success.