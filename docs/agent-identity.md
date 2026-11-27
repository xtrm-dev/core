# Agent identity schema

Status: CORE-2801. Scope: tmux pane options and `XTMUX_AGENT_*` environment variables that identify a launched agent.

This document is the single schema. Every pane option has one owner. Only the owner writes the option after launch. All other components read it.

## Vocabulary

Substrate replaced Beads. The identity schema uses Substrate terms:

| Retired name | Current name |
|---|---|
| `@agent_bead` | `@agent_issue` |
| `XTMUX_AGENT_BEAD` | `XTMUX_AGENT_ISSUE` |
| `xt claude\|pi\|codex --bead <ref>` | `--issue <ref>` (`--bead` remains a hidden, deprecated alias that maps to `--issue`) |
| `XTRM_BEADS_CACHE_ROOT` | `XTRM_ISSUE_CACHE_ROOT` (the old name is read when the new one is unset) |
| `XTMUX_AGENT_PROMPT_FILE` | removed from the identity schema; the launcher and `agent-state.sh` write no prompt file. `@agent_prompt_file` stays a handoff option (see below). |

## Retained wire names

These names belong to versioned contracts or to files other tools read. They keep the Beads spelling and are not pane options. A change needs a contract version.

| Name | Where | Reason |
|---|---|---|
| `bead=` | Events `agent.role.launched` and `agent.role.task-rendered` (core), `agent.state` (xtmux) | xtmux event schema |
| `bead_id`, `bead` | `xt topology --json` (`xtrm.topology.projection.v1`) | Published contract consumed by xtmux and the console |
| `LaunchOptions.bead` | Agent-host launch API (`xtrm.agent-host-api.v1`) | Published contract. The launcher maps it to `--issue`. |
| `SessionMeta.bead` | `.xtrm/session-meta.json`, Codex session record | Persisted by earlier launches. New records write `issue`. Readers accept both. |
| `bead_id`, `--bead` | `sp` / `specialists` CLI and tools | Permanent compatibility aliases owned by Specialists |

## Pane options

The environment variable of each option is `XTMUX_AGENT_<NAME>`. The launcher derives it from the option, except `@agent_state` and `@agent_instance_id`, which have no variable.

| Option | Owner | Written by | Updated on | Meaning |
|---|---|---|---|---|
| `@agent_issue` | The agent that owns the pane | Launcher (seed, from `--issue`); `sb issue claim\|release\|close` (sync); `agent-state.sh` (seed only when empty) | `sb` claim, release, close by the pane's holder | The Substrate Issue the pane's agent holds. Empty when none. |
| `@agent_holder` | Launcher | Launcher | Launch, `xt attach` | The `SUBSTRATE_HOLDER` of the pane's agent. It decides pane ownership for claim sync. |
| `@agent_role` | Launcher | Launcher | Launch, `xt attach` | Role of the pane's agent. A child launch writes its own role. |
| `@agent_task` | Launcher | Launcher | Launch, `xt attach` | Task label (`role:<name>` or free text). |
| `@agent_parent_session` | Launcher | Launcher | Launch, `xt attach` | tmux session id (`$N`) of the dispatcher. The only authoritative parent source. |
| `@agent_parent_pane` | Launcher | Launcher | Launch only | tmux pane id (`%N`) of the dispatcher. `xt attach` does not restore it: a pane id does not survive the loss of the pane, so a resumed pane has none. |
| `@agent_dispatcher` | Launcher | Launcher | Launch, `xt attach` | Substrate participant of the dispatching session (`XTRM_DISPATCHER_PARTICIPANT`). Absent when the participant is unknown; the display name is never used. |
| `@agent_worktree` | `agent-state.sh` after launch | Launcher (seed); `agent-state.sh` | Every state transition | Git worktree root of the pane's working directory. |
| `@agent_branch` | `agent-state.sh` after launch | Launcher (seed); `agent-state.sh` | Every state transition | Checked-out branch of that worktree. |
| `@agent_prompt_file` | xtmux picker handoff | Picker handoff only | `handoff` | Pointer to the prompt file of a handoff. Not identity: nothing else writes it. `agent-state.sh` clears it on `off`. |
| `@agent_state` | `agent-state.sh` | Runtime hooks through `agent-state.sh` | Every state transition | `idle`, `running`, `needs-input`, `done`, `off`. |
| `@agent_instance_id` | `agent-state.sh` | `agent-state.sh` | `--new-instance` | Identity of one agent occupation of the pane. |

### Precedence rules

1. The owner writes the option. A component that is not the owner never overwrites it.
2. `XTMUX_AGENT_*` variables are frozen at launch. They seed an option only when the option is empty. A transition never overwrites a non-empty option from the environment.
3. A reader reads the live pane option first, then the environment, then the legacy name (`@agent_bead`, `XTMUX_AGENT_BEAD`).
4. A legacy name is read-only. No component writes `@agent_bead` or `XTMUX_AGENT_BEAD`.
5. `@agent_parent_session` is the only parent source. `XTRM_PARENT_SESSION_ID` is derived from the same resolution at launch and carries the same value.

### Claim sync

The `sb` client updates `@agent_issue` after a successful operation. The hook sits in `runCli`, the dispatch that the shipped bin (`cli/sb-ux.ts`) and `cli/sb.ts` share. It runs in the client, so it does not need the Substrate remote.

Taking a hold (`sb issue claim`):

1. `sb` reads `$TMUX_PANE` to locate the pane. Without `$TMUX` and a pane id, `sb` does nothing.
2. `sb` reads `@agent_holder` of that pane. `sb` continues only when it equals the holder of the operation. An in-process specialist or another holder has a different holder and never changes the parent pane.
3. `sb` sets `@agent_issue` to the claimed ref.

Ending a hold (`release`, `close`, `cancel`, and `state <ref> done|cancelled|archived`):

1. `sb` lists the panes of the tmux server and unsets `@agent_issue` on every pane whose value equals the ref (case-insensitive).
2. The holder gate does not apply. A lead that closes a worker's Issue clears the worker's pane.
3. Each unset is logged.

Scope: `sb` reaches the tmux server that the process runs under (`$TMUX`). Panes on another server or host are not updated, and a process outside tmux logs a skip. Cross-host sync is not part of this schema (XTRM-1077).

Failures:

1. A failure is logged to `$XDG_STATE_HOME/xtrm/pane-sync.log` and never changes the exit status of the Substrate operation.
2. A caller that injects a scratch store (`runCli` with `dbPath`) never touches panes.

Representation: `sb` unsets the option, so none means absent. `agent-state.sh off` sets the option to an empty string. Readers treat an absent option and an empty option as none.

### Child launch

A launch unsets every identity key it does not write (`@agent_issue`, `@agent_bead`, `@agent_role`, `@agent_holder`, `@agent_dispatcher`, `@agent_parent_pane`), so a reused pane keeps none of those keys from its previous occupant. Other options (`@agent_task`, `@agent_worktree`, `@agent_branch`, `@agent_state`, `@agent_instance_id`) follow their own owners. A child launched by an agent gets its own `@agent_role`, `@agent_issue` and `@agent_holder`. The launcher never forwards the parent's `XTMUX_AGENT_ROLE`, `XTMUX_AGENT_ISSUE` or `XTMUX_AGENT_HOLDER` to a child. A child without `--role` or `--issue` has those options empty.

### Specialists and inherited environment

An in-process specialist has its own role, claim and participant in Substrate. That identity is correct and this schema does not change it. A specialist process can still inherit `XTMUX_AGENT_*` and the pane variables of its launcher. Decisions:

1. Claim sync never trusts `$TMUX_PANE` or the inherited environment for ownership. `$TMUX_PANE` only locates the pane. Ownership is the equality of the operation's holder and the pane's `@agent_holder`.
2. A claim made under another holder (a specialist, or `--holder <other>`) does not change the pane.
3. This change adds no reader that takes identity from an inherited `XTMUX_AGENT_ROLE`. Existing readers keep their precedence: live pane option, then environment. The `pm_role.py` workaround by `-sp-` worktree name stays.
4. The launcher strips the parent's `XTMUX_AGENT_*` only for children it launches (`xt claude|pi|codex`). It does not rewrite the environment of an in-process specialist. Removing that inheritance is not done here: the host that spawns specialists owns that environment.

### Exited agent

A pane whose agent process exited is not live. A reader derives the state: when `@agent_state` is `idle`, `running` or `needs-input` and `#{pane_current_command}` is a login shell (`zsh`, `bash`, `sh`, `fish`), the effective state is `exited`. Readers do not rewrite the option.

## Other variables

| Variable | Owner | Meaning |
|---|---|---|
| `SUBSTRATE_HOLDER` | Launcher | Holder name of the session. Copied to `@agent_holder`. |
| `XTRM_DISPATCHER_NAME`, `XTRM_DISPATCHER_ADDRESS`, `XTRM_DISPATCHER_PARTICIPANT` | Launcher | Messaging identity of the dispatcher. `XTRM_DISPATCHER_PARTICIPANT` equals `@agent_dispatcher`. |
| `XTRM_PARENT_PANE_ID`, `XTRM_PARENT_SESSION_ID` | Launcher | Equal `@agent_parent_pane` and `@agent_parent_session`. |
| `XTRM_SESSION_SOCKET` | Launcher | Path of the tmux socket the seat lives on. The placement rule confirms an inherited pane or session id against this socket, so an id is never read on the wrong server. |
| `XTRM_ROLE` | Launcher | Role used for identity resolution. |

## Placement

Where a new seat opens its pane is a separate rule, documented once in [tmux-placement.md](tmux-placement.md). The target session is the explicit `--session` flag, else the caller's own session (its pane id, `$TMUX`, or the launcher's exports — each confirmed on the socket that identity came from, `$TMUX`'s or `XTRM_SESSION_SOCKET`), else `session` in `~/.xtrm/config/launch.json`. A new session is the last resort and is announced on stderr; an identity whose server is unknown is not trusted, and the launcher says so.

This matters to identity in one place: a child launched from a process without `$TMUX` records the session that placement resolved as its `@agent_parent_session`, so the relationship options stay correct for a dispatched agent, an in-process specialist, the app and a remote caller.

## Migration

- A pane launched before this change carries `@agent_bead` and no `@agent_holder`. Readers fall back to `@agent_bead`. Claim sync skips such a pane because it has no `@agent_holder`. Relaunch the pane to enable claim sync.
- `xt attach` of an old worktree restores `@agent_issue`, `@agent_holder` and the relationship options.
- Scripts that call `xt ... --bead` keep working through the deprecated alias.
