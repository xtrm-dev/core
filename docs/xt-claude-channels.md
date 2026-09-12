# `xt claude` channel wake

`xt claude` launches a Claude Code session that a settling specialist can wake
directly, instead of leaving the session on the `asyncRewake` polling hook.
This page records what the launcher does on its own and the one thing it cannot
do for you: the host policy file that Claude Code requires before it will
accept the channel.

Issue: XTRM-249.

## What the launcher does

When the runtime is `claude` **and** the specialists plugin is installed for the
invoking user, `xt claude` adds one flag to the runtime argv:

```
--channels plugin:specialists@xtrm
```

The entry id is `plugin:<plugin name>@<marketplace>`. The plugin was renamed
from `substrate` to `specialists` on 2026-09-11; the old id no longer resolves.

`xt claude` also forwards `XTRM_SUBSTRATE_DIR` into the tmux session with
`tmux new-session -e`. A tmux session inherits the tmux **server** environment,
not the environment of the process that ran `tmux new-session`, so an exported
`XTRM_SUBSTRATE_DIR` did not otherwise reach the launched runtime, and
`specialist_dispatch` inside the session was refused with
`work_item_store_unavailable`.

The launcher never passes `--dangerously-load-development-channels`. That flag
prints an interactive confirmation dialog on every launch, which would block
automated dispatch.

## Required managed settings

Claude Code refuses a channel entry that is not on an approved allowlist. The
allowlist is a managed (host policy) setting. Without it, the flag is accepted,
the session starts normally, and the channel is silently dropped.

An unset `allowedChannelPlugins` does not mean "allow everything". It falls back
to a default allowlist that Claude Code fetches from the server, and that list
does not carry this plugin, so the default outcome on an unconfigured machine is
a refusal rather than a pass.

Create the policy file as root:

| OS | Path |
| --- | --- |
| Linux | `/etc/claude-code/managed-settings.json` |
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` |

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [{ "plugin": "specialists", "marketplace": "xtrm" }]
}
```

Two details that are easy to get wrong:

- **`allowedChannelPlugins` holds objects, not strings.** The managed-settings
  schema is an array of `{ marketplace, plugin }`, and the gate compares
  `entry.plugin` and `entry.marketplace` separately. A string such as
  `"specialists@xtrm"` never matches and the channel stays blocked.
- **`channelsEnabled: true` is required *because* you created this file.** The
  policy gate is `policySettings !== null && policySettings.channelsEnabled !== true`
  (and, on a claude.ai Team or Enterprise org, `channelsEnabled !== true`
  regardless). With no managed-settings file at all the gate passes, because
  `policySettings` is null. Writing the file to set the allowlist therefore arms
  a gate that was previously open. Setting both keys together keeps it open.

There is no per-user escape hatch. `CLAUDE_CODE_MANAGED_SETTINGS_PATH` does not
redirect this read: with it set, Claude Code still logs
`Broken symlink or missing file encountered for settings.json at path: /etc/claude-code/managed-settings.json`
and still refuses the entry.

## Why absence is not an error

Claude Code gates channel registration at seven points, in this order:

1. the MCP server did not declare the `claude/channel` capability
2. the provider is Bedrock, Vertex or Foundry
3. the channels feature is not currently available
4. channels are not enabled by org policy
5. the entry is not in this session's `--channels` list
6. the installed plugin comes from a different marketplace than the entry names
7. the plugin is not on the approved channels allowlist

Every one of them fails **silently** — a single `[DEBUG]` line, no error, no
non-zero exit. Treating the absence of a channel as fatal would make `xt claude`
unusable anywhere the policy file is missing, which is every machine that has
not been deliberately configured. So the launcher fails soft at every step:

- plugin manifest missing, unreadable, or malformed → no flag
- plugin not listed in the manifest → no flag
- runtime is not `claude` → no flag

In all of those cases the session launches exactly as it did before, and a
settling specialist still wakes it through the `asyncRewake` polling hook. The
flag is an accelerator for the wake path, not a launch requirement.

## Verifying

Launch with the debug log enabled:

```bash
xt claude <slug> -- --debug --debug-file /var/tmp/claude-channels.log
```

Registration succeeded when the log contains:

```
MCP server "plugin:specialists:specialists": Channel notifications registered
```

Delivery succeeded when, after a dispatched specialist settles, the log
contains `notifications/claude/channel` and the session shows a line beginning
`<- specialists:`.

The allowlist is missing when the log instead contains:

```
MCP server "plugin:specialists:specialists": Channel notifications skipped: plugin specialists@xtrm is not on the approved channels allowlist
```

When the policy file exists but omits `channelsEnabled`, the skip reason is
`channels not enabled by org policy (set channelsEnabled: true in managed settings)`.
