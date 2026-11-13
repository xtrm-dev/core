# METHOD — deciding and evidencing the Waiting Production status (rev 4)

Proposal only: the worker that produced this method applied no status. Rev 2 replaces rev 1's
premise, which was wrong in a way worth recording.

## 0. What rev 1 got wrong

Rev 1 tested "the merge commit is not an ancestor of `origin/stable`" and called a row that failed
that test *not deployed*. Being merged to `master` and promoted to `stable` says nothing about what
runs: each container has its own image, and the images lag the branch by days. The running image SHA
is the only authority on what production does.

Measured with the project's deploy-status command (`make deploy-status` on the reference board,
2026-10-30): each running service reported its own image SHA and start time, and the start times spread
from 2026-10-17 to 2026-10-29 against a branch tip of 2026-10-30. Record per service: container, running
image, git SHA, start time.

- An image tagged with a registry digest carries no git SHA in its tag: read the SHA from the deploy
  record (on the reference board, the export directory name `.deploy/exports/<sha>`, the same value the
  compose file and Makefile use as `IMAGE_TAG`).
- An image deployed from another repository, or a third-party image, has no SHA in this repository: the
  service is unmeasurable here, not live and not stale.

## 1. The rule (rev 2, plus the exclusion in §1b)

A row belongs in **Waiting Production** when all four facts hold and all four are shown:

1. **Built** — at least one PR binding the ticket is merged to `master`.
2. **Scoped** — the changed files of that PR map to at least one container with a known running SHA
   (§2). A PR that touches only docs, tests, `Makefile`, `docker-compose.yml` or `alembic/` maps to
   no running image, and the row is **not proposable** — it is not "pending deploy", it is
   unmeasurable.
3. **Not live** — for every container the PR is scoped to, `git merge-base --is-ancestor <merge>
   <running-sha>` returns 1.
4. **Nothing of its own open** — no open PR binds the ticket.

Two refinements matter and both were tested:

- **Scope, not membership.** A shared base Dockerfile that copies most of the source tree into every
  image makes *membership* say an API change affects every service built from it. It does — as image
  content — but that is a host-wide staleness fact (several services ran code from 2026-10-17 to
  2026-10-26), not a per-row status. The audit
  scopes a change to the service whose code path it belongs to (§2) and reports staleness once, as a
  finding.
- **Window rows are ordinary rows under this rule.** A `<prefix> window: <what>` row is a production
  *step*; if its code is not in the running image, Waiting Production is exactly its status.

## 1b. The status definition — ADOPTED by fri30-coord 2026-10-30

> A row is Waiting Production when EVERY build vehicle it needs (PR/commit) is merged, and only its
> own production step remains (deploy, window, switch-on). It is NOT Waiting Production if ANY
> prerequisite window or row has not run yet. Purge, drop and reader-switch rows after an unrun writer
> or parity step fail the test.

This replaces rev 3's "window rows are excluded" rule, which was wrong: `PROJ-274` and `PROJ-338` are
window rows and are ruled Waiting Production.

**How to apply it.**

| term | operational reading |
|---|---|
| build vehicle | a PR named in the row text (`PR #n`, `<PM_REPO_NAME>#n`, `pull/n`) **or** one whose body binds the ticket. State from the merged/open sets; a per-PR `gh pr view --json state` only when neither set contains it |
| prerequisite | a `Blocks` **inward** link (this row is blocked by X), plus the tickets the row's `Preconditions` text names. Outward `Blocks` links are consumers, not prerequisites |
| ran | status in config `done_statuses` (the done category). Every other status, Waiting Production included, is NOT RUN |
| verdict | WP: every vehicle merged, and no unrun prerequisite **whose output its own step consumes**. NOT-WP: any vehicle unmerged, or such a prerequisite unrun |

**Adopted refinement of the "ANY prerequisite" clause.** Read literally, clause 2 fails its own
examples: `PROJ-274` has unrun inward `Blocks` links to 482, 498, 547 and 548, and `PROJ-338` to 486
and 498, yet both are ruled WP. The clause that separates the ruling's four examples is whether the
row's own step **consumes the output** of the unrun prerequisite: a service deploy needs code and an
image and does not consume a writer swap's output at execution time, while a purge, a drop or a
reader switch consumes the writer's output. fri30-coord adopted this wording on 2026-10-30 and upheld
the two cut rows.

**Worked examples carried in the ruling:**

- `ISSUE-342` — NOT WP. Vehicle #1149 merged, but the freeze consumes the output of the `ISSUE-386`
  allowlist rotation, which has not run.
- `ISSUE-520` — NOT WP, unmeasured. Stale in-progress window; the owner question is posted as a Jira
  comment on the row, so its own step is not established as the remaining one.
- `PROJ-274`, `PROJ-338` — WP (vehicles merged; the deploy is the remaining step).
- `ISSUE-354`, `ISSUE-361` — NOT WP (the bridge and the purge/drop consume an unrun writer and parity
  step's output).

**Binding correction (rev 5).** A `#n` mention in row text is a *reference*, not a vehicle: `ISSUE-346`
names #938, #943, #946, #1099 and #1103, and only #938 is its governing vehicle (#1099 removes a stale
options read path). Where a row names no governing PR, the binding falls back to the PR whose body
carries `Jira binding:` for that ticket. Applied to all 22 rows, 16 rows change under a
"any mention counts" reading and none changes under "governing vehicle only" — so the governing reading
is the one used in the audit.

**One correction to the wording, with evidence.** Taken literally, "NOT Waiting Production if ANY
prerequisite has not run" contradicts the ruling itself: `PROJ-274` blocks-by `ISSUE-482`, `ISSUE-498`,
`ISSUE-547`, `ISSUE-548` (all unrun) and names `ISSUE-548` and `ISSUE-482` in its own Preconditions,
yet it is ruled WP. The distinction that actually separates the four ruled examples is whether the row's
own step **consumes the output** of the unrun prerequisite: a deploy needs code and an image (vehicles),
a purge/drop/reader switch needs the writer's output. Written that way, all 22 verdicts hold and
`ISSUE-354`/`ISSUE-361` fail by deduction rather than by ruling.

## 2. The mapping rule (path → service)

The mapping lives in config `container_paths` (ordered prefixes → containers, first match wins; shape in
`setup-lane.md`), read by `scripts/lane/wp-audit.py`. Derive it from the compose file's `command` modes
and each Dockerfile's `COPY` set, and encode four classes:

| changed path class | scoped to |
|---|---|
| a service's own code path | that service (more specific prefixes first) |
| shared library code copied into every image | every service built from that base |
| a service with no git SHA in this repository, migrations, dependency pins | unmeasurable |
| docs, tests, examples, CI, Makefile, compose file, `*.md` | no image (check `.dockerignore`) |

Files come from the repository, not the API: `git show --name-only --format= <merge-sha>`. One local
command per PR, identical to `gh pr view <n> --json files` for a merge commit, with no rate limit.

## 3. The evidence

| fact | command |
|---|---|
| open rows | `POST /rest/api/3/search/jql`, `jql = project = $PM_JIRA_PROJECT AND statusCategory != Done` (318 rows, 4 pages) |
| built | `gh pr list --state merged --limit 400 --json number,body,title,mergeCommit,mergedAt` (merge SHA pasted, never typed) |
| still open | `gh pr list --state open` (59 PRs) |
| scope | `git show --name-only --format= <merge-sha>` |
| live | the deploy-status command, then `git merge-base --is-ancestor <merge-sha> <running-sha>` per scoped container |

**Stamp discipline.** A stamp is only usable if it names the clock it came from. Rev 1 and rev 2 of
this audit carried stamps one hour ahead of host UTC (16:04Z reported while the host read 15:04Z).
Every stamp is now produced by `date -u` **cross-checked against `timedatectl`'s Universal time in the
same command batch**, and both are printed in the artefact. A stamp that disagrees with the host
clock invalidates deadline claims built on it, so the check costs one line and is not optional.

Fetch the refs explicitly; all five running SHAs were already present in this clone
(`git cat-file -e <sha>^{commit}`), so no fetch of a tag was needed:

```
git fetch origin +refs/heads/master:refs/remotes/origin/master +refs/heads/stable:refs/remotes/origin/stable
git rev-parse --short origin/master origin/stable
```

## 4. Controls (mandatory, from the same artefact)

- **Positive** — a non-window row known to be built and not live must appear: `ISSUE-425` (PR #906,
  merge `5482a00b33`); scoped to two services, `merge-base --is-ancestor 5482a00b33 <running-sha>` →
  rc=1 against both running SHAs.
- **Negative** — a row already live must NOT appear: `ISSUE-165` (PR #865, merge `553cad6f5f`) is LIVE
  on the service that contains it (`… <running-sha>` → rc=0), and is absent from the proposal.
- **Window control (rev 3's exclusion withdrawn by §1b)** — `PROJ-338` is a window row, NOT-LIVE by
  ancestry, and ruled WP. It must **appear**: a run that drops it still applies rev 3's window exclusion.
- **Instrument control** — `ISSUE-419`/`ISSUE-423`, which rev 1 called *stale-deployed* because their
  merges were on `stable`, are NOT-LIVE under the running SHAs. Rev 1's answer and rev 2's answer
  disagree on exactly the rows the premise correction predicted, which is why the correction is
  verified rather than accepted.

## 5. Traps, each observed

- **A status is a claim, not a measurement.** 5 of the 8 rows carrying Waiting Production have no PR
  binding at all, and 2 more are NOT-LIVE only by luck of an old image.
- **Services run stale code.** On 2026-10-30 four services ran images from 2026-10-17 to 2026-10-26
  against a `master` tip of 2026-10-30. Report this as one host-level number per service; do not let
  it turn every row into Waiting Production.
- **19 of 51 rows are unmeasurable** because their PRs touch docs, tests, make targets or compose
  files only. Their absence from the proposal is not absence of work; it is absence of evidence, and
  it needs its own fix (a deploy manifest per PR, or a `no-image` marker).
- **The 400-PR window is a window**; state it with the read time. Every row is invalidated by the next
  deploy of the container it is scoped to, not only by a promotion to stable.

## 6. What happens to the proposal

The proposal is posted to its system of record (a journal entry on the audit's Substrate issue, sent to
the orderers with its seq), not left as a file.

1. The orderer re-reads the two control rows and one proposed row; a wrong `origin/master`/running SHA
   flips the whole table in one direction.
2. On the owning lead's word (the manager's for rows with no workstream parent), the board helper
   transitions by id read live from `GET /rest/api/3/issue/<K>/transitions`.
3. One comment per row through `post-guard.py`, naming the PR, the merge SHA, the container and the
   running SHA compared.
4. Re-run after each deploy: the population is a function of running image SHAs, which change without
   any board event at all.
