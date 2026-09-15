# Lane 5 — Identity, Contracts, Topology, Observability (Core → Substrate)

Read-only architecture audit. Scope: `packages/contracts/`, `cli/src/types/`, topology projection/views,
`xt-reports`, `launch-outcome`, logging hooks and their sources, worktree/session records, env propagation,
`docs/` topology/observability docs, `docs/runtime-compatibility.json`.

## Baselines verified in this session

| Repo | Ref | Evidence |
|---|---|---|
| Core worktree | `e3c09927f115a9ad551953ede2262c91a9bbb431` branch `xt/7awr` | `git rev-parse HEAD` in `/home/dawid/dev/core/.xtrm/worktrees/core-xt-pi-7awr` |
| Substrate snapshot | `/tmp/audit/xtrm-main` | `packages/substrate/src/domain/*.ts` read directly |
| Specialists snapshot | `/tmp/audit/specialists-master` | `src/activation/types.ts`, `src/specialist/chain-identity.ts` read directly |

All `path:line` citations below were read from source in this session. Statements not derived from a cited
line are labelled INFERENCE, RECOMMENDATION, or UNRESOLVED.

---

## (A) Identity inventory

Legend: Persistence ∈ {durable, ephemeral, derived}. Confidence ∈ {VERIFIED, INFERRED, OPEN}.
"Target primitive" names the upstream type that already exists at the cited location; Core does not
currently emit that type anywhere.

| Field | Producer (path:line) | Consumer(s) | Persistence | Current owner | Target identity | Target primitive | Evidence | Action | Hazard | Confidence |
|---|---|---|---|---|---|---|---|---|---|---|
| `bead_id` (pane opt `@agent_bead`) | `cli/src/utils/worktree-session.ts:1994`, `:2007` | `cli/src/core/topology-projection.ts:72,212,223`; `cli/src/core/topology-views.ts:128,145` | ephemeral (tmux pane option) | Beads / Core launcher | durable Issue ref | `Issue.id` + alias (`humanRef`/`locator`) | `/tmp/audit/xtrm-main/packages/substrate/src/domain/issue.ts:22-52,62-75` | REPLACE | Pane carries a *locator*, never a validated machine id; no alias→id resolution before consumption | VERIFIED |
| `bead_id` (env `XTMUX_AGENT_BEAD`) | `cli/src/utils/worktree-session.ts:2152-2159` | child runtime processes, scripts | ephemeral (process env) | Core launcher | durable Issue ref | as above; upstream env contract is `XTRM_SESSION_ID`/`XTRM_SESSION_NAME` only | `topology-projection.ts:76`; `/tmp/audit/xtrm-main/packages/substrate/src/domain/execution-context.ts:105-107` | REPLACE | Core propagates a tmux-shaped env family; upstream defines a different env pair — no bridge exists | VERIFIED |
| `bead_id` (contract field) | `packages/contracts/schemas/xtrm.topology.projection.v1.json`; `packages/contracts/src/types.ts` (`TopologyPaneAgent`, `TopologyJob`, `RuntimeOriginV1`, `XtmuxTopologyAgent`, `XtmuxMessageV1.beadId`, `AgentRoleLaunchedV1.bead`/`bead_id`) | same consumers as above | durable (contract) | Core contracts | durable Issue ref | `Issue.id` | `packages/contracts/src/types.ts` (`TopologyPaneAgent.bead_id`, `TopologyJob.bead_id`, `RuntimeOriginV1.bead_id`) | ADAPT | Contract freezes a Beads name into six payload types; renaming is a cross-repo break | VERIFIED |
| `beadId` (report row) | `cli/src/commands/report.ts:184` (`String(data.bead_id ?? '')`) | `cli/src/commands/report.ts:283` (report table) | ephemeral (rendered) | Core report | activation→issue link | `ActivationId` + issue ref | `cli/src/commands/report.ts:166-190` | ADAPT | Reads Specialists `status.json` directly; the row's `bead_id` is the only issue link in the row | VERIFIED |
| `planner_bead_id` | `cli/src/spec/apply-state.ts:8` | `cli/src/spec/reconcile.ts:65`; `cli/src/spec/dispatch.ts:23` (`sp run planner --bead`) | durable (apply-state file) | Core spec | durable Issue ref | `Issue.id` | `cli/src/spec/apply-state.ts:4-9` | REPLACE | Persisted Beads alias in a Core state file; no alias resolution on read | VERIFIED |
| `planner_job_id` | `cli/src/spec/apply-state.ts:9` | `cli/src/spec/reconcile.ts:43` (`sp result <id> --json`) | durable (apply-state file) | Core spec | activation ID | `ActivationId` | `/tmp/audit/specialists-master/src/activation/types.ts:22-23` ("Canonical runtime identity; maps to job_id") | ADAPT | Correct shape today, wrong name; must never become a durable Issue identity | VERIFIED |
| `job_id` | `cli/src/spec/dispatch.ts:31` (`sp run --json` → `job_id`); `cli/src/commands/merge.ts:167-193` | `topology-projection.ts:265`; `topology-views.ts:131,145-156`; `xtrm.branch.integration.v1` `source.job_id` | durable (Specialists DB) + ephemeral (snapshot) | Specialists | activation ID | `ActivationId` | `packages/contracts/schemas/xtrm.branch.integration.v1.json`; `cli/src/core/topology-projection.ts:265` | ADAPT | Specialists-owned vocabulary; Core must pass through uninterpreted (already documented at `topology-projection.ts:263-266`) | VERIFIED |
| `chain_id`, `chain_root_job_id`, `chain_root_bead_id`, `trace_id`, `span_id`, `parent_span_id` | Specialists: `/tmp/audit/specialists-master/src/specialist/chain-identity.ts:6-20` | `topology-projection.ts:268-272`; `topology-views.ts:136-156` | durable (Specialists) | Specialists | lineage/provenance refs | Specialists chain identity (pass-through) | `cli/src/core/topology-projection.ts:267-272` | KEEP | `chain_root_bead_id` embeds the Beads name in a chain identity | VERIFIED |
| `session_id` (tmux) | `topology-projection.ts:66` (`#{session_id}`); `cli/src/utils/worktree-session.ts:2164` | topology views; `XtmuxTopologySession.session_id` | ephemeral | xtmux/tmux | provider session id | `ExecutionContext.host.sessionId` | `cli/src/core/topology-projection.ts:66`; `execution-context.ts:44-47` | ADAPT | Distinct namespace from runtime thread id, same field name | VERIFIED |
| `session_id` (hook input, with cwd fallback) | `.xtrm/hooks/beads-gate-utils.mjs:31` (`input?.session_id ?? input?.sessionId ?? resolveCwd(input)`) | `beads-claim-sync.mjs`, `beads-*-gate.mjs`, `beads-gate-core.mjs:48`, `beads-status-cache.mjs` | ephemeral | Core hooks | session ID | `ExecutionContext.xtrmSessionId` | `.xtrm/hooks/beads-gate-utils.mjs:27-32` | REPLACE | **COLLAPSE**: a filesystem path becomes the session identity when the hook omits `session_id` | VERIFIED |
| `sessionId` (Pi extension, with PID fallback) | `packages/pi-extensions/extensions/beads/index.ts:13`; `packages/pi-extensions/extensions/session-flow/index.ts:18` (`?? process.pid.toString()`) | claim lookup, edit/stop gates | ephemeral | Core Pi extensions | session ID | `ExecutionContext.xtrmSessionId` | both files, cited lines | REPLACE | **COLLAPSE**: a PID becomes the session identity; key space mixes PID strings, UUIDs, `$N`, and paths | VERIFIED |
| `session_id` (logger column) | `.xtrm/hooks/xtrm-logger.mjs:22,26` (`events.session_id`) | `cli/src/commands/debug.ts:12,110-120,159-160,184,194` | durable (`.xtrm/debug.db`) | Core hooks | session ID | `ExecutionContext.xtrmSessionId` + `host.sessionId` split | `.xtrm/hooks/xtrm-logger.mjs:22`; `cli/src/commands/debug.ts:194` | REPLACE | One DB column holds ≥4 identity namespaces; `debug.ts:184` queries it with `LIKE '<s>%'` | VERIFIED |
| `session_name` | `worktree-session.ts:1796,1909,2118` (`pi-<slug>`, `role-<runtime>-<role>-<bead>`); `codex-worktree-session.ts:268-270` | topology views; `command-outcome.identity.session_name`; attach/resume | durable (tmux) + ephemeral | Core launcher | session display name | `ExecutionContext.xtrmSessionName` | `worktree-session.ts:2118`; `execution-context.ts:106` | ADAPT | **COLLAPSE**: session name encodes role and bead identity in a slug, and is used as the resume handle | VERIFIED |
| `thread_id` | `cli/src/core/launch-outcome.ts:174` (hardcoded `null`) | `command-outcome.identity.thread_id` consumers | ephemeral | Core dispatch | runtime agent session id | `SpecialistIdentity.agentSessionId` | `cli/src/core/launch-outcome.ts:172-177`; `execution-context.ts:60-65` | ADAPT | Field is dead (always `null`) yet is the only slot that would hold the runtime session | VERIFIED |
| `instance_id` / `agent_instance_id` | `packages/contracts/schemas/xtrm.agent-role-launched.v1.json`; `xtrm.runtime-origin.v1.json`; pane opt `@agent_instance_id` (`topology-projection.ts:76`) | topology views; runtime-origin records | ephemeral + durable (record) | xtmux/Core | provenance ref | no upstream analogue | `packages/contracts/src/types.ts` (`XtmuxTopologyAgent.instance_id`, `RuntimeOriginV1.agent_instance_id`) | COMPAT | Not representable upstream; must stay a compat alias beside `ExecutionBinding.id` | INFERRED |
| `parent_session_id` / `parent_pane_id` | `worktree-session.ts:1990` (`@agent_parent_session`), `:2157` | `topology-projection.ts:72,75,224-226`; `xtrm.runtime-origin.v1`; `xtrm.xtmux.topology.v1` | ephemeral (pane option/env) | Core launcher | coordinator session | `ExecutionContext.coordinator.sessionId` | `worktree-session.ts:1990`; `execution-context.ts:51-58` | ADAPT | **COLLAPSE**: the same field name carries tmux pane lineage in xtmux contracts and coordinator lineage here | VERIFIED |
| `participant` / `participantId` | *(none — zero occurrences in Core source)* | — | — | — | participant (role) | `ParticipantId`, `ExecutionContext.participantId` | grep over `cli/src`, `packages/`, `.xtrm/` found hits only in `docs/`, `.xtrm/skills/`; `/tmp/audit/specialists-master/src/activation/types.ts:19-20` | REPLACE | **COLLAPSE-adjacent**: the role/participant leg of the identity model does not exist in Core at all | VERIFIED |
| `activationId` | *(none — zero occurrences in Core source)* | — | — | — | activation ID | `ActivationId`, `IssueClaim.activationId`, `WorkspaceLease.activationId` | grep; `claim.ts:32-40,55-64`; `execution-binding.ts:14-30` | REPLACE | Core has `job_id` for this fact but no activation concept; lease/claim anti-steal cannot be expressed | VERIFIED |
| `attemptId` | *(none — zero occurrences in Core source)* | — | — | — | attempt ID | `AttemptId`, `SpecialistIdentity.attemptId` | grep; `/tmp/audit/specialists-master/src/activation/types.ts:25-31` | REPLACE | Retry-vs-second-worker distinction is unrepresentable in Core today | VERIFIED |
| `claimId` | `packages/pi-extensions/extensions/session-flow/index.ts:24` (`claimResult.stdout.trim()` of `bd kv get claimed:<sessionId>`); `.xtrm/hooks/beads-gate-core.mjs:69-74` | stop gate (`session-flow/index.ts:74-84`); commit/edit gates | ephemeral (derived from `bd kv`) | Core hooks | claim row | `IssueClaim.id` (integer) + `generation` | `session-flow/index.ts:21-25`; `/tmp/audit/xtrm-main/packages/substrate/src/domain/claim.ts:31-41` | REPLACE | **NAMESPACE COLLISION**: Core `claimId` holds an *issue id string*; upstream `IssueClaim.id` is an integer claim-row id | VERIFIED |
| `claimed:<sessionId>` (bd kv key) | `.xtrm/hooks/beads-claim-sync.mjs:80-85`; `packages/pi-extensions/extensions/beads/index.ts:20-27,145-151` | every claim gate; `session-flow`; `beads-gate-core.mjs:57-84` | durable (`bd kv`) | Beads | claim authority | `IssueClaim{holder, activationId, generation, expiresAt}` | `.xtrm/hooks/beads-gate-utils.mjs:35-45`; `claim.ts:12-19` | REPLACE | **COLLAPSE**: claim ownership keyed by session, no claim id, no generation, no TTL (`claim.ts:12-18` requires all three) | VERIFIED |
| `closed-this-session:<sessionId>` | `packages/pi-extensions/extensions/beads/index.ts:161` | Pi beads extension | durable (`bd kv`) | Beads | closure record | `Closure` + `ClosureAttempt` | `/tmp/audit/xtrm-main/packages/substrate/src/domain/closure.ts:41-56,80-96` | REPLACE | Closure outcome/reason/actor/revision not recorded; only "this session closed X" | VERIFIED |
| `in_progress` (Beads status as claim proxy) | `.xtrm/hooks/beads-gate-utils.mjs:54-73` (`bd list --status=in_progress`); `beads-gate-core.mjs:75`; `session-flow/index.ts:29-42` | edit/commit/stop gates | derived from Beads store | Beads | claim state | derived from live `IssueClaim` row | `.xtrm/hooks/beads-gate-utils.mjs:54-73`; `claim.ts:16-18` ("Claimed/in-progress is derived from a live claim row, never a stored flag on the issue") | REPLACE | Second authority over claim state that upstream explicitly forbids | VERIFIED |
| `close_reason` | `cli/src/commands/report.ts:66,112,242`; `cli/src/commands/end.ts:414` | report tables; end-of-session summary | ephemeral (rendered) | Beads | closure reason/outcome | `Closure.outcome` + `Closure.reason` | `cli/src/commands/report.ts:112`; `closure.ts:57-77` | REPLACE | Free text with no bounded outcome; upstream `CLOSURE_OUTCOMES` is a closed set | VERIFIED |
| `issue_id` (logger column) | `.xtrm/hooks/xtrm-logger.mjs:26` (`events.issue_id`) | `cli/src/commands/debug.ts:18,148,194` | durable (`.xtrm/debug.db`) | Core hooks | durable Issue ref | `Issue.id` | `.xtrm/hooks/xtrm-logger.mjs:20-33`; `cli/src/commands/debug.ts:194` | ADAPT | Column is untyped: callers pass Beads aliases (`logEvent({issueId})` in `beads-gate-*.mjs`) | VERIFIED |
| `issue_id` (Beads export edge/summary) | `cli/src/core/substrate-verify.ts:39-45` (`BeadsExportEdge.issue_id`, `BeadsExportSummary.issueIds`) | `substrate-verify.ts:125-172,236-249` | ephemeral (parse of `bd export`) | Beads | Beads alias | alias `kind:'beads'` → `Issue.id` | `cli/src/core/substrate-verify.ts:39-45`; `substrate-verify.ts:333-341` (`alias.kind !== 'beads'` filter) | COMPAT | Correctly treated as an alias in the verify path; the same string is *identity* elsewhere | VERIFIED |
| `issueId` (session state file) | `.xtrm/packages/pi-extensions/src/core/session-state.ts:13` (`SessionState.issueId`) | `readSessionState` consumers; `.xtrm-session-state.json` | durable (`.xtrm-session-state.json`) | Core Pi extensions | durable Issue ref | `Issue.id` | `.xtrm/packages/pi-extensions/src/core/session-state.ts:13,31,41` | REPLACE | **COLLAPSE**: same field name as `SubstrateAliasEntry.issueId` (`substrate-verify.ts:60`) which holds `iss_...`; here it holds a Beads alias | VERIFIED |
| `IssueState.phase` (`claimed`/`merged`/…) | `.xtrm/packages/pi-extensions/src/core/session-state.ts:3-10` | session-flow extension | durable (`.xtrm-session-state.json`) | Core Pi extensions | — | `LifecycleState` + `Closure` (upstream has no counterpart phase machine) | `.xtrm/packages/pi-extensions/src/core/session-state.ts:3-10` | DELETE | **Second authority**: `claimed` duplicates claim state, `merged` duplicates Git/PR truth | VERIFIED |
| `projectId` | `cli/src/core/substrate.ts:181-195,243-248` (`sb doctor --json` link, `sb create-project`) | `cli/src/core/substrate-verify.ts:330` (`sb export project --project <id>`) | derived from Substrate | Substrate | project machine ID | `Project.id`, `Issue.projectId` | `cli/src/core/substrate.ts:174-195`; `/tmp/audit/xtrm-main/packages/substrate/src/domain/issue.ts:13-31` | KEEP | Already the correct shape; Core persists nothing | VERIFIED |
| `worktree` / `worktreePath` / `worktree_path` / `@agent_worktree` | `worktree-session.ts:1994,1825,2157`; `codex-worktree-session.ts:194` | `topology-projection.ts:73,224,273,388-400,428-460`; `xtrm.topology.projection.v1`; reap | durable (filesystem) + ephemeral (pane opt) | Core | workspace | `WorkspaceIdentity{repositoryRoot, gitCommonDir, worktreePath, branch}`, `WorkspaceLease` | `claim.ts:34-39,55-64`; `topology-projection.ts:273` | ADAPT | No `repositoryRoot`/`gitCommonDir` recorded in the projection; lease generation absent | VERIFIED |
| `worktree` (logger, regex-derived) | `.xtrm/hooks/xtrm-logger.mjs:73-74` (`cwd.match(/\.xtrm\/worktrees\/([^/]+)/)`) | `cli/src/commands/debug.ts:194` | durable (`.xtrm/debug.db`) | Core hooks | workspace | `ExecutionContext.workspace.worktree` | `.xtrm/hooks/xtrm-logger.mjs:73-74` | ADAPT | Derived by path regex, so it is `null` for main-repo sessions and breaks on path-convention change | VERIFIED |
| `repositoryRoot` / `gitCommonDir` / `repositoryKey` / `repoPath` | `worktree-session.ts:2168` (`gitRepoRoot`); `codex-worktree-session.ts:189-190` | worktree creation/rollback | derived | Core | repository identity | `WorkspaceIdentity.repositoryRoot`; `ExecutionContext.workspace.repositoryKey` | `claim.ts:34-39`; `execution-context.ts:67-74` | ADAPT | `repositoryKey` has no Core counterpart at all | VERIFIED |
| `run_id` / `runId` | *(none in Core source; `run_id` only in `skills/skill-creator/SKILL.md`)* | — | — | — | run ID | `ExecutionContext.runId`, `chainRunId`, `MechanicalCheckpoint.runId` | grep; `/tmp/audit/xtrm-main/packages/substrate/src/domain/execution-context.ts:76-84`; `journal.ts:48` | REPLACE | Absent; coordinator run lineage cannot be expressed | VERIFIED |
| `container_id` | *(none)* | — | — | — | — | — | grep over whole worktree: 0 hits | KEEP (N/A) | — | VERIFIED |
| `identity` block (`command-outcome`) | `cli/src/core/launch-outcome.ts:172-177` | `xtrm.command-outcome.v1` consumers | ephemeral | Core CLI | execution binding | `ExecutionBinding` + `ExecutionContext` | `cli/src/core/launch-outcome.ts:172-177`; `execution-binding.ts:14-30` | ADAPT | **COLLAPSE**: `{thread_id, session_name, tmux_session_id, pane_id}` — no issue, participant, activation, attempt, or claim | VERIFIED |
| `worktree.owner: 'core'` | `cli/src/core/launch-outcome.ts:178` (literal) | `command-outcome` consumers | ephemeral | Core | mutation authority | `WorkspaceLease.holder` + `activationId` | `cli/src/core/launch-outcome.ts:178`; `claim.ts:55-64` | REPLACE | Hardcoded constant claims writer authority; no lease, holder, or generation behind it | VERIFIED |

### Identity collapses — explicit list

| # | Collapse | Evidence | Severity |
|---|---|---|---|
| C1 | `session_id`/`sessionId` mixes ≥4 namespaces: tmux `$N`, runtime thread UUID, Pi PID string, filesystem cwd path | `beads-gate-utils.mjs:31`, `session-flow/index.ts:18`, `beads/index.ts:13`, `topology-projection.ts:66` | HIGH — same-namespace claim collision across sessions |
| C2 | `claimId` in Core = issue id string; upstream `IssueClaim.id` = integer claim-row id | `session-flow/index.ts:24`, `beads-gate-core.mjs:69-74` vs `claim.ts:31-41` | HIGH — silent type/namespace collision on a name that will be reused |
| C3 | `claimed:<sessionId>` encodes claim ownership as a KV key: no claim row id, no `generation`, no `expiresAt`, no `activationId`; Beads `in_progress` is a second, independent claim flag | `beads-claim-sync.mjs:80-85`, `beads-gate-utils.mjs:54-73` vs `claim.ts:12-19` | CRITICAL — two competing claim authorities, neither with expiry/anti-steal |
| C4 | `issueId` means a Beads alias in `.xtrm-session-state.json` and a Substrate `iss_...` machine id in `SubstrateAliasEntry` | `session-state.ts:13` vs `substrate-verify.ts:60` | HIGH — alias and machine id indistinguishable at the type level |
| C5 | Pane's single `@agent_bead` slot carries either the job's issue or its epic | `topology-projection.ts:471-477` (`job.bead_id === paneBeadId \|\| job.epic_id === paneBeadId`) | MEDIUM — issue and epic identities share one field |
| C6 | Role identity encoded twice: `agentTask: 'role:<name>'` (and `'session:<slug>'`) as a string prefix, plus a separate `@agent_role` option | `worktree-session.ts:2053,2097,2010-2011,1996` | MEDIUM — two encodings of one fact, drifting |
| C7 | `xtrm.agent-role-launched.v1` is an open `k=v` bag with `instance`/`instance_id`, `session`/`session_id`/`session_name`, `pane`/`pane_id`, `bead`/`bead_id`, `parent`/`parent_session` | `packages/contracts/schemas/xtrm.agent-role-launched.v1.json`; `types.ts` `AgentRoleLaunchedV1` | HIGH — ten names, four identities, no validation |
| C8 | `parent_session` = upstream `coordinator.sessionId`; the same name is also tmux pane lineage in xtmux contracts | `worktree-session.ts:1990` vs `execution-context.ts:51-58`, `xtrm.runtime-origin.v1` `parent_session_id` | MEDIUM |
| C9 | Work identity leaks into the session namespace: the beads alias is slugified into the tmux session name | `worktree-session.ts:2018-2020`; `codex-worktree-session.ts:268-270` | MEDIUM — an Issue ref becomes part of a resume handle |
| C10 | `@agent_state` has two writers — launcher writes `'idle'` at spawn, the runtime's own hook overwrites it | `worktree-session.ts:2112,2142-2145` | MEDIUM — lifecycle signal with no single owner |
| C11 | `command-outcome.identity` carries pane/tmux/session only; `worktree.owner` is the hardcoded literal `'core'` | `launch-outcome.ts:172-178` | HIGH — authority asserted by constant |
| C12 | `bead` doubles as the worktree/session slug source *and* the work identity; `planner_bead_id` and `planner_job_id` are persisted side by side with no linkage guarantee | `worktree-session.ts:2018`; `cli/src/spec/apply-state.ts:8-10` | MEDIUM |

---

## (B) Contract inventory

`packages/contracts` ships 18 schemas. `SCHEMA_ID` (`src/types.ts:5-24`), ajv registry (`src/validate.ts:6-49`),
and fixture coverage (`test/contracts.test.ts:13-50`) are structurally sound: schema set must exactly equal
`SCHEMA_ID`, and every schema must have a golden and an invalid fixture. That soundness is *implemented*
(VERIFIED) — but the test can only prove internal consistency, not correctness of the identity vocabulary.

| Schema/symbol | Path | What it asserts | Second authority? | Target | Evidence | Action | Confidence |
|---|---|---|---|---|---|---|---|
| `xtrm.beads.lifecycle-event.v1` (`BeadsLifecycleEventV1`) | `schemas/xtrm.beads.lifecycle-event.v1.json`; `src/types.ts:139-160` | A Beads-originated lifecycle event: `source:'beads.events'`, `issue_id` (Beads alias), `event_type ∈ {created,claimed,updated,closed,reopened,status_changed}`, raw `old_value`/`new_value`, `timestamp_source:'uuidv7'` | **YES** — asserts Issue lifecycle and claim/close events, which Substrate owns (`IssueEvent`, `Closure`, `ClosureAttempt`) | Substrate `IssueEvent` + `Closure` + `ClosureAttempt` | schema file; `src/types.ts:139-160`; test at `test/contracts.test.ts:52-78`; `/tmp/audit/xtrm-main/packages/substrate/src/domain/closure.ts:41-96`, `issue.ts:45-54` | **DELETE** (after a COMPAT window) | VERIFIED |
| `xtrm.agent-role-launched.v1` (`AgentRoleLaunchedV1`) | `schemas/xtrm.agent-role-launched.v1.json`; `src/types.ts:295-310` | Open `k=v` "loose field bag" for launch metadata; all fields optional strings | Partial — the *de facto* launch identity record, replacing nothing | `ExecutionBinding` + `ExecutionContext` | schema; `src/types.ts:295-310`; `execution-binding.ts:14-30` | **REPLACE** | VERIFIED |
| `xtrm.command-outcome.v1` (`CommandOutcomeV1`) | `schemas/xtrm.command-outcome.v1.json`; `src/types.ts:92-123` | CLI result envelope: `status ∈ {ok,degraded,noop,rejected,failed}`, `reason_code`, `identity{thread_id,session_name,tmux_session_id,pane_id}`, `worktree{path,branch,owner:'core'}`, `readiness`, `safety_profile`, `authoritative_mutation`, `side_effects`, `next_actions` | Partial — `authoritative_mutation` and `worktree.owner:'core'` assert mutation authority Core does not hold under a lease model | `ExecutionBinding`-shaped identity; retain status/reason/side-effects vocabulary | schema; `src/types.ts:92-123`; `cli/src/core/launch-outcome.ts:158-213` | **ADAPT** | VERIFIED |
| `xtrm.runtime-origin.v1` (`RuntimeOriginV1`) | `schemas/xtrm.runtime-origin.v1.json`; `src/types.ts:131-146` | xtmux agent-instance origin: `kind:'xtmux.agent_instance'`, `host_id`, `tmux_server_id/session/window/pane`, `agent_instance_id`, `bead_id`, `parent_session_id`, `capture_source`, `verified:boolean` | Partial — `verified` + `capture_source` claim verification authority; `bead_id` duplicates Issue ref | provenance ref → `ExecutionBinding` projection | schema; `src/types.ts:131-146`; `provenance.ts` ("never reconstructed from executor prose") | **ADAPT** | VERIFIED |
| `xtrm.branch.integration.v1` (`BranchIntegrationV1`) | `schemas/xtrm.branch.integration.v1.json`; `src/types.ts:148-158` | `{source:{job_id,branch,worktree}, target:{branch,worktree,role?}, status:'merged', commit}` | **YES** — a stored `status:'merged'` where Git/PR is the authority | keep as a provenance *event*; `job_id` → `ActivationId`; drop `status` as truth | schema; `src/types.ts:148-158` | **ADAPT** | VERIFIED |
| `xtrm.topology.projection.v1` (`TopologyProjectionV1`) | `schemas/xtrm.topology.projection.v1.json`; `src/types.ts:315-370` | Read-only join snapshot: `host`, `sources` (exactly 6, one per owning system), `panes[]` (with `agent`), `orphans` | **No** — explicitly a per-invocation read model; "no field is authoritative over its source" | read model; sources must gain `substrate`, `enums` tightened | schema `description`; `cli/src/core/topology-projection.ts:5-24,85-99` | **ADAPT** | VERIFIED |
| `xtrm.interactive-role-envelope.v1` (`InteractiveRoleEnvelopeV1`) | `schemas/xtrm.interactive-role-envelope.v1.json`; `cli/src/types/interactive-role-envelope.ts:12-52` | Core⇄Specialists role boundary: `role`, `systemPrompt`, `skillPaths`, optional `model`/`thinkingLevel`/`interactive` | No | KEEP as a boundary contract | `cli/src/types/interactive-role-envelope.ts`; schema | **KEEP** | VERIFIED |
| `xtrm.specialist-role-envelope.v1` (`SpecialistRoleEnvelopeV1`) | `schemas/xtrm.specialist-role-envelope.v1.json`; `src/types.ts:312-323` | "Legacy '1', passthrough/open" role definition | No | superseded by `xtrm.interactive-role-envelope.v1` | `src/types.ts:312-323`; `docs/runtime-compatibility.json` `contracts.specialist_role_envelope: "1"` | **DELETE** after cutover | VERIFIED |
| `xtrm.runtime-compatibility.v1` (`RuntimeCompatibilityV1`) | `schemas/xtrm.runtime-compatibility.v1.json`; `docs/runtime-compatibility.json` | Core's version window vs Specialists/xtmux/node, plus a `contracts` id map | No | KEEP; must add Substrate to `core.requires` and to `contracts` | `docs/runtime-compatibility.json` (`requires` has no `substrate` key) | **ADAPT** | VERIFIED |
| `xtrm.pi-extension-manifest.v1` | schema; `src/types.ts:64-68` | Active/disabled pi-extension manifest | No | KEEP | schema | **KEEP** | VERIFIED |
| `xtrm.command-deprecations.v1` | schema; `src/types.ts:70-83` | Deprecated command → replacement map | No | KEEP | schema | **KEEP** | VERIFIED |
| `xtrm.runtime-matrix.v1` | schema; `src/types.ts:125-134` | Per-repo runtime (node/bun) minimums | No | KEEP; add a Substrate block | schema (`core`/`xtmux`/`specialists`/`consumers` only) | **ADAPT** | VERIFIED |
| `xtrm.xtmux.topology.v1` | schema; `src/types.ts:162-206` | xtmux topology snapshot: sessions/windows/panes, `bead_id`, `instance_id` | No (owning system is xtmux) | KEEP read model; `bead_id` → compat alias | schema; `topology-projection.ts:236-256` | **COMPAT** | VERIFIED |
| `xtrm.xtmux.message.v1` | schema; `src/types.ts:208-236` | Inter-agent message with `senderId`/`recipientId`/`beadId`, ack and reply correlation | No | KEEP; `beadId` → issue ref compat alias | schema; `src/types.ts` (`XtmuxMessageV1.beadId`) | **COMPAT** | VERIFIED |
| `xtrm.xtmux.obligation.v1` | schema; `src/types.ts:238-252` | Outstanding reply obligation | No | KEEP | schema | **KEEP** | VERIFIED |
| `xtrm.xtmux.monitor.v1` | schema; `src/types.ts:254-271` | Monitor state, `sessionId`, `paneId`, `state: string` (unbounded) | No | KEEP; bound `state` | schema; `src/types.ts:254-271` | **ADAPT** | INFERRED |
| `xtrm.xtmux.wait.v1` | schema; `src/types.ts:273-292` | Wait primitive, `state: string` (unbounded), `intervalMs: null` | No | KEEP; bound `state` | schema; `src/types.ts:273-292` | **ADAPT** | INFERRED |
| `xtrm.xtmux.bridge.v1` | schema; `src/types.ts:294-306` | Bridge request/response with methods incl. `journal.query`, `journal.follow` | **YES (risk)** — a bridge-mediated journal query bypasses Substrate Journal authority | route journal reads through Substrate; keep transport shape | `src/types.ts:294-306` (`XtmuxBridgeRequest.method`) | **ADAPT** | VERIFIED |
| `src/validate.ts` / `src/index.ts` registry | `packages/contracts/src/validate.ts`, `src/index.ts` | ajv load-all + typed guard; `uuidV7TimestampMs` decodes the path in *Beads* event ids | No | KEEP; `uuidV7TimestampMs` follows the event contract | `src/validate.ts:36-44`; `test/contracts.test.ts:73-77` | **KEEP** | VERIFIED |

### Beads-shaped contracts (explicit list)

1. `xtrm.beads.lifecycle-event.v1` — Beads-named by id and by every field.
2. `xtrm.runtime-origin.v1` — `bead_id`.
3. `xtrm.topology.projection.v1` — `bead_id`, `epic_id`, `chain_root_bead_id`, `bead.status`.
4. `xtrm.xtmux.topology.v1` — `bead_id`.
5. `xtrm.xtmux.message.v1` — `beadId`.
6. `xtrm.agent-role-launched.v1` — `bead`, `bead_id`.
7. `xtrm.branch.integration.v1` — `source.job_id` (Specialists job row), `target.role`.
8. `src/validate.ts` `uuidV7TimestampMs` — documents the *Beads* uuidv7 identity path.

### Schemas that would become second authorities over Substrate / ChainRuntime / Specialists state

| Schema | Over which system | Why | Correct target |
|---|---|---|---|
| `xtrm.beads.lifecycle-event.v1` | Substrate | Duplicates `IssueEvent` + `Closure` + `ClosureAttempt` with a different vocabulary and a Beads alias as identity | `IssueEvent`, `Closure` |
| `xtrm.branch.integration.v1` | Substrate + Git/GitHub | Stores `status:'merged'` as truth; `topology-views.ts:12-13` names `pull_request.merged_at` as the authoritative signal | provenance event only; `WorkReceipt`/`ArtifactBinding` |
| `xtrm.xtmux.bridge.v1` (journal methods) | Substrate | A non-Substrate path answering journal queries | Substrate Journal read surface |
| `xtrm.command-outcome.v1` (`authoritative_mutation`, `worktree.owner`) | Substrate | Asserts mutation authority with no lease/holder/generation behind it | `WorkspaceLease` |
| `xtrm.runtime-origin.v1` (`verified`) | Substrate | Claims verification the host owns | `ExecutionBinding` + host-side validation |
| `SessionState.phase` (not a schema; `.xtrm-session-state.json`) | Substrate + Git | `claimed`/`merged` phases duplicate claim and Git truth | `LifecycleState` + `Closure`; derive `merged` from PR/Git |

---

## 4. Topology projection / views

**Verdict: read model, not a second authority. VERIFIED.**

Evidence:
- `cli/src/core/topology-projection.ts:5-24` states the non-goal ("do not persist a duplicate mutable graph")
  and the mechanism: `collectProjection()` is a pure function of the world plus a command runner, with no store.
- `cli/src/core/topology-projection.ts:85-99` (`READ_ONLY_COMMANDS`) is the only argv source; the comment at
  `:31-37` and the test reference (`cli/src/tests/topology-projection.test.ts`) make "never mutates" structural.
- `cli/src/core/topology-views.ts:4-13` restricts views to pure renderers and names the only completion signals
  (`bead.status`, `pull_request.merged_at`/`state`, `job.status`), explicitly excluding `agent.state`.

Two defects make the *view* re-impose Beads semantics even though the projection itself is read-only:
- `cli/src/core/topology-projection.ts:91` reads `bd list --all --json` as the `beads` source.
- `cli/src/core/topology-views.ts:83-87` treats `pane.bead.status === 'closed'` as a completion signal.

**What must feed it after cutover** (RECOMMENDATION):
1. Replace the `beads` source with a `substrate` source. Core today knows only `sb export project --project <id> --json`
   and `sb doctor --json` (`cli/src/core/substrate.ts:153,186`); the projection needs an equivalent bulk
   *read* surface for Issues/claims/bindings. Do not read Substrate's SQLite: `topology-projection.ts:20-24`
   gives the standing reason (private schema, native sqlite dependency).
2. Extend `TopologySourceName` (`packages/contracts/src/types.ts:317`) with `'substrate'` and update the schema's
   `minItems: 6`/`maxItems: 6` `contains` list, which currently hard-codes exactly `xtmux, tmux, specialists, beads, git, github`.
3. `TopologyPaneAgent.bead_id` → issue ref; add `participant`, `activation_id`, `attempt_id` from the pane lineage
   leg (today only role/task/bead/worktree/branch/parent exist).
4. `TopologyJob.bead_id`/`epic_id` → issue refs; `job_id` stays the ActivationId.
5. Completion signal becomes Substrate `LifecycleState`/`Closure` plus `pull_request.merged_at`. `bead.status`
   is deleted, not aliased.

---

## 5. Observability

### Beads-shaped labels, ids, and status values today

| Surface | Beads-shaped element | Evidence |
|---|---|---|
| `.xtrm/debug.db` `events` table | `issue_id` column; `kind` values `bd.claimed`-shaped; `session_id` holding ≥4 namespaces; `worktree` derived by path regex | `.xtrm/hooks/xtrm-logger.mjs:20-33,73-74` |
| `xtrm-debug` CLI view | selects/queries `session_id`, `issue_id` columns | `cli/src/commands/debug.ts:12,18,184,194` |
| gate hooks | `claimed:<sessionId>` KV keys; `closed-this-session:<sessionId>`; `bd list --status=in_progress` as claim probe | `.xtrm/hooks/beads-gate-utils.mjs:35,57,73`; `beads-claim-sync.mjs:80-85`; `packages/pi-extensions/extensions/beads/index.ts:145-151,161` |
| status cache / statusline | counts keyed by `open`/`in_progress`/`blocked` | `.xtrm/hooks/beads-status-cache.mjs:144-150` |
| Session state file | `phase: claimed` | `.xtrm/packages/pi-extensions/src/core/session-state.ts:3-10` |
| Prometheus guardrail | forbidden-label list already names `job_id`, `bead_id`, `chain_id`, … | `docs/observability/prometheus-labels.md:14-27` |

`docs/observability/prometheus-labels.md:31-38` already defines the allowed low-cardinality label set
(role, runtime, outcome, phase, env/tier). RECOMMENDATION: keep that set unchanged, map `role` →
`participant`, and keep `issue`/`activation`/`attempt`/`session` out of labels exactly as the doc requires.
The doc's forbidden list is *correct and needs no change*; its `bead_id` entry becomes `issue_ref`.

### Status / enum values that must change

| Enum | Current values | Location | Required post-cutover |
|---|---|---|---|
| Beads Issue status | `open`, `in_progress`, `blocked`, `closed` | consumed at `topology-projection.ts:296`, `beads-gate-utils.mjs:57-73`, `beads-status-cache.mjs:144-150`; emitted in `bd` output | Substrate `LifecycleState` = `open\|deferred\|done\|cancelled\|archived` (`/tmp/audit/xtrm-main/.../issue.ts:8`) + derived `OperationalState` = `terminal\|deferred\|draft\|blocked\|claimed\|ready` (`readiness.ts:81`) |
| `blocked` | Beads stored status | `beads-status-cache.mjs:144-150` | Substrate-derived only (`readiness.ts:117-141`); must not be stored |
| `in_progress` | Beads stored status used as claim proxy | `beads-gate-utils.mjs:57-73` | derived from a live `IssueClaim` row only (`claim.ts:16-18`) |
| `xtrm.beads.lifecycle-event.v1.event_type` | `created\|claimed\|updated\|closed\|reopened\|status_changed` | `schemas/…`, `types.ts:139` | `IssueEvent.type` + `Closure.outcome ∈ {completed,superseded,duplicate,wont_fix,invalid,cancelled,abandoned}` (`closure.ts:23-31`) |
| `xtrm.beads.lifecycle-event.v1.source` | `'beads.events'` | schema | `Closure.source ∈ {'sb','beads'}` (`closure.ts:39`) as a *migration marker only* |
| `xtrm.beads.lifecycle-event.v1.timestamp_source` | `'uuidv7'` | schema | Substrate issue/event timestamps (`issue.ts:31-32`, `IssueEvent.id:number`) |
| `SessionState.phase` | `claimed\|phase1-done\|waiting-merge\|conflicting\|pending-cleanup\|merged\|cleanup-done` | `packages/pi-extensions/src/core/session-state.ts:3-10` | no upstream counterpart; `claimed` and `merged` must be deleted, remaining phases become derived/UI-local |
| `xtrm.runtime-origin.v1.kind` | `'xtmux.agent_instance'` | schema | retain as xtmux provenance kind; add `ExecutionBinding` beside it |
| `TopologyJob.status` | Specialists-owned pass-through | `topology-projection.ts:266` | KEEP pass-through (`Activation` state) |
| `BeadsLifecycleEventType` in `types.ts` | mirrors the schema | `src/types.ts:139` | delete with the schema |

### Correct identity set after cutover

Issue machine ID `iss_<uuidv7>` → durable Issue ref/locator (+ aliases incl. `kind:'beads'`) → `IssueRevision
{issueId, revision, contractHash}` → `ExecutionBinding exb_<uuidv7>{participantId, activationId, attemptId,
sessionId, workspace, baseCommit, claimId}` → `IssueClaim{id:int, generation, holder, activationId, expiresAt}`
/ `WorkspaceLease{id:int, generation}` → `ActivationId` (= Specialists `job_id`) → `AttemptId` → Pi AgentSession
id (correlation metadata only) → `Closure clo_<uuidv7>` / `ClosureAttempt{id:int}` → `WorkReceipt rcp_<uuidv7>`
/ `ProvenanceBundle bnd_<uuidv7>` / `JournalEntry jrn_<uuidv7>`; plus `Project{id,prefix}`, `ActorIdentity{type,id,name}`,
`ExecutionHost{type,sessionId}`, `ExecutionCoordinator{participantId,sessionId}`, `ParticipantId` (role, stable
across activations).

`participant != activation != attempt != AgentSession != Issue` is enforced upstream at
`/tmp/audit/specialists-master/src/activation/types.ts:19-34` and mirrored in `ExecutionBinding`
(`execution-binding.ts:14-30`, "Executor-supplied fields (participant/attempt/session) are recorded as observed
labels, never as authority") and `ExecutionContext` (`execution-context.ts:39-84`).

---

## Surfaces searched

- `packages/contracts/**` (all 18 `schemas/*.json`, `src/{types,index,validate}.ts`, `fixtures/{golden,invalid}.json`, `test/contracts.test.ts`, `README.md`)
- `cli/src/types/{config,models,interactive-role-envelope}.ts`
- `cli/src/core/{topology-projection,topology-views,xt-reports,launch-outcome,substrate,substrate-verify,substrate-migration,worktree-reap}.ts`
- `cli/src/commands/{topology,report,end,debug,merge,worktree,init,doctor}.ts`
- `cli/src/spec/{apply-state,reconcile,dispatch}.ts`
- `cli/src/utils/{worktree-session,codex-worktree-session,env-manager,known-repos}.ts`
- `.xtrm/hooks/{xtrm-logger,xtrm-session-logger,xtrm-tool-logger,beads-gate-utils,beads-claim-sync,beads-gate-core,beads-status-cache,specialists-agent-guard}.mjs`
- `packages/pi-extensions/extensions/{beads,session-flow}/index.ts`; `packages/pi-extensions/src/core/session-state.ts`
- `docs/runtime-compatibility.json`; `docs/observability/prometheus-labels.md`
- `.pi/tasks/tasks-01a0a2e7-7449-71f4-8127-e02757bfc5.json` (native task file, referenced `bead_id`/`planner_bead_id` hits only)
- `/tmp/audit/xtrm-main/packages/substrate/src/domain/{issue,claim,execution-binding,closure,contract,provenance,journal,execution-context,readiness}.ts`; `.../workitems/store.ts`
- `/tmp/audit/specialists-master/src/activation/types.ts`; `src/specialist/chain-identity.ts`

## Not inspected

- The whole `docs/` tree beyond the two files above (topology/observability design docs were not enumerated).
- `cli/test/**` and `test/integration-suite/**` beyond name-level greps.
- Specialists `src/specialist/observability-sqlite.ts`, `forensic-events.ts`, `timeline-events.ts` — grepped only.
- Substrate `domain/{repository,edge,repository-discovery}.ts` and the whole `sb` CLI verb surface — grepped only.
- Core `cli/src/commands/{attach,status,clean,reset,bootstrap,release}.ts`; `.xtrm/config/pi/pi-worktrees-settings.json`; `.githooks/**`.
- Beads' own `bd` schema/source (no Beads repo snapshot was provided), so every Beads-side claim above is derived from how Core reads `bd`, not from `bd` itself.

---

## UNRESOLVED

1. **Bulk Substrate read surface for the projection.** The `beads` source uses `bd list --all --json`
   (`cli/src/core/topology-projection.ts:91`). Neither `xtrm.topology.projection.v1` nor `docs/runtime-compatibility.json`
   names an `sb` equivalent. Exact question: *does Substrate publish a bulk Issue/claim/binding read verb (e.g.
   `sb issue ls --all --json`) that returns status, contract hash, current claim holder/activation, and aliases in
   one call, and what is its stable contract id?* Without it the `substrate` source cannot replace `beads` without
   N+1 calls.
2. **Alias resolution boundary.** `Issue.id` is `iss_<uuidv7>` and `issueRef` accepts "iss_..., XTRM-227, XTRM-184.2.3,
   a historical locator, or a legacy imported Beads alias" (`/tmp/audit/specialists-master/src/activation/types.ts:56-60`).
   Exact question: *is alias resolution a Substrate service call, and will `sb` expose it so Core stops carrying raw
   Beads aliases in `@agent_bead`, `planner_bead_id`, and `.xtrm-session-state.json.issueId`?*
3. **`session_id` namespace contract.** Core's hooks can substitute a cwd path or a PID for a session id
   (`.xtrm/hooks/beads-gate-utils.mjs:31`, `session-flow/index.ts:18`). Exact question: *after cutover, which concrete
   value does `XTRM_SESSION_ID` carry for (a) a pi/claude interactive pane, (b) a Codex session, (c) a Specialist
   activation — and is Core responsible for exporting it, or the runtime?* The env pair is defined upstream
   (`execution-context.ts:105-107`) but nothing in Core sets it (grep found only test usages).
4. **Claim/lease TTL and anti-steal.** Upstream requires `expiresAt` + `generation` and rejects renewing an expired
   lease (`claim.ts:12-18,66-72`). Core's edit gate must currently block on an expired claim or not — undetermined.
   Exact question: *when Core's claim authority moves to `sb`, what happens to a live session holding a claim whose
   TTL expires mid-turn — does the gate fail closed and require re-claim, and who surfaces that to the operator?*
5. **`agent_instance_id` vs `ExecutionBinding.id`.** No upstream analogue exists for the xtmux agent-instance id.
   Exact question: *is `agent_instance_id` preserved as a compat alias inside `ExecutionBinding`, or dropped with the
   tmux lineage leg?* This affects `xtrm.runtime-origin.v1`, `@agent_instance_id`, and `XtmuxTopologyAgent.instance_id`.
6. **`boundary` of the topology `sources` array.** The schema pins exactly 6 sources by `contains`.
   Exact question: *is adding `substrate` a minor schema bump, or does `xtrm.topology.projection.v1` get replaced by a
   v2 that also drops the `beads` source?* Consumers of the pinned 6-element ledger were not enumerated.
