# `xt claude-route` — the consent-gated Claude Code route switch

The Claude Code route has exactly one operator-side switch: the reserved
`claude_bridge` block in the specialists user config that
[SPECIALISTS-4442](https://github.com/xtrm-dev/specialists) made the route
selector (Option A: an explicit allow list, no wildcard, no per-Specialist
copies). `xt claude-route` reads and writes that block. Nothing else.

The Specialists loader remains the authority for route *resolution*. The command
does not touch the runtime, does not install or configure `pi-claude-bridge`, and
never reads or writes credentials.

## Config file

The command writes the file the Specialists loader would already read, applying
the same precedence, so a write can never shadow a file that is in effect:

1. `$XDG_CONFIG_HOME/specialists/user.json` when `XDG_CONFIG_HOME` is set;
2. `~/.config/specialists/user.json` when it exists;
3. `~/.specialists/user.json` when that legacy file exists;
4. otherwise `~/.config/specialists/user.json` (created).

Every other top-level key is preserved. A malformed or non-object file is never
overwritten: the command refuses and prints the parse error.

## The block

```json
{
  "claude_bridge": {
    "enabled": true,
    "default_model": "claude-bridge/claude-sonnet-4-5",
    "specialists": ["worker", "reviewer"],
    "models": { "reviewer": "claude-bridge/claude-opus-4-5" }
  }
}
```

| Key | Meaning |
|---|---|
| `enabled` | machine consent; `false` means the route is off for every Specialist |
| `default_model` | model for a listed Specialist without a `models` entry; `claude-bridge/...` only |
| `specialists` | explicit kebab-case allow list; `[]` means no Specialist, never all |
| `models` | per-listed-name `claude-bridge/...` model |

Unknown keys, a wildcard or glob entry, a non-kebab-case name and a non-bridged
model are all rejected. Core mirrors those rules from the specialists schema; the
mirror is pinned by `cli/src/tests/claude-route-schema-pin.test.ts`.

## Commands

```bash
# read-only: enabled state, listed Specialists, bridge package
xt claude-route status
xt claude-route status --json

# write the allow list (consent required)
xt claude-route enable --specialist worker,reviewer \
  --model claude-bridge/claude-sonnet-4-5

# turn the route off, keeping the allow list
xt claude-route disable

# remove the key entirely
xt claude-route disable --purge
```

### Consent

`enable` refuses to write until the operator confirms. The confirmation names
the billing implication: turns run on Claude Code and are billed to the
operator's Claude subscription (Anthropic plan quota or API usage). Without a
TTY the command refuses; `--yes` states that same consent non-interactively.

### Why `disable` keeps the list

An absent block restores the legacy per-definition behaviour, where
`execution.claude_bridge` on a Specialists definition decides the route. Deleting
the block could therefore silently route work back to a billable subscription.
`disable` writes `enabled: false` and keeps the allow list, which is off for
every Specialist. `--purge` removes the key for an operator who wants the file
clean; verify no definition carries `execution.claude_bridge` afterwards.

The mirrored grammar is pinned by `cli/src/tests/claude-route-schema-pin.test.ts`.
That pin is a literal tripwire: it catches an edit to the identifiers and, given a
specialists checkout, verifies they still exist upstream. It does not detect
upstream decision changes, and the shipped skill text still describes the removed
per-Specialist switch until SPECIALISTS-4447 lands upstream and Core re-vendors it.

A block that fails validation cannot be switched off by editing one field of it —
`{ "enabled": false, "specialists": ["*"] }` is still invalid. `disable` refuses
and points at `disable --purge`, which removes it. Rewriting is deliberately not
automatic: core's schema is a mirror, so a specialists change could make a valid
operator block look invalid here, and silently replacing it would destroy an
allow list that the loader accepts. An unparseable file is never rewritten by any
`xt` command; repair it by hand.

### Warnings a write can emit

- **not a known Specialist** — a listed name does not appear in `sp list` for this
  install. The write still happens: the name may be defined in a layer the lookup
  does not see. A typo routes nothing until the name exists.
- **write was not atomic** — the sibling-temp rename failed (a container or
  network home, typically) and the file was written directly. The switch did
  change. A failure writing the temp file itself is a plain write failure and
  aborts before touching the destination; a failure of that fallback write reports
  that the file may be truncated, because the direct write truncates first.
- **legacy target** — the file in effect is `~/.specialists/user.json`, so the
  write goes there rather than shadowing it with a new `~/.config` file. Migrate
  before another tool creates the config-home file.

## `xt doctor`

The `Claude route` section reports the config path, whether the route is enabled,
the listed Specialists with their models, whether `pi-claude-bridge` is installed,
and a malformed block. It is advisory: a route problem never fails `xt doctor`.
