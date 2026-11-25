# `xt attach` launch parity (CORE-2792)

What a launcher (`xt claude|pi|codex [--role …] [--bead …]`) writes onto a pane, into
the pane's environment and into the runtime argv, versus what `xt attach` and
`xt attach --fresh` restore after those pieces are gone.

## 1. Summary

A tmux pane option and the environment of the process that ran in it die with the
pane. After a power loss, a reopened terminal or a tmux server restart, `xt attach`
brought the runtime and its conversation back but not its identity: the local
incidents left panes with an empty `@agent_role`, no `@agent_bead`, `@agent_branch`,
`@agent_worktree` or `@agent_task`, no `XTMUX_AGENT_*` environment, and a runtime
argv (`pi -c`, `claude --continue`) that had lost the role's system prompt.
Worse, because nothing stripped the attacher's own metadata, the resumed pane could
inherit the metadata of the pane that ran `xt attach`.

This change adds a durable source (a `launch` block in the worktree session
record), persists the launch identity at launch time, and restores it on resume.

Parity items in the inventory below: **24 MISSING before, 4 MISSING after; 20 items
restored by this change.** The four remaining are listed in §8 with a proposal each;
none of them is a value a resume can safely invent.

## 2. Why the pane loses its identity

| Piece | Written at launch | Dies when |
| --- | --- | --- |
| `@agent_*` pane options | `cli/src/utils/worktree-session.ts:4184` (current pane), `:4456` (created pane); Codex `cli/src/utils/codex-worktree-session.ts:505` | the pane dies |
| Pane environment (`-e KEY=VALUE`) | `cli/src/utils/worktree-session.ts:4305-4320` (pane env record), `:4215-4257` (env merge) | the pane's process dies |
| Runtime argv (`--name`, `--append-system-prompt`, `--no-skills --skill …`) | `cli/src/utils/worktree-session.ts:2378`, `:2445` (`buildRoleTmuxPlan`) | the process dies |
| Worktree files (`.claude/skills`, `.specialists` symlinks, Codex trust profile) | `cli/src/utils/worktree-session.ts:3787-3804`, `cli/src/utils/codex-worktree-session.ts:374` | nothing — they are on disk and survive |

Only the first three rows are pane-scoped. The durable source introduced here covers
exactly those.

## 3. The durable source: the `launch` block

`<worktree>/.xtrm/session-meta.json` already survived the pane (it holds `runtime`,
`launchedAt`, `bead`, `bindingId`). It now also holds the launch identity:

```json
{
  "runtime": "pi",
  "launchedAt": "2026-11-25T14:50:08.312Z",
  "bead": "CORE-2792",
  "launch": {
    "role": "worker",
    "requestedRole": "worker",
    "task": "role:worker",
    "worktree": "/…/.xtrm/worktrees/repo-xt-pi-demo",
    "branch": "xt/demo",
    "parentSession": "$0",
    "sessionName": "role-pi-worker-core-2792",
    "displayName": "repo-xt-pi-demo"
  }
}
```

- Owner: `cli/src/core/session-launch.ts` (`SessionLaunchMeta`, `compactLaunchMeta`,
  `readSessionLaunch`, `cleanLaunchValue`), re-exported by
  `cli/src/utils/worktree-session.ts:2991` (`writeSessionLaunch`).
- Written at launch: `cli/src/utils/worktree-session.ts:4146` (Claude/Pi, from the
  same values that become pane options) and `cli/src/utils/codex-worktree-session.ts:528`
  (Codex, when the session record is written).
- Validation on read: each field is trimmed, empty values are dropped, values over
  4096 characters or containing control characters are dropped. A damaged or
  hand-edited block degrades to absent — a resume then restores less, never bad data.
- The block is an addition, never a rewrite of the record: `bead`, `bindingId` and
  `launchedAt` are preserved.

## 4. Parity table

Legend: **RESTORED** = `xt attach` writes it back; **MISSING** = it is not restored;
**n/a** = the item does not apply to a resume (or is restored by another owner).
Line numbers are the branch head; the launcher lines below `worktree-session.ts:4146`
are unchanged from the base commit.

### 4.1 Pane options

| # | Item | Set by launch | Restored by `xt attach` | Restored by `xt attach --fresh` | Note |
| --- | --- | --- | --- | --- | --- |
| P1 | `@agent_parent_session` | `worktree-session.ts:2433` | **RESTORED** `attach.ts:133-153`, written `attach.ts:604` | RESTORED (launcher) | from `launch.parentSession` |
| P2 | `@agent_task` | `worktree-session.ts:2434` | **RESTORED** `attach.ts:133-153` | RESTORED (launcher) | `launch.task`, else `role:<role>` |
| P3 | `@agent_state` | `worktree-session.ts:2435` (`idle`) | **MISSING** (by design) | RESTORED (launcher seeds `idle`) | runtime-owned; see §8.1 |
| P4 | `@agent_worktree` | `worktree-session.ts:2436` | **RESTORED** `attach.ts:133-153` | RESTORED (launcher) | the live worktree path, never the recorded one |
| P5 | `@agent_branch` | `worktree-session.ts:2437` | **RESTORED** `attach.ts:133-153` | RESTORED (launcher) | `launch.branch`, else the live branch |
| P6 | `@agent_bead` | `worktree-session.ts:2439` | **RESTORED** `attach.ts:133-153` | RESTORED (launcher) | Issue ref from `sb` binding, else `record.bead` |
| P7 | `@agent_role` | `worktree-session.ts:2440` | **RESTORED** `attach.ts:133-153` | RESTORED (launcher) | `launch.role` |
| T1 | pane title (`select-pane -T`) | `worktree-session.ts:4459` | **RESTORED** `attach.ts:608-611` | RESTORED (launcher) | `launch.displayName` |

`@agent_parent_pane` is read by `cli/src/core/topology-projection.ts:84` and described
in `packages/contracts/dist/index.js:2138`, but no launcher writes it. It is a dead
field, not a parity gap (see §8.5).

**Unset before set.** Setting a pane option never clears a stale one, so a pane that
previously hosted a coordinator would keep `@agent_role=lead` and the old bead
whenever the record has nothing to say about them. `xt attach` therefore unsets all
six keys (`set-option -pu`, `attach.ts:600-608`) before it writes the restored
values. A key the record cannot answer ends up absent, which is the truth, instead of
silently describing the previous occupant.

The options are **not** unset when the worker exits. They describe the pane that
hosted the worker while it ran, and a pane still showing that worker's output must
not lose the identity of the process that wrote it; the runtime's agent-state hook
already moves `@agent_state` to its terminal value.

### 4.2 Environment

The launcher exports `XTMUX_AGENT_<X>` for every `@agent_<x>` option except
`@agent_state` (`buildAgentEnv`, `worktree-session.ts:2603`).

| # | Item | Set by launch | Restored by `xt attach` | Restored by `xt attach --fresh` | Note |
| --- | --- | --- | --- | --- | --- |
| E1 | `XTMUX_AGENT_ROLE` | `worktree-session.ts:2603` via `:4306` | **RESTORED** `attach.ts:56-108`, `:620` | RESTORED (launcher) | |
| E2 | `XTMUX_AGENT_TASK` | same | **RESTORED** | RESTORED | |
| E3 | `XTMUX_AGENT_WORKTREE` | same | **RESTORED** | RESTORED | |
| E4 | `XTMUX_AGENT_BRANCH` | same | **RESTORED** | RESTORED | |
| E5 | `XTMUX_AGENT_BEAD` | same | **RESTORED** | RESTORED | |
| E6 | `XTMUX_AGENT_PARENT_SESSION` | same | **RESTORED** | RESTORED | |
| E7 | `XTRM_SESSION_ID` | `worktree-session.ts:4299-4304` (`buildSessionIdentityEnv`) | **RESTORED** `attach.ts:56-108` | RESTORED | the tmux session the pane runs in |
| E8 | `XTRM_SESSION_NAME` | same | **RESTORED** | RESTORED | |
| E9 | `XTRM_ROLE` + `GIT_CONFIG_*` transport | `launch-identity.ts:315` via `worktree-session.ts:4216` | **RESTORED** `attach.ts:56-108` | RESTORED | re-derived from `launch.role` by the same resolver the launcher uses, reading the environment the attacher's transport was already stripped from (§4.8) |
| E10 | `XTMUX_AGENT_RUNTIME=codex` | `codex-worktree-session.ts:431` | **RESTORED** `attach.ts:56-108` | RESTORED | Codex only |
| E11 | `SUBSTRATE_HOLDER`, `XTRM_AGENT_NAME`, git identity | inherited from the launcher's own environment | RESTORED | RESTORED | already restored (CORE-2727), rebuilt by `buildAttachEnv` |
| E12 | `XTRM_DISPATCHER_*` | `worktree-session.ts:4109` (`buildDispatcherEnvWithResolution`) | RESTORED | RESTORED | already restored (CORE-2728), from the Substrate binding |
| E13 | Claude MCP env | `claudeMcpEnv` | RESTORED | RESTORED | already restored |
| E14 | `LAUNCH_FORWARDED_ENV` (`XTRM_SUBSTRATE_DIR`, `XTRM_AGENT_LAUNCH`, `XTRM_AGENT_HOST_SOCKET`, `PI_CODING_AGENT_DIR`) | `worktree-session.ts:4315` | **MISSING** | **MISSING** | the attacher's own values are inherited, not the worker's; see §8.2 |
| E15 | `PATH` with the `gh` shim first | `worktree-session.ts:4322` | n/a (inherited from the attacher) | n/a | the attacher runs with the same PATH in practice |
| E16 | `XTRM_INITIAL_PROMPT` (turn-1 handshake) | `worktree-session.ts:4159` | n/a | n/a | no turn 1 on a resume |

### 4.3 Runtime argv

| # | Item | Set by launch | Restored by `xt attach` | Restored by `xt attach --fresh` | Note |
| --- | --- | --- | --- | --- | --- |
| A1 | `--name <displayName>` | `worktree-session.ts:2378` | **RESTORED** `attach.ts:551/555` | RESTORED (launcher) | from `launch.displayName` |
| A2 | `--append-system-prompt <role prompt>` | `worktree-session.ts:2470` | **RESTORED** `attach.ts:507-525`, `:552/556` | RESTORED (launcher) | `resolveRole(launch.role)` → `role.systemPrompt`; a failed resolution warns and resumes without it |
| A3 | Pi skill pool (`--no-skills --skill <path>…`) | `worktree-session.ts:2479-2480` | **RESTORED** `attach.ts:517`, `:557-561` | RESTORED (launcher) | `resolveRequestedSkills` resolves the declared paths exactly as the launcher does; the operator's own repeatable `--skill` paths are recorded as `launch.skills` and replayed, minus any path that no longer exists (warned, not fatal) |
| A4 | model (`--model` / `-m`) | `worktree-session.ts:2382` | n/a (runtime session state) | RESTORED from `launch.model` (`attach.ts:356`) | a resumed session keeps its own model, including an operator's in-session change |
| A5 | thinking (`--thinking`, Pi) | `worktree-session.ts:2397` | n/a (runtime session state) | RESTORED from `launch.thinking` (`attach.ts:357`) | Pi records `thinking_level_change` in its session file |
| A6 | `--channels plugin:specialists@xtrm` | `worktree-session.ts:2392`, `:3882` | RESTORED | RESTORED | already restored (CORE-2284) |
| A7 | `--dangerously-skip-permissions` (Claude), none for Pi | `worktree-session.ts:2495`, `:2564`, `:3876` | RESTORED | RESTORED | already restored |
| A8 | turn-1 prompt | `worktree-session.ts` turn-1 composition | n/a | not restored | a fresh attach starts a new session, so no prompt is replayed |

### 4.4 Worktree provisioning

| # | Item | Set by launch | Restored by `xt attach` | Restored by `xt attach --fresh` | Note |
| --- | --- | --- | --- | --- | --- |
| V1 | Claude skills pointer, pack links, `.specialists` symlinks | `worktree-session.ts:3787-3792` | n/a (persists on disk) | RESTORED (launcher) | the artifacts are in the worktree and survive the pane |
| V2 | Pi launch preflight | `worktree-session.ts:3804` | RESTORED `attach.ts` pi path | RESTORED | attach already ran it |
| V3 | Codex trust profile | `codex-worktree-session.ts:374` | n/a (persists in the Codex home) | RESTORED (launcher) | the profile file survives the pane |

### 4.5 Side effects of a launch

| # | Item | Set by launch | Restored by `xt attach` | Note |
| --- | --- | --- | --- | --- |
| S1 | bead assignee (`bd update --assignee=<runtime>/<instance>`) | `worktree-session.ts:129-230` | **MISSING** | needs the post-spawn `agent.ready` handshake; §8.3 |
| S2 | `agent.role.launched` telemetry | `worktree-session.ts:3924`, called `:4188`, `:4465` | **MISSING** | §8.4 |
| S3 | Substrate dispatcher binding | `worktree-session.ts:4067` region | RESTORED | already restored (CORE-2728), read from `sb` |

### 4.6 Counts

| Category | Items | MISSING before | MISSING after |
| --- | --- | --- | --- |
| Pane options | 8 | 8 | 1 |
| Environment | 16 | 11 | 1 |
| Runtime argv | 8 | 3 | 0 |
| Provisioning | 3 | 0 | 0 |
| Side effects | 3 | 2 | 2 |
| **Total** | **38** | **24** | **4** |

Restored by this change: 20 (`P1, P2, P4-P7, T1`, `E1-E10`, `A1-A3`). The four
remaining are `P3` and `E14` (deliberate) and `S1`, `S2` (need post-spawn work);
each is under §8.

The counts do not move for the review fixes: a **wrongly** restored item is still
restored. `E9` was exported from the attacher's environment, so the worker received
the attacher's credential helper; it now receives its own App's transport (§4.8).

### 4.7 Other launcher state (outside the counted inventory)

These four pieces of state belong to the launch but are not table rows, because
neither side is a `xt attach` concern and nothing is lost when the pane dies.

| Item | Set by launch | State after `xt attach` | Why it needs no restore |
| --- | --- | --- | --- |
| Runtime conversation to resume | Claude: `--continue` (`attach.ts` resume path) reads the newest transcript under `~/.claude/projects/<cwd-slug>/`; pi: `-c` reads the newest session under `~/.pi/agent/sessions/--<cwd-slug>--/`; codex: `threadId` in the Codex record, replayed by `buildCodexResumeArgs` | RESTORED by the runtime itself | The transcripts live outside the pane and outside the worktree; the resume flag is exactly what re-attaches them. |
| Substrate issue claim | never the launcher — the runtime agent claims its own issue from its skill | reclaimed by the resumed agent | Ownership is the agent's, recorded in Substrate, not in the pane. |
| Git hooks path | `normalizeWorktreeHooksPath` (`worktree-session.ts:2833` region) writes an absolute `core.hooksPath` for the worktree | n/a (persists on disk) | Stored in the worktree's git config, not in the pane. |
| xtmux registration (`@agent_state`, `@agent_instance_id`, `agent.state` events) | the runtime's own agent-state hook, not the launcher; the launcher only seeds `@agent_state=idle` (`worktree-session.ts:2435`) | RESTORED by the hook as soon as the runtime starts | The hook owns these values and rewrites them on every attach; a launcher-side restore would race it. Consumers: `topology-feed.ts:54`, `topology-projection.ts:77-85`. |
| Role file / prompt file | none — the role identity is inline (`--append-system-prompt`, the `@agent_*` options). The `@agent_prompt_file` option was dropped in xtrm-8zsi1 (`worktree-session.ts:2418` comment) | n/a | There is no role file to read; the recorded role name is re-resolved through `sp view`, which is the durable source (§3). |

### 4.8 Who `xt attach` trusts, and why

Two properties of the durable source matter, because a resume acts on it.

**The environment the resolver sees.** `GIT_CONFIG_*` is a list, not a map: if the
attacher's entries survive at index 0, they are consulted before the worker's own App
helper, and the worker can push as the operator. `buildAttachEnv` strips that
transport first and hands the *stripped* environment to `resolveLaunchIdentity`, so
the resolver can never re-forward what the attacher had (`attach.ts:88-101`).

**The record the role comes from.** `.xtrm/session-meta.json` lives in the worker's
own checkout, so the worker can rewrite `launch.role` — and the role selects the
GitHub App identity the next resume adopts. Three checks apply:

1. `readSessionLaunch` accepts a role only if it matches the launcher's own grammar
   (`isValidRoleName`, `launch-identity.ts:32`), so a path or a flag cannot become a
   role.
2. The launcher writes the same `launch` block outside the worktree, at
   `$HOME/.xtrm/state/launch-identity/<slug>-<hash12>.json`. `xt attach` reads both
   and prefers the ledger; a disagreement over the role is reported on stderr and the
   ledger's role wins (`trustedLaunchMeta`, `attach.ts:150-175`).
3. Both files are written with a temp file plus `rename`, so no reader observes a
   half-written record (`writeJsonAtomic`, `session-launch.ts`).

Honest limit: on a single-user host the worker runs as the same uid and can write the
ledger too. The ledger raises the cost of a partial forgery — a hand-edited checkout
copy, a damaged record, a stale worktree — and makes the disagreement visible. It is
not a privilege boundary; §8.7 proposes one.

## 5. Records written before this fix

A record without a `launch` block cannot answer the role, the task or the parent
session: no other durable source holds them (the xtmux event log carries no
`agent.role.launched` rows, the Substrate binding records only the dispatcher, and
the role map is global). Such a record restores the three items that survive
independently — `@agent_bead` (Substrate binding or `record.bead`), `@agent_branch`
(recorded, else live) and `@agent_worktree` (the live path) — and nothing else.

The rule is: never invent a parent, a role or a task the record does not name. For a
legacy pane the operator either passes `xt attach <slug> --fresh --role <role>` or
accepts a pane without a role. Live incident panes `%3`, `%10` and `%11` in session
`xx` are exactly this case.

## 6. Evidence

All runs use a throwaway tmux server (`tmux -L xtrm629-demo-*`); the operator's
server is never addressed. Harness: `/tmp/parity-demo.sh` (scratch) creates a sandbox
repo with a stub `sp`/`sb`/`bd` and a stub `pi` that records `cwd`, `argv` and the
`XTMUX_AGENT_*`/`XTRM_SESSION_*` environment, launches
`xt pi demo --role worker --bead CORE-2792 --window`, kills the server (power loss),
then runs `xt attach demo` in a new pane of a new server.

### 6.1 Before (installed build 0.15.3 of 2026-11-23, pre-fix)

```
== pre-fix: launch pane options ==
@agent_bead CORE-2792
@agent_branch xt/demo
@agent_parent_session "$0"
@agent_role worker
@agent_state idle
@agent_task role:worker
@agent_worktree /tmp/…/repo/.xtrm/worktrees/repo-xt-pi-demo
== pre-fix: pane options after xt attach ==
                                          <-- none: 0 of 7 restored
== pre-fix: attach env ==
argv=-c
XTMUX_AGENT_BRANCH=xt/attach-parity        <-- the ATTACHER's identity leaked in
XTMUX_AGENT_WORKTREE=/home/dawid/dev/core/.xtrm/worktrees/core-xt-pi-attach-parity
                                          <-- no XTRM_SESSION_ID, no role prompt
```

### 6.2 After (`xt attach`, branch head)

```
== final-keep: launch pane options ==          == final-keep: pane options after xt attach ==
@agent_bead CORE-2792                          @agent_bead CORE-2792
@agent_branch xt/demo                           @agent_branch xt/demo
@agent_parent_session "$0"                      @agent_parent_session "$0"
@agent_role worker                              @agent_role worker
@agent_state idle                               <-- absent: runtime-owned (P3)
@agent_task role:worker                         @agent_task role:worker
@agent_worktree /tmp/…/worktrees/repo-xt-pi-demo @agent_worktree /tmp/…/worktrees/repo-xt-pi-demo

== final-keep: launch env ==                    == final-keep: attach env ==
argv=--name repo-xt-pi-demo --append-system-prompt You are the demo worker. --no-skills
                                               argv=-c --name repo-xt-pi-demo --append-system-prompt You are the demo worker. --no-skills
XTMUX_AGENT_BEAD=CORE-2792                     XTMUX_AGENT_BEAD=CORE-2792
XTMUX_AGENT_BRANCH=xt/demo                     XTMUX_AGENT_BRANCH=xt/demo
XTMUX_AGENT_PARENT_SESSION=$0                  XTMUX_AGENT_PARENT_SESSION=$0
XTMUX_AGENT_ROLE=worker                        XTMUX_AGENT_ROLE=worker
XTMUX_AGENT_TASK=role:worker                   XTMUX_AGENT_TASK=role:worker
XTMUX_AGENT_WORKTREE=/tmp/…/repo-xt-pi-demo    XTMUX_AGENT_WORKTREE=/tmp/…/repo-xt-pi-demo
XTRM_SESSION_ID=$0                             XTRM_SESSION_ID=$0
XTRM_SESSION_NAME=xx                           XTRM_SESSION_NAME=xx
```

The pane title is `repo-xt-pi-demo` in both panes (restored by `select-pane -T`); the
attacher's `xt/attach-parity` identity is gone.

### 6.3 After, with a pre-fix record (`launch` block removed)

```
== final-legacy: pane options after xt attach ==
@agent_bead CORE-2792
@agent_branch xt/demo
@agent_worktree /tmp/…/repo-xt-pi-demo
== final-legacy: attach env ==
argv=-c
XTMUX_AGENT_BEAD=CORE-2792
XTMUX_AGENT_BRANCH=xt/demo
XTMUX_AGENT_WORKTREE=/tmp/…/repo-xt-pi-demo
XTRM_SESSION_ID=$0
XTRM_SESSION_NAME=xx
```

### 6.4 After, `xt attach --fresh`

```
== final-fresh: pane options after xt attach ==   (7 of 7, @agent_state included)
== final-fresh: attach env ==
argv=--name repo-xt-pi-demo --append-system-prompt You are the demo worker. --no-skills
XTMUX_AGENT_BEAD=CORE-2792 … XTRM_SESSION_NAME=xx   (identical to the launch)
```

`--fresh` re-derives role, model and thinking from the record (`attach.ts:353-357`),
so an operator does not have to remember `--role` after a power loss. An explicit
flag still wins over the record.

### 6.5 The four review fixes, failing on the reviewed commit

`cli/src/tests/attach-review-fixes.test.ts` (kept outside the tree, copied into a
detached checkout of `89ac7233`) fails there with exactly the reported symptoms:

```
× finding 1: replaces the attacher transport with the worker App transport
  AssertionError: expected 'credential.helper' to be 'url.https://github.com/.insteadOf'
× finding 2: unsets the six pane options before restoring, so a lead role cannot survive
  AssertionError: expected [] to include '@agent_parent_session'
× finding 3: --fresh with another role does not inherit the old role defaults
  AssertionError: expected 'worker-model' to be undefined
× finding 4: refuses a role outside the launcher grammar
  AssertionError: expected '../../etc/passwd' to be undefined
```

The same four behaviours pass on the branch, each as a test in
`cli/src/tests/attach-parity.test.ts` (39 tests there).

### 6.6 A stale pane on a real throwaway socket (finding 2)

`xt attach` typed into a pane that previously hosted a coordinator, with both durable
sources deliberately made silent (the worktree `launch` block and the out-of-worktree
ledger deleted). Throwaway socket only.

```
== stale: pane options BEFORE xt attach (stale, hand-set) ==
@agent_bead OLD-9
@agent_role lead
@agent_task role:lead
== stale: pane options after xt attach ==
@agent_bead CORE-2792
@agent_branch xt/demo
@agent_worktree /tmp/xtrm-parity-demo-stale-LDDknl/repo/.xtrm/worktrees/repo-xt-pi-demo
== attach: restored line ==
  restored: @agent_worktree=… @agent_branch=xt/demo @agent_bead=CORE-2792
== attach env ==
argv=-c
XTMUX_AGENT_BEAD=CORE-2792 XTMUX_AGENT_BRANCH=xt/demo XTMUX_AGENT_WORKTREE=…
```

`@agent_role=lead`, `@agent_task=role:lead` and the stale bead are gone; the three the
worktree itself can answer are correct. Before the fix the pane kept all three stale
values and the worker inherited a coordinator's role.

## 7. Files changed

| File | Change |
| --- | --- |
| `cli/src/core/session-launch.ts` | new: `SessionLaunchMeta`, `cleanLaunchValue`, `compactLaunchMeta`, `readSessionLaunch`, the out-of-worktree ledger (`launchLedgerPath`, `writeLaunchLedger`, `readLaunchLedger`) and `writeJsonAtomic` |
| `cli/src/core/launch-identity.ts` | exports `isValidRoleName`, so a persisted role is checked with the launcher's own grammar |
| `cli/src/utils/worktree-session.ts` | persists `launch` at launch (`:4146`); re-exports the record helpers; `SessionMeta.launch` |
| `cli/src/utils/codex-worktree-session.ts` | persists `launch` in the Codex session record (`:528`) |
| `cli/src/core/codex-session.ts` | reads `launch` back through `readSessionLaunch` |
| `cli/src/commands/attach.ts` | restores pane options, pane title, environment and the role argv; unsets the six options first; reads the stripped environment; trusts the ledger over the worktree copy; restores role/model/thinking for `--fresh` only while the role is unchanged; strips the attacher's restored keys |
| `cli/src/tests/attach-parity.test.ts` | 39 tests (record, ledger, trust, pane options incl. the unsets, env incl. the credential check, argv incl. replayed `--skill` paths, title, legacy record, `--fresh`) |
| `cli/src/tests/codex-k1-launch-contract.characterization.test.ts`, `cli/test/codex-k1-failure-residue.characterization.test.ts` | expectations updated for the record field and the attach tmux writes |

## 8. Remaining gaps and proposals

### 8.1 `@agent_state` (P3)

The launcher seeds `idle` so the picker sees the pane before the first turn. The
runtime's own agent-state hook owns the option afterwards. `xt attach` must not
write a state it did not observe: a resumed pane is not `idle`. No action.

### 8.2 Forwarded launch environment (E14)

`LAUNCH_FORWARDED_ENV` (`XTRM_SUBSTRATE_DIR`, `XTRM_AGENT_LAUNCH`,
`XTRM_AGENT_HOST_SOCKET`, `PI_CODING_AGENT_DIR`) exists because a tmux session
started by `new-session` inherits the server's environment, not the launcher's. A
resumed pane inherits the attacher's values instead — in practice the same, but not
guaranteed. Proposal: persist the forwarded values in the `launch` block and re-apply
them on resume. Deferred because the values are paths, and a stale path is worse than
an absent one; the operator's shell is the current fallback.

### 8.3 Bead assignee (S1)

`assignBeadToRuntime` waits for the runtime's `agent.ready` row and then runs
`bd update --assignee=<runtime>/<instanceId>`. `xt attach` execs the runtime in the
foreground, so it cannot run that handshake. Proposal: a separate issue that moves
the handshake into a detached watcher for the attach path.

### 8.4 `agent.role.launched` telemetry (S2)

`emitAgentRoleLaunched` records a launch row in the xtmux event log. `xt attach`
does not emit one, so xtmux history shows the pane as unlaunched. Proposal: emit a
row with a `source=attach` field after a successful restore, once the picker's schema
has a place for it — it is a telemetry sink, not a source.

### 8.5 `@agent_parent_pane` (dead field)

Read by `topology-projection.ts:84`, written by nothing. Proposal: either write it at
launch (the pane id of the dispatching pane) and restore it on resume, or remove the
read. Out of scope here.

### 8.6 Placement, window name and layout

A bare `xt attach` resumes in the pane it was started in, by design. `--fresh` goes
back through the launcher and keeps the operator's placement flags.

### 8.7 A trust boundary the worker cannot cross

§4.8 keeps the launch identity outside the worktree, but the worker still runs as the
same uid and can write that ledger. Proposal for a separate issue: write the record
from a principal the agent cannot impersonate — the tmux server's own environment
(`set-environment`, which the pane cannot rewrite), a supervisor process that owns the
worktree record, or a signed entry appended by the launcher with the key held outside
the agent's home. Until then, treat the ledger as tamper-evident rather than
tamper-proof, and keep the operator's habit of reading the `restored:` line attach
prints.

## 9. Reproducing the evidence

```bash
# throwaway socket only; the script refuses any socket not named xtrm629-demo-*
KEEP=1 bash /tmp/parity-demo.sh <checkout-root> <label> keep     # xt attach
KEEP=1 bash /tmp/parity-demo.sh <checkout-root> <label> legacy   # pre-fix record
KEEP=1 bash /tmp/parity-demo.sh <checkout-root> <label> fresh    # xt attach --fresh
KEEP=1 bash /tmp/parity-demo.sh <checkout-root> <label> stale    # a pane that held a lead
                                                                 # (both durable sources deleted)
```

`<checkout-root>` is a checkout whose `cli/dist/index.cjs` is built. Running the CLI
from TypeScript source is not possible: `cli/src/core/pi-runtime.ts:56` uses
`__dirname` in an ES module (`ReferenceError: __dirname is not defined in ES module
scope`).

Validation for this change: `npx tsc --noEmit` clean, `npm run build` clean,
`npx vitest run src/tests/attach-parity.test.ts` 39/39, plus the characterization
suites named in §7. `cli/src/tests/attach-parity-behaviour.test.ts` is the same proof
in behavioural form, run against both the base commit and the branch.
