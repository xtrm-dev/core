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
| `@agent_prompt_file`, `XTMUX_AGENT_PROMPT_FILE` | removed; no writer, no reader |

## Pane options

The environment variable of each option is `XTMUX_AGENT_<NAME>`. The launcher derives it from the option, except `@agent_state` and `@agent_instance_id`, which have no variable.

| Option | Owner | Written by | Updated on | Meaning |
|---|---|---|---|---|
| `@agent_issue` | The agent that owns the pane | Launcher (seed, from `--issue`); `sb issue claim\|release\|close` (sync); `agent-state.sh` (seed only when empty) | `sb` claim, release, close by the pane's holder | The Substrate Issue the pane's agent holds. Empty when none. |
| `@agent_holder` | Launcher | Launcher | Launch, `xt attach` | The `SUBSTRATE_HOLDER` of the pane's agent. It decides pane ownership for claim sync. |
| `@agent_role` | Launcher | Launcher | Launch, `xt attach` | Role of the pane's agent. A child launch writes its own role. |
| `@agent_task` | Launcher | Launcher | Launch, `xt attach` | Task label (`role:<name>` or free text). |
| `@agent_parent_session` | Launcher | Launcher | Launch, `xt attach` | tmux session id (`$N`) of the dispatcher. The only authoritative parent source. |
| `@agent_parent_pane` | Launcher | Launcher | Launch, `xt attach` | tmux pane id (`%N`) of the dispatcher. |
| `@agent_dispatcher` | Launcher | Launcher | Launch, `xt attach` | `SUBSTRATE_HOLDER` of the dispatching session (the Substrate participant). |
| `@agent_worktree` | `agent-state.sh` after launch | Launcher (seed); `agent-state.sh` | Every state transition | Git worktree root of the pane's working directory. |
| `@agent_branch` | `agent-state.sh` after launch | Launcher (seed); `agent-state.sh` | Every state transition | Checked-out branch of that worktree. |
| `@agent_state` | `agent-state.sh` | Runtime hooks through `agent-state.sh` | Every state transition | `idle`, `running`, `needs-input`, `done`, `off`. |
| `@agent_instance_id` | `agent-state.sh` | `agent-state.sh` | `--new-instance` | Identity of one agent occupation of the pane. |

### Precedence rules

1. The owner writes the option. A component that is not the owner never overwrites it.
2. `XTMUX_AGENT_*` variables are frozen at launch. They seed an option only when the option is empty. A transition never overwrites a non-empty option from the environment.
3. A reader reads the live pane option first, then the environment, then the legacy name (`@agent_bead`, `XTMUX_AGENT_BEAD`).
4. A legacy name is read-only. No component writes `@agent_bead` or `XTMUX_AGENT_BEAD`.
5. `@agent_parent_session` is the only parent source. `XTRM_PARENT_SESSION_ID` is derived from the same resolution at launch and carries the same value.

### Claim sync

`sb issue claim`, `release` and `close` update `@agent_issue` as follows:

1. `sb` reads `$TMUX_PANE`. Without it, `sb` does nothing.
2. `sb` reads `@agent_holder` of that pane. `sb` continues only when it equals the holder of the Substrate operation. An in-process specialist or another holder has a different holder and never changes the parent pane.
3. After `claim`, `sb` sets `@agent_issue` to the claimed ref.
4. After `release` or `close`, `sb` sets `@agent_issue` to empty only when the option equals the released ref.
5. A failure is logged and never changes the exit status of the Substrate operation. Claim sync does not need the Substrate remote.

### Child launch

A child launched by an agent gets its own `@agent_role`, `@agent_issue` and `@agent_holder`. The launcher never forwards the parent's `XTMUX_AGENT_ROLE`, `XTMUX_AGENT_ISSUE` or `XTMUX_AGENT_HOLDER` to a child. A child without `--role` or `--issue` has those options empty.

### Exited agent

A pane whose agent process exited is not live. A reader derives the state: when `@agent_state` is `idle`, `running` or `needs-input` and `#{pane_current_command}` is a login shell (`zsh`, `bash`, `sh`, `fish`), the effective state is `exited`. Readers do not rewrite the option.

## Other variables

| Variable | Owner | Meaning |
|---|---|---|
| `SUBSTRATE_HOLDER` | Launcher | Holder name of the session. Copied to `@agent_holder`. |
| `XTRM_DISPATCHER_NAME`, `XTRM_DISPATCHER_ADDRESS`, `XTRM_DISPATCHER_PARTICIPANT` | Launcher | Messaging identity of the dispatcher. `XTRM_DISPATCHER_PARTICIPANT` equals `@agent_dispatcher`. |
| `XTRM_PARENT_PANE_ID`, `XTRM_PARENT_SESSION_ID` | Launcher | Equal `@agent_parent_pane` and `@agent_parent_session`. |
| `XTRM_ROLE` | Launcher | Role used for identity resolution. |

## Migration

- A pane launched before this change carries `@agent_bead` and no `@agent_holder`. Readers fall back to `@agent_bead`. Claim sync skips such a pane because it has no `@agent_holder`. Relaunch the pane to enable claim sync.
- `xt attach` of an old worktree restores `@agent_issue`, `@agent_holder` and the relationship options.
- Scripts that call `xt ... --bead` keep working through the deprecated alias.
