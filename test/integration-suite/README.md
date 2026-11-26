# Cross-repository installed-artifact integration suite (audit §P2-01)

One conformance suite that exercises the **installed** Core + Specialists + xtmux
release-candidate artifacts — not the source trees — across the audit's 20-step
scenario. Big-brother of `scripts/install-update-ux-smoke.mjs`.

## Run it

```bash
# Local: packs the three RCs from sibling dev checkouts (~/dev/{specialists,xtmux})
node test/integration-suite/run-all.mjs

# Against explicit tarballs (CI): set all three, packing is skipped
P201_CORE_TARBALL=/tmp/xtrm-tools.tgz \
P201_SPECIALISTS_TARBALL=/tmp/specialists.tgz \
P201_XTMUX_TARBALL=/tmp/xtmux.tgz \
  node test/integration-suite/run-all.mjs
```

Each runner is a dependency-free `node` script using `node:assert` — deliberately
**not** part of the `cli` vitest project, so a heavy install/tmux suite never
slows the unit path. Every child runs under an isolated `HOME` **and**
`XDG_STATE_HOME`; the operator's real `~` and 300 MB `observability.db` are never
touched. No fixture secret is allowed to appear in any captured output.

## The split (defended)

The audit itself flags steps 2-11 as coordinator-dependent. The 20 steps divide
by what is buildable against today's shipped surface:

| Suite | Steps | Status | Why |
|---|---|---|---|
| **A** `suite-a-installed-artifact.mjs` | 1, 6, 19, 20 | **RUNNABLE** (hermetic) | Install all three RCs; version-conformance vs `docs/runtime-compatibility.json`; `xt update --apply` on stale Pi state; user-owned assets preserved. No tmux. |
| **B** `suite-b-coordination.mjs` | 12-18 | **RUNNABLE** (capability-gated) | Full reply-obligation → ack → correlated-reply → consume-once → restart-no-dup lifecycle + read-only bridge / mutation-refused, against a **private** `tmux -L` server and isolated state. Skips cleanly where tmux/xtmux are absent. |
| **C** `suite-c-coordinator-lineage.mjs` | 2-5, 11 (+ 7-10 opt-in) | **RUNNABLE** (capability-gated) | Launches a **real subordinate chain coordinator** through the packed Core artifact (`xt claude … --subordinate`) against a private `tmux -L` server and a throwaway git repo, then asserts the lineage invariants: distinct worktree + branch, `@agent_parent_session`/`@agent_role`/`@agent_issue`/`@agent_worktree`/`@agent_branch`, the single-line `session:pane` stdout contract, and main left untouched. With `XTRM_SUITE_C_LIVE=1` it additionally dispatches a **real specialist** from the coordinator's session and asserts branch ancestry, runtime-origin lineage and the merge back. Skips cleanly where tmux/git are absent. |

Result: **20 of 20 steps are now addressed** — 16 run by default, and steps 7-10
run for real behind an opt-in gate rather than being reported as blocked.

### The Suite C live lane (`XTRM_SUITE_C_LIVE=1`)

```bash
XTRM_SUITE_C_LIVE=1 node test/integration-suite/suite-c-coordinator-lineage.mjs /path/to/xtrm-tools.tgz
# 9 PASS, 0 SKIP, 0 BLOCKED
```

Off by default: it dispatches a real, API-billed specialist, so it is a
pre-release lane, never a per-PR gate. It needs `sp`, `bd` and `xtmux` on PATH
plus the operator's model credentials (`~/.pi/agent/{auth,models,settings}.json`
and `~/.config/specialists/user.json`), which are **copied** into the sandbox —
the originals are read-only to the suite. Any missing prerequisite `[SKIP]`s the
four steps with the concrete reason: an absent API key is not a conformance bug.
Isolation is unchanged from the default lane — private tmux server, sandbox
`HOME`/`XDG_STATE_HOME`, throwaway repo.

What the lane actually does: the coordinator commits on its own branch (so step
8's ancestry cannot hold trivially), a real bead is created in the fixture's own
beads database, and `sp run <specialist> --bead <id> --worktree` is dispatched
from a shell window **inside the coordinator's tmux session** — so
`XTMUX_AGENT_BRANCH` has to arrive by inheritance, which is the Core half of
P1-03. Override the specialist with `XTRM_SUITE_C_LIVE_SPECIALIST` (default
`explorer`: READ_ONLY and cheap — the subject is branch topology, not agent
quality).

Suite C graduated in **xtrm-6hey0** (audit P0-05 `--subordinate` + P1-02 lineage
metadata), which is what unblocked it. It became **gating** in `run-all.mjs` at
the same time: it exits 0 when its capability gate closes, so a runner without
tmux or git stays green, but a genuine lineage regression now fails the run.

### Faithful, not green-washed

- **Step 6** asserts the installed Specialists artifact *exposes* the
  `xtrm.runtime-origin.v1` contract (shape-level). Live capture needs a
  dispatched specialist under a coordinator → Suite C step 9, which is
  live-agent-only.
- **Suite C shims `sp` and the runtime binary, and says so in its header.** Core
  is the real packed artifact under test; Suite C's subject is *Core's* lineage
  contract, not Specialists' task rendering (Suite A covers that at contract
  level) nor a real LLM turn. A real `sp render-task` needs a beads database and
  a real agent needs credentials — shimming both is what makes steps 2-5 and 11
  assertable at all. The shims stay in place even in the live lane, which
  dispatches the real `sp` by absolute path: steps 2-5 are byte-identical across
  both lanes.
- **Suite C steps 7-10 are `[SKIP]` by default, never faked into a `[PASS]`.**
  They dispatch an actual specialist chain and inspect the branches it creates —
  Specialists-side behavior requiring live agents. Core only *publishes* the base
  branch via `@agent_branch` (audit P1-03); it does not create the specialist
  branches, so fabricating them here would assert nothing. Opting into the live
  lane runs them against the real thing instead (`xtrm-6hey0.5`, unblocked by
  Specialists PR #200 which made `sp` consume the published `@agent_branch`).
- **Step 20** asserts hooks + extensions are preserved (both code-backed
  foreign-preserved surfaces). A bare, unmarked user *skill* dropped into a
  managed skills projection is **repaired away** by `update --apply`; that is
  surfaced as an `[OBSERVE]` finding (managed tree is repaired from package
  payload) and tracked as a follow-up, not asserted as a pass.

## Packaging choice

Co-located in `test/integration-suite/` (option **a**). "Cross-repository" is
satisfied by *consuming packed RC tarballs* of all three, not by a separate repo.
Reuses Core CI (the `fresh-machine-smoke` workflow already packs Specialists and
provides Bun), ships in one PR, and adds no independent release cadence.

Parent tracker: `xtrm-kvsrd.2` · epic `xtrm-kvsrd` · blocker `xtrm-3xgs5`.
