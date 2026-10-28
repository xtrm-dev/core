# Jira agent identity

Agents act in Jira as the `xtrm-bot` account, not as the operator (XT-190). Jira shows the real actor. Because every agent shares that account, each agent write also names the session: a comment header and a label (see Write attribution).

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
4. Run `xt jira doctor`. Every line must show a check mark. The `shim current` line fails with `stale shim: run xt jira setup` when the installed shim differs from the one this `xt` version writes (the shim embeds the path of the real `acli`; the check compares the whole file byte for byte).

## Write attribution

The bot account does not say which session acted. Writes by an agent process (same rule as above) therefore carry a marker. `jira.py` and the `acli` shim apply the same rules. `XTRM_JIRA_AS=operator` turns all of it off.

Comments start with a header, then a blank line, then the text:

```
[agent:<holder> | run:<id>]
[agent:<runtime>-<worktree dir> | run:<id> | fallback]
```

- Covered: `jira.py comment`; `acli jira workitem comment create` and `acli jira workitem comment update` with `--body`, `-b`, `--body-file`, `-F` (plain text or ADF; the `=` spellings too); and `--body-adf <file>` of `comment update` (the header becomes the first paragraph of a private copy). `--edit-last` of `comment create` takes its text from the same body flags. `--key`, `--id` and all other flags pass through unchanged.
- Not covered: `--editor` (the interactive editor). The text is typed in a terminal editor that the shim cannot see; agents do not use it, so the flag passes through and the comment carries no header. `jira.py` has no comment update command.
- The header is added once. A text that already starts with `[agent:` is posted as it is, also when it replaces an earlier comment text with `comment update`.
- Holder: `SUBSTRATE_HOLDER`. When it is unset, the holder is `<runtime>-<worktree directory name>` (for example `claude-core-xt-foo`; the runtime is the nearest `claude`, `pi` or `codex` ancestor) and the header ends with ` | fallback`. A missing holder never stops a write.
- Run id: `SUBSTRATE_RUN_ID` when it is set. Otherwise six hex characters, the start of `sha1(boot id : pid : start time)` of the nearest `claude`, `pi` or `codex` ancestor (the session leader when there is none). Every write of one agent process gets the same id; another session, or the same pid after a reboot, gets another.
- A check can match `^\[agent:([^ |\]]+) \| run:([^ |\]]+)( \| fallback)?\]`.

`jira.py comment` returns the exact text it posted, for a read-back compare. The CLI keeps the `HTTP <status>` line and the JSON response and then prints `POSTED_TEXT <json string>`. In Python, `jira.post_comment(key, text)` returns `(status, response, posted_text)`. The posted text is the text of the ADF body: the header, then the paragraphs (split on blank lines, each stripped) joined by one blank line, with single line breaks kept.

Labels: an agent create, create-bulk, field edit and transition add the label `actor=agent`. Labels the caller supplies, and labels already on the ticket, are kept.

- Create: `jira.py POST /rest/api/3/issue` (labels merged), `acli jira workitem create` (`--label actor=agent` added, or `labels` in the private `--from-json` copy).
- Create-bulk: `acli jira workitem create-bulk` gets the label on every item. `--from-json` (`{"issues": [...]}` or a plain array): the item key `label` is merged in a private copy (acli reads `label` and silently ignores `labels`). `--from-csv`: the `label` column (comma separated labels) is merged in a private copy; the column is added when it is missing. A CSV without a `summary` column is not understood and goes through unchanged.
- Edit: `jira.py PUT /rest/api/3/issue/<KEY>` (also with a query string) adds `update.labels` `{"add": "actor=agent"}` and keeps the caller's `fields` and `update`. Jira refuses one field in both `fields` and `update`, so a caller's `fields.labels` (a replace) gets the label inside its own list. Other PUT routes (`/assignee`, `/comment/<id>`) are untouched. `acli jira workitem edit` gets `--labels actor=agent` (acli adds to the existing labels), or `actor=agent` appended to the caller's `--labels` value, or `labelsToAdd` in the private `--from-json` copy. An edit that removes the label (`--remove-labels` or `labelsToRemove` naming `actor=agent`) is left as it is.
- Transition: the label goes on first, then the status moves. `jira.py transition` sends `update.labels add`; the shim runs `acli jira workitem edit` with the same `--key`, `--jql` or `--filter` and `--labels actor=agent --yes`. When the label step fails, a warning goes to stderr and the transition still runs.

After a change to the shim, run `xt jira setup` again to install it; `xt jira doctor` (`shim current`) tells when that is due. `jira.py` is part of the programme-coordination skill.

## Default assignee

A ticket an agent creates is assigned to `xtrm-bot` unless the caller names an assignee:

- `acli jira workitem create` through the shim gets `--assignee @me` (or `"assignee": "@me"` in a private temp copy of the `--from-json` file). Help, `--generate-json` and other commands are untouched.
- `acli jira workitem create-bulk` through the shim gets the bot as assignee on each item that names none. acli refuses `@me` and an email in bulk files, so the shim writes the account id of the bot, read from the `account_id` of the bot's acli profile (`~/.xtrm/identities/atlassian-agent/home/.config/acli/jira_config.yaml`). `--from-json`: the `assignee` key of a private copy. `--from-csv`: the `assignee` column of a private copy (added when missing; a cell the caller filled is kept). When the account id cannot be read, the label is still added and the assignee is left to the sweep.
- `jira.py POST /rest/api/3/issue` by the agent identity gets `fields.assignee.accountId`.
- `xt jira sweep` lists the tickets the bot reported that are still unassigned; `xt jira sweep --apply` assigns them. It is the net for creation paths the above do not cover (for example a raw REST call that bypasses `jira.py`). `--days N` sets the look-back (default 14).

The Jira project lead and default assignee are not changed: that would also assign tickets the operator creates to the bot and send lead notifications to an account nobody reads.

Private copies (`--from-json`, `--from-csv`, `--body-file`, `--body-adf`) are written with mode 600 into a temporary directory inside the bot's `HOME` and removed after the command. The original file is never changed. A rewrite error never stops the command: the shim prints a warning and runs it unchanged.

## What is not covered

- `--editor` of `acli jira workitem comment create` (interactive editor): passes through without a header.
- `acli` run by hand in a terminal: a shell without `SUBSTRATE_HOLDER` and without a `claude`, `pi` or `codex` ancestor is the operator and is never touched.
- Other write verbs (`assign`, `clone`, `link`, `watcher`, `attachment`, `archive`, `delete`) and a raw `jira.py POST /rest/api/3/issue/<KEY>/comment`: they carry no header and no label. Use `jira.py comment` for comments.
- A multi-line cell in a `create-bulk` CSV: acli itself rejects it ("The request body is missing or invalid"), with or without the shim.


## Operate

- Sessions started by `xt claude|pi|codex` carry `SUBSTRATE_HOLDER`. A session resumed with `xt attach` gets it again from the worktree name.
- A running session cannot gain an environment variable. Jira routing does not need one (the ancestor rule), but Substrate Journal attribution does: re-attach such a session with `xt attach`.
- Agent without a bot profile: the shim exits 78 and says so. It never falls back to the operator silently.
- Rollback: remove `~/.local/bin/acli`.
