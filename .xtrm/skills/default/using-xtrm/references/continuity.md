# Continuity — checklists and mechanics

Companion to the `Continuity` section in `SKILL.md` (doctrine lives there; this file
holds checklists and exact mechanics). Command syntax drifts; `sb --help` /
`sb help <group> <verb>` is authoritative over anything quoted here.

## Cold start / takeover checklist

1. Identify repository/worktree and current branch (`git status`, `xt topology` when peers exist).
2. Read the active Issue contract at its pinned revision; check readiness/claim state
   (`sb issue ready`, `sb issue show <ref>`, `sb issue resume <ref>` for the capsule).
3. Inspect recent commits/PRs and validation when the task depends on them.
4. Inspect active workers/jobs/topology when other agents may still own work.
5. Compare inherited summaries with live state; correct stale claims before planning.
6. Do not run every surface mechanically — ask what fact is needed, then use the
   cheapest live source that answers it.

## Ownership map (before edit or dispatch)

```text
work item -> current owner -> workspace/branch -> expected output -> blocker/reply state
```

If ownership is ambiguous, resolve it before creating another worker. Duplicate agents
on the same task are a race unless explicitly coordinated.

## Long work: arm continuation early

If the work may outlive this context, decide how it continues before starting a long
phase: native goal/loop/schedule, peer ownership, Specialist job, monitor/wakeup, or
explicit human handoff. Do not assume a primitive exists because an old note named it —
inspect the current runtime and verify the mechanism is actually armed.

## Context-pressure checklist

```text
context pressure detected
  -> finish or stop at a clean boundary
  -> persist current facts/evidence
  -> reconcile Issue claim + branch/worktree + running workers
  -> record next single action and unresolved decisions
  -> hand off or compact through a supported mechanism
  -> verify the successor/continuation can actually resume
```

Do not spend the last useful context finishing "one more phase" while the handoff still
exists only in your head.

## Durable handoff checklist

Persist: exact contract (pinned revision) + readiness/claim state; what changed and where
it lives; validation run incl. failures/skips; active workers/jobs + expected returns;
pending replies/decisions/blockers; re-verified facts; stale-assumption corrections; the
next single action; deliberate non-actions and why deferred. Use `sb journal
append|checkpoint`, checked-in docs/reports, commits/branches, runtime state. A chat
summary alone is not a handoff.

## Resume-from-handoff checklist

1. Read the handoff and contract. 2. Verify branch/worktree and current diff.
3. Check whether referenced workers/jobs are still active or produced results
   (verify coordinator provenance first — see below). 4. Re-run only live checks that
   could have changed. 5. Continue from the recorded next action if still valid,
   else update the durable record before changing direction.

## Stalled-lane triage

Distinguish: still-computing / waiting-input / wakeup-not-armed / crashed /
completed-unconsumed / obsolete-ownership. Use `/multiplexing` for peer/subagent
coordination, `/using-specialists` for Specialist job evidence.

## Session close

A normal close hands off to the future even with no immediate successor: reconcile durable
state, verify no result/reply is stranded, record validation truthfully, leave the
worktree in the intended lifecycle state, use current `xt` reporting/end surfaces
(check live help, not old recipes). The goal is fast safe recovery, not ceremony.

## Mechanics A — mechanical checkpoint discipline

Cut a checkpoint at every resumability boundary (phase end, handoff, pre-compact):

```bash
sb journal checkpoint <ref> \
  --mechanical '{"rev": <n>, "head": "<sha>", "branch": "<name>"}' \
  --semantic '{"summary": "<one-line state>"}' \
  --branch <name> --head-commit <sha> --base-commit <sha>
```

Both rows are required: `--mechanical` carries revision + head SHA (machine-resumable);
`--semantic` carries the one-line human summary. A mechanical-only entry degrades
(`degraded: true`) — it records position without meaning. Verify with
`sb journal render <ref> --sequence <n>` (expect `MECHANICAL:` + `SUMMARY:` lines).

## Mechanics B — coordinator provenance verify loop

Before consuming delegated output, walk the evidence spine:

```bash
sb provenance trace <ref>        # bindings, receipts + artifacts, claims, closure
sb provenance receipt <rcp-id>   # one receipt: revision, contract hash, commit SHA
sb provenance bundle <ref>       # full spine walk
```

`allocate` creates the host-owned receipt for a binding (revision/hash copied from the
binding, never caller input); `bind <receipt-id> <sha>` links it to the commit carrying
the work (idempotent, never re-points). Never trust a "done" label — a terminal worker
state says execution stopped, not that the answer is correct.

## Mechanics C — issue-note vs journal-append delineation

- `sb issue note <ref> ["text"] --kind <note|finding|decision|blocker|milestone|handoff|result>`
  is the fast path into the Journal for one entry. Neither it nor `sb journal append`
  moves the revision or invalidates readiness — notes carry continuity, never authority.
- `sb journal append <ref> --kind <k>` is the same store with explicit payload flags
  (`--mechanical/--semantic/--result/--refs`). `--kind result` requires a bounded
  `--result` payload (`summary` required) in both spellings.
- A progress note or contract edit must never substitute for a result: meaningful
  settlement needs the bounded result payload that Closure cites. Never edit the Issue
  to narrate history — record in the Journal.

## Mechanics D — closure evidence-ref mechanics

```bash
sb issue close <ref> --outcome <completed|superseded|duplicate|wont_fix|invalid|cancelled|abandoned> \
  --reason "<why, in the Closure row — never only in git log>" \
  --result <journal-result-ref> --receipt <rcp-id> --validation <refs> --artifact <refs>
```

Pick the outcome honestly; cite settlement evidence (`--result` journal result refs,
`--receipt` provenance receipts, `--validation`/`--artifact` proof). Closure rows are
immutable — a mistaken close reopens, never rewrites. Stopping one execution is not a
close: release the claim (`sb issue release`) instead. `settled != published != closed`:
settlement is evidence; explicit Closure is authority.
