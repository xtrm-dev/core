# Code-readiness rubric v1 (pinned; the judge follows the steps in order and stops at the first that decides)

Question for every row: does the code this ticket needs already exist on origin/master, and if not, what must be built?
The row's `evidence` holds every fact, computed in code. Read the facts; never recompute or guess them.
Classes: BUILT, PARTIAL, OPEN_PR, SUPERSEDED, OPERATIONAL, OTHER_REPO, UMBRELLA, NOT_BUILT, NEEDS_HUMAN.

R1 ORACLE. If oracle is OPEN_PR, SUPERSEDED, BUILT or PARTIAL, return that class with rule R1, unless a line of the
   evidence directly contradicts it; then return NEEDS_HUMAN with rule R1x and quote the contradicting line.
   If oracle is judge, R1 does not apply: go to R2.
R2 UMBRELLA. Applies only when type is Story or the summary names a theme ("New engine: ...", "Serving speed and
   scale", "Data safety: ..."), the description lists other tickets or work items as its content, and it states no
   single change of its own. Return UMBRELLA. Otherwise R2 does not apply.
R3 OTHER_REPO. Applies only when other_repo_mentions is not none AND the description says the change is made in
   that repository AND no path line shows a market-data file the ticket must change. Return OTHER_REPO and name the
   repository in missing. If market-data also needs a change, R3 does not apply.
R4 OPERATIONAL. Applies only when the ticket's deliverable is an action on code that already exists: run, verify,
   check, measure, compare, upload, restart, review, decide, report, promote, tag a release, or drop/purge existing
   objects with an existing tool. Every `make <target>` line must show exists_on_master=True; if any shows False,
   R4 does not apply and the missing target is code to build (go to R6). A PR that must still be written (for
   example an allowlist rotation PR) is code, not an action. A deploy, migrate, swap or flag-flip ticket is OPERATIONAL
   only when a pr line shows the change it deploys with on_master=True; when the change it deploys is not shown merged
   (an open substrate ref with no merged pr line, or a branch line with NO PR), R4 does not apply: go to R5/R6.
   Return OPERATIONAL with missing=none.
R5 COVERED BY MERGED WORK. Applies only when a pr line shows on_master=True, or a path line lists a commit, whose
   title or subject states the deliverable of this ticket (the summary, or the contract success).
   - The covering PR/commit carries this ticket's own MMD ref or key, and covers every item the contract success
     names: return BUILT.
   - It covers only part of the success: return PARTIAL and list the uncovered items in missing.
   - The covering commit carries a DIFFERENT ref than this ticket's own: return SUPERSEDED and quote that commit.
   A merged PR about a different subject does not apply.
R6 NOT_BUILT. Applies when the ticket states code, a migration, a test, a config change or a PR to write, and no
   pr or path line shows it merged. Quote the line that shows the absence (for example "prs: none ..." or a path
   with exists_on_master=False). Set missing to what must be built, first_code_site to the first file to change
   (from a path line, else unknown), size S (one file, config or test), M (2-5 files), L (new module, service or
   migration chain), and blocker to a Substrate ref the evidence names as blocking, else none.
R7 NEEDS_HUMAN. When no earlier step decides, or a substrate line says NOT FOUND and nothing else decides,
   return NEEDS_HUMAN and say in note which fact is missing.

Output rules: rule = the step id that decided. evidence_quote = one line copied verbatim from evidence (at least
20 characters) that the decision rests on. note = at most 300 characters naming every step you evaluated and why
each earlier step did not apply. Never invent a PR number, SHA, path or ref that is not in evidence.
