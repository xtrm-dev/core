---
name: agent-pitfalls
version: 1.1.0
description: Common pitfalls learned the hard way across recent sessions
---
## Common Pitfalls

Rules learned the hard way across recent sessions. Each entry: short rule, why it matters, paste-ready command.

- **Use `sb issue create --parent <ref>` for epic children.** Without it, children float orphaned and don't appear under `sb issue tree`.
  ```bash
  sb issue create --project <id> --parent CORE-10 --title "..." --kind task --contract <file|json>
  ```
  (`bd create --parent` below describes the retired Beads board; use it only for migration/history work.)

- **`sp stop` cleans `status.json`; `sp merge` then fails to resolve the chain.** Known limitation (unitAI-ofjvj, P0). For doc-only chains, fall back to manual merge — but accept that `tsc` and conflict-reporting gates are skipped.
  ```bash
  git merge --no-ff feature/<branch> -m "Merge feature/<branch>"
  ```

- **`--worktree` and `--job` are mutually exclusive.** Use `--worktree` for the first executor; use `--job <exec-job>` for reviewer and fix passes — it reuses the workspace instead of provisioning a new one. (`--bead` is the legacy alias for the bound Issue.)
  ```bash
  sp run executor --worktree --bead <impl> --background
  sp run reviewer --bead <review> --job <exec-job> --keep-alive --background
  ```

- **`--keep-alive` is required for resumable specialists.** Without it, reviewer/overthinker terminate after one turn and `sp resume` has nothing to attach to.
  ```bash
  sp run reviewer --bead <id> --job <exec-job> --keep-alive --background
  sp resume <job-id> "Reviewer PARTIAL. Fix only ..."
  ```

- **`--context-depth` default is 3, not 1.** Chained specialists see own Issue + predecessor + parent task. Reduce only with cause.
  ```bash
  sp run executor --bead <id> --context-depth 2 --background    # explicit override
  ```

- **`sb issue relate --kind blocks` for sequencing.** Use `--kind relates_to` for non-blocking "see also" links; `--kind discovered_from|supersedes|duplicates` for the rest.
  ```bash
  sb issue relate --from <child> --to <parent> --kind blocks
  sb issue relate --from <a> --to <b> --kind relates_to
  ```

- **A Specialist result is evidence, not Closure.** Read `sp result <job-id>` / the Journal result before resuming; verify, then close the Issue explicitly (`sb issue close`).
  ```bash
  sp result <job-id>                   # last turn
  sb journal latest <ref>              # bounded Journal window
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
