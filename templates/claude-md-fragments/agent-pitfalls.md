---
name: agent-pitfalls
version: 1.0.0
description: Common pitfalls learned the hard way across recent sessions
---
## Common Pitfalls

Rules learned the hard way across recent sessions. Each entry: short rule, why it matters, paste-ready command.

- **Use `bd create --parent <epic-id>` for epic children.** Auto-names children `.1`, `.2`, … and adds the parent edge. Without it, children float orphaned and don't appear under `bd dep tree <epic>`.
  ```bash
  bd create --parent unitAI-abc12 --title "..." --type task --priority 2
  ```

- **Memory gate must ack BEFORE `bd close`.** `bd close` is blocked until `memory-acked:<id>` exists. Run `bd remember` (or decide nothing novel), then set the kv, then close. Each id in a batch needs its own ack.
  ```bash
  bd remember "<insight>"                                  # if novel
  bd kv set "memory-acked:<id>" "saved:<key>"              # OR "nothing novel:<reason>"
  bd close <id> --reason="..."
  ```

- **Never run bare `bv` — it opens a TUI and blocks the session.** Always use `--robot-*` flags.
  ```bash
  bv --robot-triage --format toon
  bv --robot-next
  ```

- **`sp stop` cleans `status.json`; `sp merge` then fails to resolve the chain.** Known limitation (unitAI-ofjvj, P0). For doc-only chains, fall back to manual merge — but accept that `tsc` and conflict-reporting gates are skipped.
  ```bash
  git merge --no-ff feature/<branch> -m "Merge feature/<branch>"
  ```

- **`--worktree` and `--job` are mutually exclusive.** Use `--worktree` for the first executor; use `--job <exec-job>` for reviewer and fix passes — it reuses the workspace instead of provisioning a new one.
  ```bash
  sp run executor --worktree --bead <impl> --background
  sp run reviewer --bead <review> --job <exec-job> --keep-alive --background
  ```

- **`--keep-alive` is required for resumable specialists.** Without it, reviewer/overthinker terminate after one turn and `sp resume` has nothing to attach to.
  ```bash
  sp run reviewer --bead <id> --job <exec-job> --keep-alive --background
  sp resume <job-id> "Reviewer PARTIAL. Fix only ..."
  ```

- **`--context-depth` default is 3, not 1.** Chained specialists see own bead + predecessor + parent task. Reduce only with cause.
  ```bash
  sp run executor --bead <id> --context-depth 2 --background    # explicit override
  ```

- **`bd query` for SQL-like compound filters.** Beyond `bd ready` / `bd list`, use `bd query` for predicates.
  ```bash
  bd query "status=in_progress AND assignee=me"
  bd query "type=bug AND priority<=1 AND status=open"
  ```

- **`bd dep <blocker> --blocks <blocked>` is the reverse-direction shorthand of `bd dep add`.** `bd dep add A B` ⇒ A depends on B. `bd dep B --blocks A` is the same edge in blocker-first phrasing. Use `bd dep relate` for non-blocking "see also" links.
  ```bash
  bd dep add child parent              # child depends on parent
  bd dep parent --blocks child         # same edge, blocker-first phrasing
  bd dep relate <a> <b>                # non-blocking link
  ```

- **Per-turn output auto-appends to bead notes for ALL specialists** (not just READ_ONLY). `bd show <bead-id>` reveals the full handoff with `[WAITING]` / `[DONE]` headers — read it before resuming, no need to scrape `sp result`.
  ```bash
  bd show <bead-id>                    # full transcript
  ```

- **GitNexus index goes stale on commit. Preserve embeddings explicitly when reanalyzing.** Running `npx gitnexus analyze` without `--embeddings` deletes any embeddings.
  ```bash
  jq '.stats.embeddings' .gitnexus/meta.json    # 0 = none
  npx gitnexus analyze --embeddings             # only if embeddings exist
  ```

- **`sp poll` is deprecated.** Use `sp ps` for state and `sp feed` for streams. `sp result <job-id>` works on waiting jobs and returns the last completed turn with a `sp resume` footer.
  ```bash
  sp ps                                # live job snapshot
  sp ps <job-id>                       # one job
  sp feed <job-id>                     # stream events for one job
  sp feed -f                           # follow all
  sp result <job-id>                   # last turn (works on waiting jobs)
  ```
