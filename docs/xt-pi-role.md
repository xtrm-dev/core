# `xt pi --role` and `xt claude --role`

Interactive **specialist role launcher.** Boots a fresh pi (or claude) session in a sandboxed worktree, wired up as a named specialist (via `sp view`), with the pane's `@agent_*` metadata already set for orchestrator routing.

The same flag surface works for both runtimes; differences are called out explicitly below.

---

## Quick start

```bash
# Case (i): launch pi tracked to a bead — sp render-task fills the initial prompt
xt pi --role chain-coordinator --bead xyz-1

# Case (ii): launch claude with a literal initial prompt, reviewer's skills auto-loaded
xt claude --role reviewer --prompt 'review the auth changes in cli/src/auth/'

# Case (iii): skills-only prime — pane loads the role's skills and idles until you type
xt pi --role researcher
```

Inside `$TMUX`, both commands **run in the current pane** by default — no nested-tmux warning, no new session in `tmux ls`. Outside `$TMUX`, both create a new tmux session and attach.

`--bead` and `--prompt` are mutually exclusive; pass one or neither.

---

## Turn-1 composition (case-by-case)

The launcher composes exactly one initial user message from three pieces:

1. **skill prefix** — an sp-owned `/skill:name` (pi) or newline-separated `/<name>` commands (claude) that force-load the specialist's declared skills at turn 1
2. **body** — either the rendered tracked task (`--bead`), your literal text (`--prompt`), or empty (neither)
3. **byte guard** — literal `--prompt` payloads stay under 50 KB; rendered beads may use the runtime's safe per-argument limit (131071 bytes)

| Invocation | Body source | Composition |
| --- | --- | --- |
| `--bead <id>` | `sp render-task <role> --bead <id>` output (already prefixed by sp — Option A) | `<render-task output>` verbatim |
| `--prompt "text"` | `"text"` verbatim | `sp render-skill-prefix` + `"text"` |
| neither | empty | `sp render-skill-prefix` alone (pane primes skills and idles) |

No prompt/task file is created. Current-pane launches pass the exact positional message directly; new-session launches start a fixed wrapper, wait up to five seconds for its consumer-ready signal, then load and signal the transient tmux buffer. The wrapper also bounds its payload-ready wait to five seconds, so parent disappearance exits the pane and deletes any loaded buffer. The buffer is deleted after consume or launcher-controlled failure, and failed handshakes kill the blocked session. The same-user process/tmux server is a trusted local control plane: the buffer is transport, not secret storage, and beads/prompts must not contain credentials or secrets.

---

## Flag surface

| Flag | Meaning | Notes |
| --- | --- | --- |
| `--role <name>` | Resolve `<name>` via `sp view <name> --raw --surface <runtime>` and boot the runtime with the specialist's system prompt, skills, model, and thinking level. | The Specialists resolver selects model defaults for the target surface; CLI flags override. Pi falls back to legacy `sp view` only for older Specialists releases. Claude fails clearly instead of accepting an unscoped provider default. |
| `--bead <id>` | Render the tracked task as the initial user prompt via `sp render-task`, and attach `<id>` to the pane via `@agent_bead`. | Mutually exclusive with `--prompt`. Included in the session name slug (`role-<runtime>-<slug>-<bead>`). |
| `--prompt <text>` | Use `<text>` as the initial user prompt. Combines with the sp-owned skill prefix. | Mutually exclusive with `--bead`. For anything larger than a paragraph, prefer `--bead` — a beads issue is a better container than a shell argv. |
| `--no-attach` | New-session mode only. Print `session_name:pane_id` on stdout and exit — orchestrator-capture pattern. | Inside `$TMUX` without `--new-session`, `--no-attach` **errors** with a clear hint. |
| `--model <name>` | Forward `--model <name>` to the runtime; overrides `specialist.execution.model`. | Both pi and claude accept `--model`. |
| `--thinking <level>` | pi only. Forward `--thinking <level>`; overrides `specialist.execution.thinking_level`. | claude has no `--thinking` flag — `xt claude --thinking X` warns loudly and drops. |
| `--skill <name-or-path>` | Load one additional skill at startup; repeatable. | Pi receives `--skill`. Claude accepts it only when the exact canonical path is already discoverable under project/global `.claude/skills/<name>`; otherwise launch fails before worktree creation. Role declarations into a repo-managed tier are the sole relaxation — see §Skills. |
| `--new-session` / `--ns` | Force a fresh tmux session even when inside `$TMUX`. | Default outside `$TMUX`. Combines with `--no-attach`. |
| `--parent <target>` | Override `@agent_parent_session` on the target pane. `<target>` = tmux session name, session id (`$3`), or `#{session_id}` string. | Bogus targets fail with a clear error before the runtime spawns. Precedence: `--parent` > `--child` > auto. |
| `--child` | Explicit form of the auto-behavior (`@agent_parent_session` = current pane's `#{session_id}`). | Kept as a stable opt-in against a future default flip. |
| `--reuse` | Only with `--new-session` (or outside `$TMUX`): if a session with the resolved name already exists, attach to it (or, with `--no-attach`, print its coordinates) instead of auto-suffixing. | Skips `agent.role.launched` emission — we don't own the reused pane's metadata. |
| `--subordinate` | Canonical subordinate-coordinator launch (audit P0-05). Expands to `--new-session --no-attach --child`. | Requires `--role`. An explicit `--parent` still wins. Outside `$TMUX` it requires `--parent` (there is no current session to infer one from). See §Subordinate coordinator launch. |
| `--` `<passthrough>` | Everything after `--` forwarded verbatim to the runtime. | Guarded flags (`--session-dir`, `--name`, `--system-prompt`, `--append-system-prompt`, `--skill`) are rejected. Batch-mode flags (`--print`, `--list-models`, `--export`, `--mode`) are dropped with a warning. |

Run `xt pi --help` or `xt claude --help` for the canonical (auto-generated) flag list plus concrete examples.

---

## Behavior matrix

| Context | Flags | Result |
| --- | --- | --- |
| inside `$TMUX` | (none) | Runtime runs in the **current pane**; pane options + `XTMUX_AGENT_*` env set on this pane. `tmux ls` unchanged. |
| inside `$TMUX` | `--new-session` | New session (`role-<runtime>-<slug>-<bead>`); `switch-client` moves the current client to it. |
| inside `$TMUX` | `--new-session --no-attach` | New session detached; prints `session_name:pane_id` on stdout. Exit 0. |
| inside `$TMUX` | `--no-attach` alone | **Error** — `--no-attach requires --new-session (or exit tmux first)`. |
| outside `$TMUX` | (any) | New session; `attach-session` attaches. `--no-attach` still valid. |
| inside `$TMUX` | `--subordinate` | New detached session parented to the current one; prints `session_name:pane_id`. The launching pane is untouched. |

---

## Subordinate coordinator launch (audit P0-05)

Inside `$TMUX` a role launch defaults to the **current pane**. That is right when
the operator wants this pane to become the role. It is wrong for spawning a
subordinate coordinator: it overwrites the orchestrator's own `@agent_*`
metadata and replaces the orchestrator process.

`--subordinate` is one verb for the safe shape:

```bash
xt pi coord --role chain-coordinator --bead <epic> --subordinate
```

is equivalent to

```bash
xt pi coord --role chain-coordinator --bead <epic> \
  --new-session --no-attach --parent "$(tmux display-message -p '#{session_id}')"
```

It expands to flags the launcher already understands rather than adding a third
launch mode, so there stays exactly one code path to reason about.

**What it does not imply.** `--subordinate` never means *no worktree*, *shared
branch*, or *direct main integration*. Every interactive launch owns a distinct
worktree and branch (see §Worktree and branch isolation), and the coordinator is
no exception — that isolation is what its specialist chains derive from.

### Launch validation (audit P1-05)

Every check below fires **before any worktree is created**, so a rejected launch
leaves nothing on disk (asserted end-to-end in
`cli/src/tests/coordinator-launch-validation.test.ts`). Each prints the canonical
long-form command as remediation.

| Condition | Message |
| --- | --- |
| no `--role` | `--subordinate is a coordinator launch and requires --role` |
| no `--bead` | `--subordinate scopes a coordinator to one epic and requires --bead` |
| outside `$TMUX` with no `--parent` | `subordinate coordinator requires a parent session` |
| role declares `execution.interactive: false` | `role '<name>' declares execution.interactive=false — it is a background job, not a session` |
| launching pane already runs the same role | `nested coordinator: this pane is already running role '<name>'` |

`interactive` is tri-state: only an explicit `false` rejects. A Specialists
release that does not declare the field stays launchable.

The nested-coordinator rule compares the launching pane's `@agent_role` to the
role being launched, so it generalizes to any self-nesting role instead of
hard-coding `chain-coordinator`. A pane running a *different* role is still a
valid parent.

The audit's remaining two preconditions are already covered without new code:
required coordination skills resolve (`resolveRequestedSkills` throws on a
missing path, before worktree creation), and a dedicated worktree and branch can
be created (the existing-path refusal plus create-or-fail). "The target scope is
one epic or task-group" is **not enforceable in Core** — telling an epic bead
from a task bead would mean owning beads semantics; the coordinator establishes
that itself on its first turn via `bd show`.

### Merge authority

A subordinate session may publish its branch and open a PR; it may not merge into
`main`. `xt merge` refuses to run from a pane that carries `@agent_role` and names
a different session as its parent, with `--override-authority` for the operator
and `--dry-run` always allowed. Full ladder and enforcement table:
[`architecture/coordinator-branch-ancestry.md`](./architecture/coordinator-branch-ancestry.md).

---

## Worktree and branch isolation

Core treats this as an invariant (audit P1-02):

> every interactive `xt` runtime owns a distinct worktree and branch

It is enforced by construction rather than by a flag check — `launchWorktreeSession`
unconditionally creates `.xtrm/worktrees/<repo>-xt-<runtime>-<slug>` on branch
`xt/<slug>`, refuses to reuse an existing worktree path, and refuses to create a
nested worktree from inside another worktree (which is what keeps the main
orchestrator in the main worktree). There is deliberately **no `--no-worktree`**
for interactive role launch, and none should be added.

The relationship is published as pane options and env vars so downstream tools
can observe it — see the two tables below.

**Session-name collision.** When the resolved session name (`role-<runtime>-<slug>[-<bead>]`, e.g. `role-pi-chain-coordinator-xyz-1` vs `role-claude-chain-coordinator-xyz-1`) is already in use, the launcher does one of two things:

- `--reuse` passed → attach to the existing session (or print `session:pane` with `--no-attach`) and exit. Skips the pane-option write + `agent.role.launched` emission since the pane is not fresh.
- otherwise → auto-suffix a 4-char hex slug and retry up to 10 times (`role-<runtime>-<slug>[-<bead>]-<hex>`). If all 10 candidates collide, errors with a hint to pass `--reuse` or free some session names.

---

## Session names

Session names encode both the runtime and the specialist role so `xt pi --role X` and `xt claude --role X` produce distinguishable sessions:

```
role-pi-<role-slug>[-<bead-slug>]
role-claude-<role-slug>[-<bead-slug>]
```

Example: `xt pi --role chain-coordinator --bead xyz-1` → `role-pi-chain-coordinator-xyz-1`; `xt claude --role chain-coordinator --bead xyz-1` → `role-claude-chain-coordinator-xyz-1`. Both coexist without `--reuse` or auto-suffix.

## Pane options set at launch

The launcher writes these on the target pane (current pane by default, new session's first pane in `--new-session` mode). The picker + safe-send-pointer + handoff all consume them.

| Option | Value |
| --- | --- |
| `@agent_task` | `role:<name>` |
| `@agent_parent_session` | Resolved `#{session_id}` (see `--parent` precedence above) |
| `@agent_state` | `idle` — set at spawn so the picker sees the pane immediately (before the runtime's own agent-state hook fires) |
| `@agent_worktree` | Absolute path of the worktree this session owns |
| `@agent_branch` | Branch checked out in that worktree — the integration branch a coordinator's specialist chains derive from (audit P1-03) |
| `@agent_bead` | Only set when `--bead <id>` was passed |
| `@agent_role` | Role name. Role launches only — a bare session has no role |

`@agent_prompt_file` was retired in xtrm-8zsi1 — the launcher no longer materializes a prompt file. Downstream skills already read the option absence-safely.

`@agent_worktree` / `@agent_branch` / `@agent_role` were added in xtrm-6hey0.
The isolation they describe was always enforced; nothing downstream could
*observe* it. `@agent_branch` is Core's half of branch ancestry: Core publishes
the base branch, Specialists consumes it when creating `sp/*` branches.

---

## Environment variables exported to the runtime

Redundant with pane options on purpose — env survives re-execs the way pane options don't. `scripts/agent-state.sh` reads these on first turn.

| Variable | Source |
| --- | --- |
| `XTMUX_AGENT_TASK` | `role:<name>` |
| `XTMUX_AGENT_PARENT_SESSION` | Same value as `@agent_parent_session` |
| `XTMUX_AGENT_WORKTREE` | Same value as `@agent_worktree` |
| `XTMUX_AGENT_BRANCH` | Same value as `@agent_branch` |
| `XTMUX_AGENT_BEAD` | Only set when `--bead <id>` was passed |
| `XTMUX_AGENT_ROLE` | Same value as `@agent_role`; role launches only |

The env set is **derived from the pane options** (`buildAgentEnv`), one entry per
option with `@agent_x` → `XTMUX_AGENT_X`, so the two cannot drift. `@agent_state`
is the single exception: it is launcher-local bookkeeping owned by the runtime's
own agent-state hook after turn 1, so there is no `XTMUX_AGENT_STATE`.

`XTMUX_AGENT_PROMPT_FILE` was retired in xtrm-8zsi1 alongside the prompt-file transport.

In `--new-session` mode these are exported via `tmux new-session -e KEY=VAL ...` so they land in the new pane's environment. In current-pane mode they're passed to the runtime via `spawnSync`'s `env`.

---

## Log emission

At launch time (both modes) the launcher shells out to `tmux-session-picker` to emit `agent.role.launched` plus a companion `agent.role.task-rendered` event containing renderer outcome, prompt hash, and bounded component sizes. It never logs the rendered body. Log emission is non-fatal if the picker binary is missing.

Query the log with `tmux-session-picker log query --type agent.role.launched --since 2h` for a "who spawned what" audit trail.

---

## Skill and model resolution

**Skills.**

Skill delivery is now uniform across cases: sp emits a `/skill:name` (pi) or newline-separated `/<name>` commands (claude) block at position 0 of the turn-1 body, and the runtime's slash-command parser force-loads each skill's `SKILL.md` body on receipt.

- **Ownership.** When available, `sp render-skill-prefix <role> --surface pi|claude` (specialists unitAI-qeguh) is the canonical block. With older sp versions, core renders the same surface from the merged role's validated `skills.paths` metadata. Tracked `render-task` output is stripped only when it begins with the exact canonical block; otherwise it is treated as untrusted task text, so a skill-looking task cannot impersonate the prefix.
- **pi.** Combined with `--no-skills` (pool isolation) and `--skill <path>` per declared skill, only the specialist's declared skills are reachable. `specialist.skills.paths[]` from `sp view` resolves:
  1. absolute or `~`-prefixed → used verbatim
  2. relative + exists at repo root → repo-local override
  3. relative + exists at `$HOME` → canonical global (post-`xtrm-bq7yd` migration; see the CHANGELOG entry for xtrm-1rn)
  4. otherwise → repo-resolved path so pi produces a loud "skill not found" error at the exact absolute location the operator can fix
- **claude.** No `--no-skills` equivalent exists (`--bare` is nuclear). Project/global `.claude/skills` auto-discovery remains; newline-separated `/<name>` commands force body load. Explicit requests are accepted only when the discovered `SKILL.md` realpath matches the requested path, preventing same-name substitution or silent path loss.
- **repo-managed role declarations.** A role skill that resolves into `<repo>/.xtrm/skills/{default,optional}/<name>/` is a name reference, not a path pin. Those tiers are authoring/vendor sources, not installed runtime scopes (`docs/skills-tier-architecture.md`, CORE-2516), and sp prefers a repo-local copy over the installed pool — but Claude can only load `/<name>` from its own discovery roots. The launcher therefore accepts the enabled view's same-named skill (`~/.claude/skills/<name>/`, which must canonicalise into `~/.xtrm/skills/`) and prints a `⚠` line naming the declared and the loaded directory. Without that, every role is unlaunchable in a repo that carries an authoring copy of a default skill. An explicit `--skill` path into the same tier is still refused: that is the operator pin, and the way to load the declared copy deliberately.
- **explicit requests.** `--skill` accepts an installed skill name, a skill directory, or a `SKILL.md` path. Requests are validated and realpath-deduplicated before provisioning. Pi receives them as `--skill <path>`; non-discoverable Claude requests fail before worktree creation.

**Model.**

The launcher requests a surface-resolved effective spec with `sp view <name> --raw --surface pi|claude`. Specialists may apply the generic default for Pi, but must not substitute that provider-only default for a role whose declared model is `null` on the Claude surface. Claude receives the configured Claude-surface model when one exists; otherwise it omits `--model` and lets Claude Code select its own default. Explicit `xt ... --model <name>` always wins, including valid Claude and custom-provider model identifiers. One exception on the Claude runtime: a model whose outer provider is a known non-Anthropic vendor (`qwencloud/…`, `openai-codex/…`, `openrouter/…`) is refused before worktree creation, and the same shape arriving as a role default is dropped with a warning so Claude Code inherits the parent model — claude cannot run those ids, and forwarding one produced a live session that died at turn 1 (xtrm-wiy5n.4.19). Unrecognised prefixes, Bedrock inference-profile ARNs and plain ids are untouched. A Specialists release without the Claude surface contract is rejected before worktree creation with an upgrade hint.

**Extensions (pi).**

The launcher no longer emits `--no-extensions -e <name>`. `pi -e` takes a filesystem path (not a registry name), and the prior curated allow-list caused silent startup crashes (see xtmux-3rs). pi discovers its own extensions from `~/.pi/agent/settings.json` plus any per-repo settings.

---

## Position-0 `/` invariant

sp's `/skill:name` block sits at literal byte 0 of the turn-1 body so the runtime's slash-command parser fires it. The launcher enforces this as a hard invariant:

- When `--prompt "/foo"` is passed and the specialist declares no skills (prefix is empty), the launcher rejects the launch with a message asking you to rename or repurpose. A bare `/foo` at position 0 would collide with the slash-command parser.
- When a `--bead` starts with `/`, it is accepted only when byte zero exactly matches the independently rendered sp prefix for the role. A skill-looking bead title cannot impersonate `/skill:` (pi) or a Claude `/<name>` command, including when the role declares no skills.

---

## Byte guard

Literal `--prompt` keeps the 50 KB combined system/body ceiling. `--bead` does not inherit that policy: the full `sp render-task` output is preserved up to 131071 bytes per runtime argument, the portable Linux argv boundary used by the launcher. NUL bytes and larger arguments fail before worktree creation.

A compact `read bead <id>` pointer is intentionally not substituted: it omits `sp render-task`'s dependency context, boundary instructions, mandatory rules, and rendered first-turn contract. New-session mode instead uses a bounded, cryptographically named tmux buffer so large rendered tasks stay out of the `tmux new-session` command without restoring prompt files. Buffer deletion is best-effort on consume, wrapper failure, launch failure, and handled signals; it does not provide secrecy from trusted same-server tmux peers.

---

## `sp run` parity boundary

| Component | Interactive role behavior |
| --- | --- |
| Effective specialist + system prompt | Same `sp view` resolution; role-only system prompt remains separate from the task. |
| Task template, bead/dependency context, boundary rules | Same specialists-owned `renderTaskPrompt` seam through `sp render-task`. |
| Mandatory rules | Same ordering and token limit; renderer failure is fatal for tracked interactive launch. |
| Pre-script output | Deliberately omitted: executing pre-scripts is job-runtime behavior. |
| Reviewer git-diff context | Deliberately omitted: execution-only and unavailable before the interactive session starts. |
| Job/RPC/status creation | Not applicable: rendering is read-only; `xt` owns only its sandbox worktree/tmux session. |
| Skills | sp-owned `/skill:name` prefix at turn 1 forces body load. Pi pool isolated via `--no-skills`; claude uses ambient `~/.claude/skills` discovery. Repeatable `--skill` deduplicates against specialist-declared skills. |

---

## Coordination pattern

A parent Claude Code / pi orchestrator spawns a child role session, drives it via `tmux-session-picker message-send`, and consumes its `turn done: …` messages:

```bash
# Parent orchestrator, from inside its own tmux session
xt pi --role researcher --bead xyz-1 --no-attach --new-session > /tmp/child.addr
# child.addr contains "role-pi-researcher-xyz-1:%42"
CHILD_TARGET=$(cat /tmp/child.addr)

# Route a task to the child
tmux-session-picker message-send \
  --to "$CHILD_TARGET" \
  --bead xyz-1 \
  --text "Please summarize the ~/notes/design.md brief."

# Later, poll the parent's inbox for the child's turn-done reply
tmux-session-picker message-list --for "$(tmux display-message -p '#{session_id}')" \
  --unacked --since 15m
```

The child role can escalate policy calls back to the parent by resolving its own `@agent_parent_session` pane option and calling `message-send` in the reverse direction.

---

## Related

- `xt pi --help` / `xt claude --help` — canonical flag list with examples.
- [docs/worktrees.md](worktrees.md) — the sandbox worktree model that underpins the launcher.
- `xtmux-1lb` epic in beads — surface completion history.
- xtrm-8zsi1 (this rewrite) supersedes the xtrm-osipt file-transport stopgap.
