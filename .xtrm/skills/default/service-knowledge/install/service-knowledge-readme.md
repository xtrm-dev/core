# service-knowledge

> **Reframe:** this is the operational **knowledge** system for a repo's services — skills
> today, with room for docs/playbooks/runbooks tomorrow. Elevated from the vendored
> `service-skills` machinery to a first-class package with its own CLI and lifecycle. It is
> **not** routed through `xt update --apply`.

## Install

```bash
pip install service-knowledge        # or: pip install -e ~/dev/xtrm/packages/service-knowledge
cd <your-service-hosting-repo>
service-knowledge install
```

Idempotent. `install` vendors the machinery into `.xtrm/skills/default/service-knowledge/`,
migrates any legacy `service-skills` umbrella to `service-knowledge` (rewriting registry
path refs and regenerating the `<repo>-service-knowledge` umbrella), wires the Claude
SessionStart/PreToolUse/PostToolUse hooks into `.claude/settings.json`, installs the
non-blocking git reminders, and creates the empty `.xtrm/cache/service-knowledge.sqlite`
(schema + rows populated by `service-knowledge index build`, auto-run by `install`).

## CLI

| Command | Effect |
|---|---|
| `service-knowledge install` | Vendor + migrate + wire hooks (idempotent). |
| `service-knowledge update`  | Pull the installed package version into the repo (no diff if current). |
| `service-knowledge status`  | Report installed version, packs, service counts, cache. |
| `service-knowledge migrate` | One-time `service-skills` → `service-knowledge` umbrella rename. |
| `service-knowledge remove`  | Uninstall machinery + cache + hooks (keeps your per-service knowledge). |
| `service-knowledge index`   | `build` / `rebuild` (full rebuild), `query` (free-text retrieval), `stats` (index state + counts). |
| `service-knowledge drift`   | Scan for drift (writes pending marker) / `clear` (remove marker + rebuild index). |
| `service-knowledge canary`  | `status` / `enable` / `disable` auto-merge canary policy. |

All commands accept `--path <repo-root>` (default: git toplevel of cwd).

## Hooks wired

| Hook | Type | Trigger | Script |
|---|---|---|---|
| SessionStart | Claude | session opens | `scripts/cataloger.py` — injects `<project_service_catalog>` |
| PreToolUse | Claude | Read/Write/Edit/Glob/Grep/Bash | `scripts/skill_activator.py` — territory → inject §3.2 evidence bundle (narrow §3.7 blocking) |
| PostToolUse | Claude | Write/Edit | `scripts/drift_detector.py check-hook` — drift notification |
| pre-commit / pre-push / post-merge | Git | commit/push/merge | non-blocking doc + staleness + drift-sweep reminders |

## Backward compatibility

The machinery resolves the per-repo umbrella under **both** `service-knowledge` (preferred)
and `service-skills` (legacy fallback), so repos that have not migrated yet keep working
unchanged; likewise both drift-marker names are recognized (canonical wins when both exist).
New installs use `service-knowledge` names only. Run `service-knowledge migrate` once per repo
to retire the legacy names.

## Telemetry

Every install/update/migrate/remove appends one JSON line to
`.xtrm/state/service-knowledge/install.jsonl` with `component=sk-cli`. Grep by component.
No secrets are recorded.
