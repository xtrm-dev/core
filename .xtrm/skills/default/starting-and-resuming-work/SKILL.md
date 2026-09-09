---
name: starting-and-resuming-work
description: >
  Start, resume, take over, or hand off XTRM work without losing reality. Use whenever a
  session begins or resumes, the user says continue/pick up/catch up, an agent inherits
  another worker's task, work will outlive one context window, context usage is becoming
  unsafe, or a running lane appears stalled. Re-derive live state, identify the durable
  contract and current ownership, choose/verify a continuation mechanism, and hand off
  before context pressure makes the current agent unreliable.
---

# Starting and Resuming Work

Continuity is a first-class part of XTRM. A session ending is normal; work disappearing
with it is a failure.

## Cold start or takeover

Reconstruct reality from durable/live sources before making a new plan.

1. Identify the repository/worktree and current branch.
2. Read the active or referenced bead contracts and their current states.
3. Inspect recent relevant commits/PRs and validation when the task depends on them.
4. Inspect active XTRM workers/jobs/topology when other agents may still own work.
5. Compare inherited summaries with live state; correct stale claims before continuing.

Useful surfaces include `bd prime`, `bd ready`, `bd show`, `bd list`, `xt topology`, and
current runtime/worker status commands. Use live `--help` when exact syntax matters.

Do not mechanically run every command. Ask what fact you need, then use the cheapest
live source that answers it.

## Establish the current ownership map

Before editing or dispatching, know:

```text
work item -> current owner -> workspace/branch -> expected output -> blocker/reply state
```

If ownership is ambiguous, resolve it before creating another worker. Duplicate agents on
the same task are not redundancy; they are a race unless explicitly coordinated.

## Long work: prepare continuation early

If the work is likely to outlive this context, decide how it continues before starting a
long phase. Depending on the active harness this may be a native goal/loop/schedule,
XTRM peer ownership, a Specialist job, a monitor/wakeup facility, or an explicit human
handoff.

Do not assume a continuation primitive exists because an old skill mentioned it. Inspect
the current runtime and verify that the chosen mechanism is actually armed.

## Context-pressure rule

Treat context capacity as an execution resource.

When the remaining context is no longer comfortably sufficient for the next coherent
phase, stop starting new large work. Do this before summarization quality degrades.

```text
context pressure detected
  -> finish or stop at a clean boundary
  -> persist current facts/evidence
  -> reconcile bead + branch/worktree + running workers
  -> record next single action and unresolved decisions
  -> hand off or compact through a supported mechanism
  -> verify the successor/continuation can actually resume
```

Do not spend the last useful context budget trying to complete “one more phase” while the
handoff still exists only in your head.

## What a durable handoff contains

A successor should not need your transcript. Persist:

- the exact bead/work contract and current state;
- what changed and where the durable changes live;
- validation already run, including failures and skipped checks;
- active workers/jobs and what they are expected to return;
- pending replies/decisions/blockers;
- facts that were re-verified recently;
- corrections to stale earlier assumptions;
- the next single action;
- deliberate non-actions and why they remain deferred.

Use bead notes, checked-in docs/reports when appropriate, commits/branches, and runtime
state. A chat summary alone is not a handoff.

## Resume from a handoff

Do not trust completion labels blindly.

1. Read the handoff and contract.
2. Verify the branch/worktree and current diff.
3. Check whether referenced workers/jobs are still active or already produced results.
4. Re-run only the live checks that can have changed since the handoff.
5. Continue from the recorded next action if it is still valid; otherwise update the
   durable record before changing direction.

## Stalled work

Silence is not success. When a lane appears stalled, distinguish:

- worker still computing;
- worker waiting for input/reply;
- continuation/wakeup not armed;
- job failed/crashed;
- result completed but parent never consumed it;
- ownership changed and the lane is obsolete.

Use `/multiplexing` for peer/subagent coordination and `/using-specialists` for
Specialist-specific job evidence.

## Session close

A normal close is a handoff to the future, even when no other agent starts immediately.

- reconcile durable work state;
- verify no important result or reply is stranded;
- record validation truthfully;
- leave the repository/worktree in the intended lifecycle state;
- use the current `xt` reporting/end surfaces when they are part of the active workflow,
  checking live help rather than preserving old command recipes here.

The goal is not a ceremonial report. The goal is that the next participant can recover
correct state quickly and safely.