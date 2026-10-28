# Jira agent identity

Agents act in Jira as the `xtrm-bot` account, not as the operator (XT-190). Jira shows the real actor; the `[agent:<holder> | run:<id>]` comment header, where agents write one, names the session.

## Which process counts as an agent

A process is an agent when `SUBSTRATE_HOLDER` is set, or when a `claude`, `pi` or `codex` process is one of its ancestors. The second rule covers sessions that were resumed without the variable. `XTRM_JIRA_AS=operator` forces the operator account. An explicit `JIRA_EMAIL` or `JIRA_TOKEN_FILE` always wins for `jira.py`.

## Pieces on a machine

| Piece | Path | Made by |
|---|---|---|
| Agent API token (secret, mode 600) | `~/.secrets/atlassian-agent-token.txt` | the operator |
| Identity (site, email, token path; no secret) | `~/.xtrm/identities/atlassian-agent/identity.json` | `xt jira setup` |
| Isolated `HOME` with the bot's acli profile | `~/.xtrm/identities/atlassian-agent/home` | `xt jira setup` |
| acli shim | `~/.local/bin/acli` (must come before the real `acli` on `PATH`) | `xt jira setup` |

`jira.py` (programme-coordination) reads `identity.json`. `xt` never writes, copies or prints the token.

## Set up

1. Create the Atlassian account for the agent. Give it access to the Jira site and to each project the agents use (XT, ISSUE). Grant browse, create, edit, comment, transition and assign. Do not grant project administration or issue deletion.
2. Log in as that account, create an API token, and save it with `install -m 600 /dev/null ~/.secrets/atlassian-agent-token.txt`, then edit the file.
3. Run `xt jira setup --email <agent account email>`. The shim is installed last, after the bot login is verified.
4. Run `xt jira doctor`. Every line must show a check mark.

## Default assignee

A ticket an agent creates is assigned to `xtrm-bot` unless the caller names an assignee:

- `acli jira workitem create` through the shim gets `--assignee @me` (or `"assignee": "@me"` in a private temp copy of the `--from-json` file). Help, `--generate-json` and other commands are untouched.
- `jira.py POST /rest/api/3/issue` by the agent identity gets `fields.assignee.accountId`.
- `xt jira sweep` lists the tickets the bot reported that are still unassigned; `xt jira sweep --apply` assigns them. It is the net for creation paths the two above do not cover (for example `acli workitem create-bulk`). `--days N` sets the look-back (default 14).

The Jira project lead and default assignee are not changed: that would also assign tickets the operator creates to the bot and send lead notifications to an account nobody reads.

## Operate

- Sessions started by `xt claude|pi|codex` carry `SUBSTRATE_HOLDER`. A session resumed with `xt attach` gets it again from the worktree name.
- A running session cannot gain an environment variable. Jira routing does not need one (the ancestor rule), but Substrate Journal attribution does: re-attach such a session with `xt attach`.
- Agent without a bot profile: the shim exits 78 and says so. It never falls back to the operator silently.
- Rollback: remove `~/.local/bin/acli`.
