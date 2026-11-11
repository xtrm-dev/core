---
title: XTRM Build Order
scope: xtrm-build-order
category: prd
version: 4
updated: 2026-11-11
description: "Programme plan (PRD) for the XTRM agent tooling system: the ordered build from safe installs to the new xtrm-app"
source_of_truth_for:
  - "docs/plans/xtrm-build-order/index.html"
domain: [xtrm, programme, roadmap]
status: active
---

# XTRM Build Order — programme plan (PRD)

## What this is

The programme plan and roadmap PRD for the XTRM agent tooling system: the `xt` CLI and its installer in `core`, the specialists runtime, Substrate in `xtrm`, `xtmux`, the Pi and Claude Code runtimes, the GitHub Apps identities, the Jira binding, and the `xtrm-app` frontend. It is the ordered build from safe installs to the new app: 46 numbered steps plus 13 lettered additions in six phases, where each step names the Substrate Issues and the Jira XT tickets that carry it.

## Whose plan it is

The operator's XTRM programme. The programme record is the Jira XT project on `mercuryintel.atlassian.net`; its epics include XT-110, XT-114, XT-126, XT-178, XT-184 and XT-190. The plan text is the operator's ruling; this repository holds the copy.

## Ruling and version history

The page states the ruling of 2026-10-29 and version 4.

- **Version 1** — the build order itself: 46 numbered steps and 13 lettered additions in six phases, from safe installs to the new `xtrm-app`.
- **Version 2** — what the page reports as "what changed since version 1": the reading of XT-104, XT-110, XT-114, XT-178 and XT-184 was confirmed, a linking spine was added to phases 1–4, and 27 open XT tickets were folded into the steps they belong to.
- **Version 3** — a duty track (steps 8, 16, 22) and a stage model for statuses (step 30), after measuring the gap between what Substrate can do and what the instructions tell agents.
- **Version 4** — a "Ruling on your note" box on every step that has an operator note, new work added as lettered steps (4b, 15b and so on) so no step number moved, and the page published on here.now with notes that save there.

## Authority order

1. **Substrate Issues** are the executable contracts. They define what is built, how success is proven, and when the work closes.
2. **Jira XT tickets** are the programme record: the operator's view, the epic structure, and the status the programme is reported by.
3. **This PRD** is the ordered plan that binds them: the sequence, the dependencies, and the reason for the order.
4. **The here.now page** is the rendered mirror of `index.html` in this directory. It carries no authority of its own.

## Rendered mirror

<https://aware-soul-37hw.here.now/> — published from `docs/plans/xtrm-build-order/index.html`.

## How to update

1. Edit `docs/plans/xtrm-build-order/index.html`. This is the only editable copy of the page source.
2. Run `npm run plan:md` to regenerate the Markdown body below the marker. The preamble above the marker is hand-written and is never generated.
3. Run `npm run plan:md:check`. It fails when the body is stale, or when a step from `index.html` is missing from this file.
4. Commit both files in one PR; then publish `index.html` to here.now.

## Operator notes

The per-step "Your notes" boxes are live Site Data on the here.now page, not part of `index.html`. They are omitted from this PRD by design; read them on the page.

## Jira programme epic

Jira programme epic that mirrors this PRD: [XT-217](https://mercuryintel.atlassian.net/browse/XT-217), `[EPIC] XTRM Build Order (programme PRD)` on mercuryintel.atlassian.net (created 2026-11-11, CORE-2593). Its description carries this PRD’s brief, path and mirror URL. The 43 plan-cited tickets are linked to it (Relates); 21 of them still need the epic set as their parent.

<!-- BEGIN GENERATED BODY: scripts/plan-to-md.mjs -->

*XTRM programme · ruling of 2026-10-29 · version 4*

## The build order, from safe installs to the new xtrm-app

There are 46 numbered steps and 17 lettered additions in six phases. Each phase gives the next one something it cannot work without. Two rules run through the whole plan. Every Jira item, Substrate issue, PR and commit links to the others. Every Substrate duty is done by the host or enforced by a gate, so no agent can skip it.

**What changed since version 1.** You confirmed the reading of XT-104, XT-110, XT-114, XT-178 and XT-184. You asked for a strong GitHub and Jira binding. I measured how linking works today; it barely does (next section). I added a linking spine to phases 1–4 and folded 27 open XT tickets into the steps they belong to.

**Version 3.** You pointed at the gap between what Substrate can do and what the instructions tell agents. I measured it (section below). The plan now has a duty track (steps 8, 16, 22) and a stage model for statuses (step 30).

**Version 4.** I read your notes from 10-29 and checked each one against the server. Steps with a note now carry a "Ruling on your note" box. New work is added as lettered steps (4b, 15b and so on), so no step number moved and every note stays on its step. The page now lives on here.now, and your notes save there.

**Already written to Jira** as xtrm-bot: XT-178 is renamed and has an appended amendment with the linking design (the original text is unchanged). XT-110, XT-114 and XT-184 have a ruling comment each. Every folded-in ticket has a Relates link to its parent.

**Jira sync · 11-11** (CORE-2593): the programme epic is [XT-217](https://mercuryintel.atlassian.net/browse/XT-217), whose description carries this plan’s brief, the PRD path (`docs/plans/xtrm-build-order/PRD.md` in xtrm-dev/core) and this page. Its 43 plan-cited tickets are linked to it (Relates); 21 of them still need the epic set as their parent, which the server’s acli cannot do. XT-190, XT-127 and XT-126 moved to In corso. XT-125 and XT-191 stay open with a comment: the installer still falls back to `oh-pi` and the Pi extensions still compile against `^1.0.0`, so steps 10 and 11 are partly done, not done. Steps 13b (SPECIALISTS-4391 still open) and 15e (CORE-2528 merged in part) are partly done.

## How linking works today

I measured this on the server database and in Jira on 2026-10-28.

| Measure | Value | What it means |
| --- | --- | --- |
| Closures naming a PR only in the free-text reason | 2,468 | Of 16,693 closures. The PR is prose, so nothing can link to it or check it. |
| PR records in Substrate (artifact kind `pr`) | 0 | The data model has the kind. No `sb` command and no host code writes it. |
| Work receipts with a commit SHA | 9 / 746 | Commits are almost never tied to the work they belong to. |
| Jira bindings (`external_bindings`) | 0 | Substrate knows no Jira key. Every link today is typed by hand. |
| PRs in the XT-114 dev panel | 0 | GitHub for Jira *is* installed on both orgs and builds already show up. PRs don't, because branch names and PR titles carry no Jira key. |
| Recent core commits naming an XT key | 1 / 400 | The convention that would light up the dev panel is not in use. |

Example: CORE-2536 was merged as `xtrm-dev/core#845`, but `sb provenance trace CORE-2536` shows `prs: []` and `commits: []`. The only trace of the PR is a sentence in the close reason.

## The linking spine

One piece of work has up to three identities. Each side stores the other two as a structured link, never as prose. Exactly one writer exists for each link.

<!-- figure: Jira item, Substrate issue and GitHub PR linked both ways; the host records the PR on open, the reconciler records state changes, gates refuse unlinked work -->
<figure class="fig" style="margin:0">
    <svg viewBox="0 0 1000 340" role="img" aria-label="Jira item, Substrate issue and GitHub PR linked both ways; the host records the PR on open, the reconciler records state changes, gates refuse unlinked work">
      <defs>
        <marker id="s1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#1c2321"/></marker>
      </defs>
      <g font-family="Public Sans, sans-serif">
        <rect x="20" y="30" width="270" height="150" rx="12" fill="#eaf0fb" stroke="#2a62c9"/>
        <text x="38" y="58" font-size="16" font-weight="700" fill="#1c2321">Jira · XT-178</text>
        <g font-size="12.5" fill="#1c2321">
          <text x="38" y="84">Dev panel: branches, commits, PRs</text>
          <text x="38" y="104">Remote link → Substrate ref</text>
          <text x="38" y="124">Label substrate:CORE-NNNN</text>
          <text x="38" y="144">Comments: closure, receipt</text>
        </g>
        <text x="38" y="168" font-size="11" fill="#2a62c9" font-family="JetBrains Mono, monospace">via GitHub for Jira (installed)</text>

        <rect x="365" y="30" width="270" height="150" rx="12" fill="#f8ede3" stroke="#a8581c"/>
        <text x="383" y="58" font-size="16" font-weight="700" fill="#1c2321">Substrate · CORE-NNNN</text>
        <g font-size="12.5" fill="#1c2321">
          <text x="383" y="84">Jira binding: key + URL</text>
          <text x="383" y="104">PR artifact: org/repo#n, URL</text>
          <text x="383" y="124">head SHA, state, merge SHA</text>
          <text x="383" y="144">Commits via receipt trailers</text>
        </g>
        <text x="383" y="168" font-size="11" fill="#a8581c" font-family="JetBrains Mono, monospace">sb issue show prints links</text>

        <rect x="710" y="30" width="270" height="150" rx="12" fill="#eef4ee" stroke="#2f7a4f"/>
        <text x="728" y="58" font-size="16" font-weight="700" fill="#1c2321">GitHub · PR #n</text>
        <g font-size="12.5" fill="#1c2321">
          <text x="728" y="84">Title: XT-178 CORE-NNNN: …</text>
          <text x="728" y="104">Branch xt/XT-178-CORE-NNNN-…</text>
          <text x="728" y="124">Body link block (host-written)</text>
          <text x="728" y="144">Trailers: XTRM-Issue, Jira</text>
        </g>
        <text x="728" y="168" font-size="11" fill="#2f7a4f" font-family="JetBrains Mono, monospace">pr-review-gate checks it</text>

        <g stroke="#1c2321" stroke-width="1.5" fill="none">
          <path d="M292 95 H362" marker-end="url(#s1)"/><path d="M362 115 H292" marker-end="url(#s1)"/>
          <path d="M637 95 H707" marker-end="url(#s1)"/><path d="M707 115 H637" marker-end="url(#s1)"/>
        </g>

        <rect x="20" y="220" width="300" height="100" rx="10" fill="#ffffff" stroke="#5b6661"/>
        <text x="36" y="246" font-size="13.5" font-weight="600" fill="#1c2321">1 · Record on open</text>
        <text x="36" y="268" font-size="12" fill="#5b6661">Host pushes the branch, opens the PR,</text>
        <text x="36" y="286" font-size="12" fill="#5b6661">attaches the PR to the receipt in one step.</text>
        <text x="36" y="306" font-size="11" fill="#5b6661" font-family="JetBrains Mono, monospace">step 14 · sb provenance attach</text>

        <rect x="350" y="220" width="300" height="100" rx="10" fill="#ffffff" stroke="#5b6661"/>
        <text x="366" y="246" font-size="13.5" font-weight="600" fill="#1c2321">2 · One reconciler</text>
        <text x="366" y="268" font-size="12" fill="#5b6661">Polls GitHub; the only writer of review,</text>
        <text x="366" y="286" font-size="12" fill="#5b6661">merged and closed. Feeds XT-184 and Jira.</text>
        <text x="366" y="306" font-size="11" fill="#5b6661" font-family="JetBrains Mono, monospace">step 26 · agent host</text>

        <rect x="680" y="220" width="300" height="100" rx="10" fill="#ffffff" stroke="#9b3b4a"/>
        <text x="696" y="246" font-size="13.5" font-weight="600" fill="#1c2321">3 · Gates fail closed</text>
        <text x="696" y="268" font-size="12" fill="#5b6661">No ref in the PR: gate fails. Code work</text>
        <text x="696" y="286" font-size="12" fill="#5b6661">with no PR or commit: close is refused.</text>
        <text x="696" y="306" font-size="11" fill="#9b3b4a" font-family="JetBrains Mono, monospace">step 15 · sb links check, step 33</text>
      </g>
    </svg>
    <figcaption>Each arrow is a stored link you can open. Where the work is bound to Jira, the Jira key goes in front of the Substrate ref in branch and title, because GitHub for Jira only matches Jira keys.</figcaption>
  </figure>

### Names

```
xt/XT-178-CORE-2601-pr-binding
XT-178 CORE-2601: record PRs on open
```

Unbound work drops the Jira key: `xt/CORE-2601-…`. The xt launcher and the specialists workspace lease create the names, so agents never type them.

### Opening anything from anything

From Jira: the dev panel opens the PR, and a remote link opens the Substrate ref. From Substrate: `sb issue show` prints PR and Jira as clickable terminal links. From GitHub: the body block links both. Later, xtrm-app shows all three on one page (step 42).

## What Substrate can do, what agents are told, what actually happens

Only issues created in Substrate are counted: 2,478 of 19,180. The other 16,702 are Beads imports. Of the native issues, 1,357 are done.

| Substrate feature | Done issues that used it | Mentions in core instructions | Mentions in specialists |
| --- | --- | --- | --- |
| Attestation before work | 94% | 30 | 11 |
| Journal entry of any kind | 92% | 11 (append) | 0 |
| Result entry before close | 73% | 11 (close) | 0 |
| Claim before work | 71% | many | 60 |
| Dispatch binding | 38% | 1 | 0 |
| Work receipt | 33% | 22 | 0 |
| Checkpoint | 7% | 4 | 0 |
| Finalized receipt | 1% | 0 | 0 |
| Commit record (trailers) | 1% | 0 | 0 |
| PR record | 0% | 0 | 0 |
| `sb issue validate` | – | 0 | 0 |

### The pattern

The less a feature is described, the less it is used. Checkpoints, receipts, commits and PRs, the features that give continuity and links, are almost absent from both the instructions and the data.

### The specialists side

Only 9 of 25 specialist prompts and 5 of 25 mandatory rules mention Substrate at all. Retired Beads commands are still named 41 times in core instructions and 33 times in specialists.

### The ruling

Better text alone will not fix this. Each duty moves to the host or behind a gate, so it happens even when an agent ignores its prompt. Instructions then describe what the machine already does, and they are generated from `sb help`, so they cannot drift from the CLI.

| Duty | Owner after hardening | What makes it unavoidable |
| --- | --- | --- |
| Claim | Launcher and dispatcher | Edit gate blocks bound work without a live claim; close after a lapsed claim fails |
| Validate and attest | Planner | Claim refuses an Issue whose contract fails `sb issue validate` |
| Dispatch binding and receipt | Host at dispatch and at settle | Written by the host, never by the agent |
| Checkpoint | Stop and compact hooks | Every claimed session, not only bound ones (today 7%) |
| Commit record | Commit hook | Adds `XTRM-Issue` and `XTRM-Receipt` trailers automatically |
| PR record and state | Host on open, reconciler after | pr-review-gate fails a PR without the link block |
| Result entry | Agent | Close is refused without one |
| Close | Reconciler on merge, or agent | Close needs a result, a PR or commit record, and a live claim |
| Relations (discovered from, blocks) | Agent | `sb links check` reports orphans |

## Statuses: from five stored states to a work stage

**Today** Substrate stores five lifecycle states: `open`, `deferred`, `done`, `cancelled`, `archived`. On top of them the board derives three views: `ready`, `in_progress` (a live claim) and `blocked`. A close carries one of seven outcomes, such as completed, superseded or wont_fix. Nothing says "a PR is open" or "merged but not closed yet".

**Your idea, made mechanical.** Add a *work stage* that Substrate derives from evidence, never from a command. Nobody sets it, so nobody can skip it or forget it. Each change of stage writes an event, and that event moves the Jira status.

<!-- figure: Work stages: draft, ready, in progress, in review, merged, done; side stages blocked and stalled; each derived from evidence and mapped to a Jira status -->
<figure class="fig" style="margin:0">
    <svg viewBox="0 0 1000 260" role="img" aria-label="Work stages: draft, ready, in progress, in review, merged, done; side stages blocked and stalled; each derived from evidence and mapped to a Jira status">
      <defs><marker id="st" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#1c2321"/></marker></defs>
      <g font-family="Public Sans, sans-serif">
        <g font-size="13.5" font-weight="600" fill="#1c2321" text-anchor="middle">
          <rect x="10" y="60" width="130" height="62" rx="10" fill="#f0f2ee" stroke="#5b6661"/><text x="75" y="88">draft</text>
          <rect x="175" y="60" width="130" height="62" rx="10" fill="#e7eef6" stroke="#1f5a85"/><text x="240" y="88">ready</text>
          <rect x="340" y="60" width="130" height="62" rx="10" fill="#f6efdc" stroke="#8a6a12"/><text x="405" y="88">in progress</text>
          <rect x="505" y="60" width="130" height="62" rx="10" fill="#fbeef0" stroke="#9b3b4a" stroke-width="2"/><text x="570" y="88">in review</text>
          <rect x="670" y="60" width="130" height="62" rx="10" fill="#fbeef0" stroke="#9b3b4a" stroke-width="2"/><text x="735" y="88">merged</text>
          <rect x="835" y="60" width="150" height="62" rx="10" fill="#e6f2ea" stroke="#2f7a4f"/><text x="910" y="88">done</text>
        </g>
        <g font-size="10.5" fill="#5b6661" text-anchor="middle" font-family="JetBrains Mono, monospace">
          <text x="75" y="108">no attestation</text>
          <text x="240" y="108">attested, unblocked</text>
          <text x="405" y="108">live claim</text>
          <text x="570" y="108">open PR record</text>
          <text x="735" y="108">PR merged, open</text>
          <text x="910" y="108">closure recorded</text>
        </g>
        <g stroke="#1c2321" stroke-width="1.5" fill="none" marker-end="url(#st)">
          <path d="M140 91 H173"/><path d="M305 91 H338"/><path d="M470 91 H503"/><path d="M635 91 H668"/><path d="M800 91 H833"/>
        </g>
        <g font-size="11" fill="#2a62c9" text-anchor="middle">
          <text x="75" y="40">Da completare</text><text x="240" y="40">Pronto</text><text x="405" y="40">In corso</text>
          <text x="570" y="40">In Review</text><text x="735" y="40">waiting-production</text><text x="910" y="40">Completata</text>
        </g>
        <text x="10" y="22" font-size="11" fill="#2a62c9" font-family="JetBrains Mono, monospace">JIRA STATUS</text>
        <rect x="300" y="170" width="190" height="56" rx="10" fill="#ffffff" stroke="#5b6661" stroke-dasharray="4 3"/>
        <text x="395" y="194" font-size="13.5" font-weight="600" fill="#1c2321" text-anchor="middle">blocked</text>
        <text x="395" y="213" font-size="10.5" fill="#5b6661" text-anchor="middle" font-family="JetBrains Mono, monospace">open blocking edge → Blocked</text>
        <rect x="520" y="170" width="230" height="56" rx="10" fill="#ffffff" stroke="#5b6661" stroke-dasharray="4 3"/>
        <text x="635" y="194" font-size="13.5" font-weight="600" fill="#1c2321" text-anchor="middle">stalled</text>
        <text x="635" y="213" font-size="10.5" fill="#5b6661" text-anchor="middle" font-family="JetBrains Mono, monospace">claim expired, no handoff · flag</text>
        <path d="M405 124 V168" stroke="#5b6661" stroke-width="1.2" stroke-dasharray="4 3" fill="none"/>
        <path d="M430 124 C 470 150, 560 150, 600 168" stroke="#5b6661" stroke-width="1.2" stroke-dasharray="4 3" fill="none"/>
      </g>
    </svg>
    <figcaption>The two new stages, in review and merged, are the intermediate states you asked for. Blocked and stalled sit beside the main line. 287 claims have expired without a release so far; stalled makes them visible instead of silent.</figcaption>
  </figure>

### Why derived, not a new stored state

A stored state needs someone to set it, and today's numbers show what happens to duties that depend on someone. A derived stage follows the PR records and claims, which the host writes. The five stored states stay as they are, so nothing in the existing database changes.

### Merged is the step before done

After a merge, the reconciler closes the Issue by itself when nothing else is pending. When the contract names a deploy or a production window, the Issue waits in merged (Jira waiting-production) until that evidence arrives.

## The pipeline at a glance

<!-- figure: Six phases from left to right; the linking spine runs under phases 1 to 4 and names the steps that build it -->
<figure class="fig" style="margin:0">
    <svg viewBox="0 0 1000 392" role="img" aria-label="Six phases from left to right; the linking spine runs under phases 1 to 4 and names the steps that build it">
      <defs>
        <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#5b6661"/></marker>
      </defs>
      <g font-family="Public Sans, sans-serif">
        <text x="580" y="18" font-size="11" fill="#5b6661" text-anchor="middle">session registry and PR records give the graph its edges</text>
        <path d="M415 56 C 415 30, 745 30, 745 54" stroke="#8a6a12" stroke-width="1.4" fill="none" stroke-dasharray="5 4" marker-end="url(#ar)"/>
        <rect x="10" y="56" width="150" height="130" rx="10" fill="#e6f2ea" stroke="#2f7a4f"/>
        <text x="22" y="80" font-size="12" fill="#2f7a4f" font-family="JetBrains Mono, monospace">PHASE 1 · 1–8</text>
        <text x="22" y="102" font-size="16" font-weight="700" fill="#1c2321">Safe ground</text>
        <text x="22" y="126" font-size="12" fill="#5b6661">updates never delete</text>
        <text x="22" y="144" font-size="12" fill="#5b6661">two machines in sync</text>
        <rect x="175" y="56" width="150" height="130" rx="10" fill="#e7eef6" stroke="#1f5a85"/>
        <text x="187" y="80" font-size="12" fill="#1f5a85" font-family="JetBrains Mono, monospace">PHASE 2 · 9–18</text>
        <text x="187" y="102" font-size="16" font-weight="700" fill="#1c2321">One command</text>
        <text x="187" y="126" font-size="12" fill="#5b6661">XT-114 install, update</text>
        <text x="187" y="144" font-size="12" fill="#5b6661">ends in a release</text>
        <rect x="340" y="56" width="150" height="130" rx="10" fill="#f6efdc" stroke="#8a6a12"/>
        <text x="352" y="80" font-size="12" fill="#8a6a12" font-family="JetBrains Mono, monospace">PHASE 3 · 19–28</text>
        <text x="352" y="102" font-size="16" font-weight="700" fill="#1c2321">Ownership</text>
        <text x="352" y="126" font-size="12" fill="#5b6661">XT-184 claims, limits</text>
        <text x="352" y="144" font-size="12" fill="#5b6661">PR-merged lifecycle</text>
        <rect x="505" y="56" width="150" height="130" rx="10" fill="#f5e9df" stroke="#a8581c"/>
        <text x="517" y="80" font-size="12" fill="#a8581c" font-family="JetBrains Mono, monospace">PHASE 4 · 29–38</text>
        <text x="517" y="102" font-size="16" font-weight="700" fill="#1c2321">Jira binding</text>
        <text x="517" y="126" font-size="12" fill="#5b6661">XT-178 bind, status</text>
        <text x="517" y="144" font-size="12" fill="#5b6661">backfill old links</text>
        <rect x="670" y="56" width="150" height="130" rx="10" fill="#eee8f6" stroke="#6b4aa3"/>
        <text x="682" y="80" font-size="12" fill="#6b4aa3" font-family="JetBrains Mono, monospace">PHASE 5 · 39–45</text>
        <text x="682" y="102" font-size="16" font-weight="700" fill="#1c2321">xtrm-app</text>
        <text x="682" y="126" font-size="12" fill="#5b6661">XT-110 + XT-104</text>
        <text x="682" y="144" font-size="12" fill="#5b6661">one merged view</text>
        <rect x="835" y="56" width="150" height="130" rx="10" fill="#f3e4e7" stroke="#9b3b4a"/>
        <text x="847" y="80" font-size="12" fill="#9b3b4a" font-family="JetBrains Mono, monospace">PHASE 6 · 46</text>
        <text x="847" y="102" font-size="16" font-weight="700" fill="#1c2321">Programme loop</text>
        <text x="847" y="126" font-size="12" fill="#5b6661">no hand copying</text>
        <text x="847" y="144" font-size="12" fill="#5b6661">report written once</text>
        <g stroke="#5b6661" stroke-width="1.6" fill="none" marker-end="url(#ar)"><path d="M160 121 H173"/><path d="M325 121 H338"/><path d="M490 121 H503"/><path d="M655 121 H668"/><path d="M820 121 H833"/></g>
        <path d="M250 186 C 250 250, 745 250, 745 188" stroke="#1f5a85" stroke-width="1.4" fill="none" stroke-dasharray="5 4" marker-end="url(#ar)"/>
        <text x="500" y="268" font-size="11" fill="#5b6661" text-anchor="middle">release carries the topology feed the navigator needs</text>
        <text x="10" y="306" font-size="12.5" font-weight="600" fill="#9b3b4a">Linking spine · runs under phases 1–4</text>
        <rect x="10" y="316" width="645" height="64" rx="8" fill="#fbeef0" stroke="#9b3b4a"/>
        <g font-size="10.5" fill="#1c2321" font-family="JetBrains Mono, monospace">
          <text x="22" y="343">6 names, 6b trailers</text><text x="22" y="364">8 duty map</text>
          <text x="187" y="343">14 PR records</text><text x="187" y="364">15–15e gates, 16 text</text>
          <text x="352" y="343">22 host, 22b sessions</text><text x="352" y="364">26 reconcile, 27 close</text>
          <text x="517" y="343">30 stages</text><text x="517" y="364">33–37 Jira bind</text>
        </g>
        <g stroke="#e3c3c9" stroke-width="1"><path d="M171 324 V372"/><path d="M336 324 V372"/><path d="M501 324 V372"/></g>
      </g>
    </svg>
    <figcaption>The linking spine starts in phase 1 and is finished in phase 4. Everything built after step 6 is linked from the day it is created.</figcaption>
  </figure>

- [done] merged or closed
- [ready] contract ready in Substrate
- [draft] filed, contract not final
- [new] no issue yet; I file it
- [you] needs your decision or hands
- (v2) (v3) (v4) added in version 2, 3 or 4

## Why this order

### Mechanics before instructions

A duty the host does or a gate enforces happens every time. Instructions are written last, from the CLI, to describe what exists.

### Safety before features

Every later phase installs code on two machines. While `xt update` can delete skills (CORE-2513), each install puts your configuration at risk.

### Names before code

The naming rule costs almost nothing and starts at step 6. Every branch and PR from then on reaches the Jira dev panel, even before Substrate can store PRs.

### Records and gates before the release

Phase 3 makes agents open PRs by themselves. If Substrate cannot record a PR, or the gate does not demand links by then, the new automation creates unlinked work faster than before.

### Claims before Jira status

Jira status follows claim and merge events. If claims are lost mid-turn or merges go unseen, statuses flap. Phase 3 makes both reliable first.

### Binding before the UI

XT-110's merged view shows linked items. Without the binding there are none, and the app would only be a second Jira browser.

### Release before the navigator

The Sessions navigator needs the topology feed in a released `xt`. Step 18 publishes it.

## Phase 1 — Safe ground

Goal: no install or update can destroy configuration, this PC follows the server without guesswork, and new work is linked by name from now on.

### Step 1 — Back up before overwrite

[done] [done] `CORE-2538 · XT-126`

- **Brings** — `xt update --apply` saves every locally edited file under `skills-backups/drift-<time>/` before it overwrites it.
- **Why here** — The cheapest guard, already closed. Every later step can write files without losing local edits.

### Step 2 — Stop the silent skill wipe; keep hook changes across updates

[done] [ready] `CORE-2513 · XT-126`

- **Brings** — The prune that deleted 121 skill files on 10-21 logs every removal, refuses a large shrink, takes a tarball first, and cleans per-runtime links. The 10-24 hook fixes merge, so an update stops reverting them.
- **Why here** — It is the only known path that deletes your files with no trace. Until it is fixed, nothing in phase 2 is safe to run.

Folded in: **XT-185** core hook-template merge · **XT-187** **XT-188** the same fix in other repos

> **Ruling on your note · 10-29**
> - Yes, git-managed `~/.xtrm` and `~/.specialists` become the default for everyone, with a local repository and no remote.
> - `xt init` creates the repository. `xt update` commits a snapshot before it changes anything, then commits the result. Rollback is `git revert`.
> - A remote is opt-in. A `.gitignore` for secrets and a gitleaks pre-commit check ship with it.
> - PR 832 (guard, log, tarball) stays as it is; the git snapshot is a follow-up. PR 832 conflicts with main and needs a rebase first.

> **Done · 10-31**
> - xtrm-dev/core#863 (6b461ac8), CORE-2513 closed. A prune that retires more than 3 skills and over 25% of the managed set, or follows a shrunken registry, is refused; `XTRM_ALLOW_LARGE_PRUNE=1` overrides the guard only. Every prune is backed up first and logged to `~/.xtrm/logs/skills-migration.jsonl`; per-runtime active links are swept. 66 tests; reviewer PARTIAL, then fixed and verified.
> - `xt update --apply` is no longer blocked by this step. CORE-2513 was the gate; the go-ahead stays yours.

### Step 3 — Substrate creates and protects its own state; gates use Substrate

[done] [draft] `CORE-2381 · XT-127`

- **Brings** — `sb` creates `~/.xtrm` (0700) and `state.db` (0600). The close and memory gates query Substrate, not the retired `bd`.
- **Why here** — It is small, and the installer calls `sb init`. Gates that ask `bd` fail on any machine without Beads, including this PC.

Folded in: **XT-175** gates point at Substrate

> **Done · 10-31**
> - xtrm-dev/xtrm#304 (e8459a8a), CORE-2381 closed. `openSubstrate` creates `~/.xtrm` 0700 and `state.db` 0600; `sb init` works on a fresh HOME. Existing world-readable DBs are not tightened (possible follow-up). Reviewer PASS.

### Step 4 — Push the server's dotfile repos and write the machine manifest

[done] [you] `prompts 1–2 · XT-127`

- **Brings** — `~/.xtrm` (3 commits ahead) and `~/.specialists` (6 ahead) reach GitHub after a secret scan, with the user-level Claude guard hooks versioned. A JSON manifest lists every tool and version on the server.
- **Why here** — The manifest is the target this PC is compared with, and the first draft of the release manifest in phase 2.

Folded in: **XT-189** version the guard hooks in ~/.xtrm

> **Done · 10-31**
> - `~/.specialists` pushed (a3b805e, no leaks). `~/.claude` is now the private repo `Jaggerxtrm/.claude`: an allowlist tracks settings, `CLAUDE.md`, guard and xtmux hooks, agents, output style and plugin lists; credentials and sessions stay local. The PC keeps voice and `model` as a local change.
> - Manifest: `python3 ~/.xtrm/scripts/machine-manifest.py <machine>` writes `~/.xtrm/manifests/<machine>.json`; `--diff server pc` compares. Remaining gap: `acli` on the PC (needs your Atlassian login). Pi packages closed in step 10.
> - All three dotfile repos are now git checkouts on both machines: update with `git pull`, change through a branch and PR (the branch-model guard blocks direct pushes).

> **Done · 11-01**
> - Rest of `~/.pi` copied from the server: 16 agents, 4 prompts, `AGENTS.md`, `APPEND_SYSTEM.md`, `tool-slim.js`, `copy-message.ts`, the MCP config, `trust.json`, `models-store.json`, `bin/fd`. Five config files hash-checked identical. The 4 themes are links into core (`packages/pi-extensions/themes/xtrm-ui`) and resolve on the PC.
> - Not versioned yet: the 16 Pi agents and 4 prompts are plain files that no repo ships, and the manifest does not cover them, so they can drift again.
> - `skill-suggest/log.jsonl` is git-ignored in `~/.xtrm` (PR #8); it no longer causes conflicts on pull.
> - Headroom proxy removed from the PC: proxy, cron jobs, shell blocks and the tmux variable. Claude Code now connects to Anthropic directly, as on the server. Reason: Remote Control did not work on the PC, and the proxy address was the only difference found. Confirmed 11-02: Remote Control now works on the PC. Backup: `~/xtrm-parity-backup-20261031/headroom-20261101/`.

### Step 4b — Unlock GitHub Actions for xtrm-dev

[done] (v4) [you] `billing · all xtrm-dev repos`

- **Brings** — Every xtrm-dev job fails at start with *“The job was not started because your account is locked due to a billing issue.”* The org is on the Free plan. core, specialists and mcp-inspector are public, so their Actions minutes cost nothing; xtrm and .github are private. Actions usage was fully discounted (net $0) in August, September and October. The only charged item is GitHub Advanced Security: $19 net in August and in September, and $11.65 so far in October.
- **Why here** — No check can pass on core until this is fixed, and step 15's gates need running checks. Inference, not verified: the lock comes from an unpaid Advanced Security charge, not from Actions minutes.

> **Ruling on your note · 10-29**
> - You: settle the open charge or update the payment method in the xtrm-dev billing settings. The lock lifts once the account is in good standing.
> - Then turn off Advanced Security for the private repos unless you use it. Public repos get secret scanning and code scanning free.
> - Making `xtrm` public would also remove its minute cost, but it publishes the whole history. Scan it for secrets first.
> - mercuryintelligence is not affected: its runners are self-hosted.

> **Ruling · 10-31 · replaces this step**
> - Actions on xtrm-dev stays locked: you will not pay, and no runner goes on this PC. A desktop that sleeps is a flaky CI, and a self-hosted runner on a public repo (core, specialists) can run code from any fork PR on your machine.
> - Checks run where the work runs: each repo gets one local command (`make ci` or `npm run ci`), workers run it before a PR, and the host records the result in the Issue Journal with the head SHA (step 14). The merge guard reads that record, not GitHub checks.
> - Only core needs `--admin`: it requires four Actions checks (OSV, Semgrep, Gitleaks, pr-review-gate) that cannot start while Actions is locked. specialists requires none; private repos on the Free plan cannot have branch protection. Proposal: remove the four checks on core and run gitleaks, OSV and Semgrep in the local check command instead. Needs your yes: it changes branch protection.
> - Mercury repos are unaffected: their self-hosted runners belong to mercuryintelligence, which is not locked.

> **Done · 11-11**
> - You restored GitHub Actions on xtrm-dev. Verified: a re-run of CI on core `main` (96e6c379) now executes its steps, where every run since the lock had started 0 steps.
> - From now on a red check is a real result again: merges wait for green checks, or for failures shown to be identical on `main`. The 10-31 local-check rule stays as the fallback when runners are unavailable.

### Step 4c — Skill-suggest hotfix

[done] (v4) [new] `CORE-2532 · Pi extension`

- **Brings** — The roster is split across calls so no call exceeds the 255-item cap. Every failed call writes a log row, and a doctor check reports it. The suggestion becomes a one-line instruction instead of a file path.
- **Why here** — It has been broken since 10-13: 281 skills against a cap of 255, so every call returns HTTP 422 and the error is swallowed. The fix is small and nothing waits on it. The larger redesign is step 12b.

### Step 5 — Sync this PC by copy, not by xt update

[done] [you] `report section 3`

- **Brings** — The same repos, linked tools, `~/.claude` and `~/.pi` as the server, plus the `sb` SSH wrapper. Beads leftovers are removed on both machines. Remote Control and tmux are already done.
- **Why here** — Both machines then run the same code. The copy avoids the updater until steps 1–3 land.

Folded in: **XT-106** Beads removal across machines

> **Ruling on your question · 10-29**
> - Found on the server: `~/dev/xtrm` still sets `core.hooksPath` to `.beads/hooks`, so the retired Beads hooks run on every commit there. The Beads removal (XT-106) resets it.

> **Ruling · 10-29**
> - Specialists on this PC are linked to the `~/dev/specialists` checkout, exactly as on the server (global npm link), not installed from the npm registry. The registry package is older than master; a release is step 18.
> - The sync also runs `sp prune-stale-defaults --dry-run` in every repo: stale `.specialists/default` snapshots shadow the package and can name retired skills.
> - `~/.claude/agents` on the server holds hand-kept mirrors of reviewer, executor, debugger, quant-methodologist and advisor; this PC has none. They are copied in this step, and versioned in `~/.xtrm` with the guard hooks (step 4), because no tool regenerates them and nothing diffs them against the specialists they mirror. A drift check joins step 16.

> **Done · 10-31**
> - PC now matches the server: `xt` 0.15.3 (linked to `~/dev/core`), `sp` 4.1.1 (linked to `~/dev/specialists`), `sb` 0.2.2 (npm). The old `sb` on the PC was the lrzsz serial tool.
> - Copied: 341 skill files (newest wins, nothing deleted), `~/.claude/agents`, `~/.specialists/user` (5 global specialists), both specialists `user.json` files, Pi `models.json` and `auth.json`. Same 28 specialists on both machines. Backup: `~/xtrm-parity-backup-20261031*`.
> - Core vendored skills brought to the server state: core#862; package source: xtrm#303. Both admin-merged.
> - Same on both machines, not caused by the sync: `service-knowledge-sync` cannot dispatch inside `~/dev/core` (core vendors the package root, no top-level `SKILL.md`); the specialists `user.json` has 15 entries failing schema validation.
> - Full `~/.xtrm`: the PC is now a git checkout of `Jaggerxtrm/.xtrm` `master` (8c55da5). The server pushed its working branch to `master`, with the newest mercury-visual-style restored (6f6322a). Update the PC from now on with `git -C ~/.xtrm pull`. Same 37 Claude and 35 Pi skills.
> - `~/.claude`: the server’s settings (plugins, hooks, output style, skill overrides, statusline), its 14 plugins, global `CLAUDE.md`, hooks, commands, output styles, mods and the archon hooks. PC kept: voice, `model`. Dropped: the PC’s Orca hooks (step 13). `~/.claude` is not in git on the server; step 4 should version it.
> - Not done here: Pi 1.3.0 and packages (step 10, interactive list), Substrate data on the PC (step 7).

### Step 6 — Linking names in force

(v2) [new] `XT-178 amendment`

- **Brings** — The xt launcher, the specialists workspace lease and the programme-coordination skill use `xt/<JIRA>-<REF>-slug` branches and `<JIRA> <REF>: …` PR titles. Commits get a `Jira:` trailer when the work is bound.
- **Why here** — GitHub for Jira is installed and already sends builds, so the names alone fill the dev panel with PRs. It needs no Substrate change, so it starts now.

> **Ruling · 11-01 · worktree names**
> - One worktree root for the whole stack: `<repo>/.xtrm/worktrees/`. Launcher sessions: `<repo>-xt-<runtime>-<name>` on `xt/…` (as today). Specialist writers: `<repo>-sp-<role>-<issue>` on `sp/<issue>`, based on `origin/<default>` (SPECIALISTS-4393; today they go to `<repo>/.worktrees/<issue>` from `HEAD`).
> - Ad-hoc worktrees under `~/.cache/<issue>/wt` (seven in market-data, mostly detached) are outside any naming and any reaper: steps 24 and 27 find all three kinds until they are gone.

> **Filed · 11-01**
> - CORE-2571: `<prefix>/<JIRA>-<REF>-<slug>` branches (prefix `xt` or `sp`, keys uppercase) and `<JIRA> <REF>:` PR titles; unbound work drops the Jira part. One helper for the launcher, the specialists lease and the skill text.

### Step 6b — Every bound commit names its Issue, in any session

(v4) [new] `git hooks · Substrate trailers · XT-178 · XTRM-734`

- **Brings** — A git `prepare-commit-msg` hook adds `XTRM-Issue` and `XTRM-Issue-Revision`, plus `Jira: <KEY>` when the Issue is bound to Jira. It works the same in Claude, Pi, Codex, a specialist or a plain terminal, because git runs it, not the agent. It finds the Issue in this order: `SUBSTRATE_ISSUE_REF`; the worktree's own binding, which `xt` and the specialists lease write when they create or claim a worktree (`git config --worktree xtrm.issue`); the ref in the branch name. With no binding it adds nothing and never blocks.
- **Why here** — The trailers are the evidence that survives rebase, squash and cherry-pick (steps 26, 27), and Substrate already has the code that writes and parses them (`provenance.ts`). Nothing calls it: 0 of the last 300 commits on core's main carry `XTRM-Issue`. The Issue trailer needs no receipt, so it can start in phase 1; the receipt trailer follows in step 22.

> **Ruling on your question · 10-29**
> - Jira needs no extra machinery. GitHub for Jira already reads Jira keys from commit messages, branch names and PR titles; the hook only has to write the key. The key comes from the Substrate binding (step 33); until bindings exist, from the branch name (step 6).
> - Hooks must chain, not replace. core sets `core.hooksPath` to its own `.githooks`, market-data has its own pre-push hook, and service-knowledge installs hooks too. So `xt` adds one call to each repo's existing hook instead of setting a global hooks path.
> - Cost: one local `sb` read per commit. No network call.
> - The Claude-only `commit-check` hook in the Substrate plugin stays a nudge. It reads `SUBSTRATE_ISSUE_REF` and never blocks; the git hook is what makes it mechanical.

> **Filed · 11-01**
> - Found: Substrate’s `prepare-commit-msg` hook exists but adds trailers only with `XTRM_RECEIPT_ID`, which nothing sets, and no repo installs it.
> - XTRM-684: the hook resolves the Issue without a receipt (env, worktree binding, branch) and adds `XTRM-Issue`, revision, `Jira:` and `Agent:` (taken over from CORE-2525). CORE-2570: `xt` chains it into each repo’s existing hook and writes the worktree binding. XTRM-684 lands first.

> **Measured · 11-11 · design note**
> - The hook is not installed: 3 of the last 100 squash commits on core’s main carry the trailer, 0 of 100 on xtrm. xtrm squashed to the PR body until 11-11; its squash setting now keeps commit messages, so T2 counts there too. Substrate’s `parseTrailers` is last-wins and needs an all-values form before T2 ships; `XTRM-734` tracks the fix and blocks `XTRM-727`.

### Step 7 — Decide how Substrate works across two machines

[partly done] [new] `prompt 3 · XT-127`

- **Brings** — The server stays the only database. The PC uses a remote `sb`, later served by the agent host over Tailscale. The decision covers claims across hosts, hook latency and offline use.
- **Why here** — The registry, the reconciler and the Jira client all live in the agent host. Where Substrate lives decides how they reach it.

> **Ruling on your note · 10-31**
> - Yes: a setting, e.g. `substrate.remote = "ssh server"`. When set, `sb` forwards each call over ssh to the server; when unset, `sb` runs locally as now. Agents and skills type plain `sb` either way. Today the PC has `sb` but no data (`unresolvable ref`).

> **Filed · 11-01**
> - XTRM-685 (HIGH): `substrate.remote` setting; `sb` forwards argv, stdin and exit code to the server and maps the working directory by git origin; unset means local. Offline fails clearly, never an empty local store. Includes the decision record.

> **Status · 11-01**
> - After the session restart the specialists plugin loads: 28 specialists, 22 dispatchable. The other 6 need Mercury repos, `pytest` or `yt-dlp` on the PC.
> - This step now blocks the plan: the PC Substrate plugin returns `unresolvable ref` for every server Issue, so no native dispatch can claim work on the PC. SPECIALISTS-4393 stays open until XTRM-685 lands and one live writer dispatch proves the worktree path.
> - Next: complete the XTRM-685 contract and ADR (transport choice: ssh per call, or an `sb` server over a tunnel), then attest. XTRM-684, CORE-2570 and CORE-2571 are also still drafts.

> **Scope change · 11-02 · XTRM-685 rev 2**
> - Forwarding `sb` alone does not unblock the PC. The Claude MCP plugin, the Pi extension and specialists native dispatch open `state.db` directly and never call `sb`; specialists also uses raw SQLite for activation authority.
> - The contract is now staged. Stage 1 is an ADR covering all five consumers, and work stops there for your transport decision. Stage 2 is the CLI forward. Consumers the CLI stage does not solve become follow-up Issues.
> - Worker: `core-xt-pi-6vnw` on Pi. The coordinator reviews and merges.

> **Ruling · 11-02**
> - Transport: `ssh` with no listener and no daemon (ADR-008). Stage 2, the CLI forward, is released to the worker.
> - A worker runs where its code lives, and either machine can start one over `ssh`. Dispatch itself stays local to the session that starts it.
> - Goal: a server coordinator starts heavy workers on the PC, so they use PC resources instead of the production server. The server already reaches the PC over Tailscale (key login tested); the PC must be on and online.
> - Needed for that: a `Host pc` entry on the server, and the specialists remote-store follow-up, which is now the priority after Stage 2.
> - Claude MCP placement: a launcher reads `substrate.remote`. Set: the server runs it over `ssh`. Unset: it runs locally, as today.
> - Rule: every setting works both ways, by preference. A user with no server gets the local behaviour for every consumer, with no `ssh` requirement.

> **Merged · 11-02**
> - `sb` remote mode merged: xtrm#307 (XTRM-685), commit `2d33ec76`. It covers the CLI and git hooks. It is not released yet: both machines still run `sb` 0.2.2 from npm.
> - Evidence: 918 tests, mutation checks, a security audit and four review rounds; live read and write from the PC against the real server. GitNexus rates the change critical because it touches the central `sb.ts` paths.
> - Follow-ups filed from ADR-008: XTRM-690 typed stdio service, then XTRM-691 Pi extension, XTRM-692 Claude plugin and launcher, XTRM-693 stale store guard, and the specialists Issue for native dispatch. Native dispatch from the PC stays blocked until those land.

> **Released · 11-02**
> - Released: `@jaggerxtrm/substrate` 0.2.4 is on npm (xtrm#308, commit `6252088d`), published from the server. Your ruling 11-02: publishing is allowed whenever the time is right, and it runs from the server, where npm is configured.
> - Installed on the PC. `sb remote setup ssh:server` is done in the core checkout, and `sb issue show CORE-2524` now reads the server record from the PC. Other repos need the same setup, run once inside each. `sb remote disable` returns the PC to local mode.
> - The server still runs `sb` 0.2.2. Upgrading it adds `--participant` on journal appends. XTRM-690 needs a newer server `sb`, so upgrade it together with that work.
> - The changelog had no 0.2.3 entry although 0.2.3 was on npm. A 0.2.3 section was reconstructed from commit subjects; check it.

> **Merged · 11-06**
> - The typed stdio service merged: xtrm#309 (XTRM-690), commit `264468e`. `sb serve --stdio` offers 60 named operations behind a handshake, plus a client that fails closed. It is not released yet; the server still runs `sb` 0.2.2.
> - Evidence: four review rounds. Round four fixed two high defects (identity fields were rejected by claim and journal operations in every harness session; the client refused to start when identity variables were set) and the host-name “server” being read as a missing verb. The coordinator re-ran the service tests (123 of 124, one skipped) and probed identity and transport classification directly. CI proves nothing: Actions still fail at startup.
> - Not verified by the coordinator: `tsc` (the worker reports it clean). Open small item: the oversized-answer refusal says “the operation” instead of naming it.

> **Ruling · 11-06 · authority**
> - XTRM-700, option A: `authority.remove` requires the `specialist` and it must match the row. No compatibility window. The specialists host change ships before authority is switched on remotely. Options B (stale-state risk) and D were rejected.
> - New Issues: XTRM-701 (authority row cap and TTL), SPECIALISTS-4398 (dispatch refuses worktrees; ready) and SPECIALISTS-4399 (host `stop()` passes the specialist; ships before authority goes remote). XTRM-700 blocks the authority part of SPECIALISTS-4395.
> - Next, in order: a small follow-up PR, then release prep for the next substrate version, which the coordinator publishes from the server and then upgrades the server’s `sb` and checks the handshake there. After that: XTRM-691 (Pi), XTRM-692 (Claude plugin and launcher), XTRM-693. Authority is switched on last.

> **Released · 11-06**
> - `@jaggerxtrm/substrate` 0.2.5 is on npm (xtrm#319 and #320, commit `8709e0e`), published from the server after a clean-worktree verify (node and bun, 137 exports, plugin seam).
> - Server `sb` upgraded 0.2.2 to 0.2.5 after a consistent backup of `state.db` (`state.db.pre-sb-0.2.5-20261106`). The database was already at migration 12, the newest in 0.2.5, so no schema change. The PC runs 0.2.5 too.
> - Live proof: `sb serve --stdio` answers the handshake on the server (protocol 1, 60 operations). From the PC, the service client over ssh resolved CORE-2524 and read it, with and without `SUBSTRATE_HOLDER` and `XTRM_SESSION_ID` set. The CLI forward still works.
> - Next: XTRM-691 (Pi extension), then XTRM-692 (Claude plugin and launcher). Authority stays off until XTRM-700, XTRM-701, SPECIALISTS-4398 and SPECIALISTS-4399 land.

> **Merged and released · 11-06 · consumers**
> - `@jaggerxtrm/substrate` 0.2.6 is on npm (xtrm#326, `f56457d`), published from the server. The server `sb` and the PC run 0.2.6. The PC Claude plugin is updated; Claude Code and Pi sessions must restart to load it.
> - Every consumer now reaches the server store: Pi tools through the typed service (xtrm#322), the Claude MCP launcher and hooks over one ssh (xtrm#325), a per-session connection with one retry for reads only (xtrm#327), and a Pi edit gate that blocks on all six transport failures, `timeout` included (xtrm#328). Mutations are never retried.
> - Defects the coordinator caught in review: #325 located the launcher script from the checkout instead of the installed package (reproduced live, fixed); #328 omitted `timeout` from the gate; #319 did not name the operation in the oversized-answer message.
> - Not verified by the coordinator: `tsc`. The worker reports it clean.

> **Merged · 11-06 · guard and owner**
> - xtrm#329 (XTRM-693, `7f5ff35`): `openSubstrate` refuses the canonical local store when a remote is selected (`remote_store_selected`). An explicit `--db` or `SUBSTRATE_DB` is honoured. Evidence: 4 guard tests pass and the CLI still reads CORE-2524 through the remote with the guard in place.
> - xtrm#330 (XTRM-700, `7afbf79`): `authority.remove` requires the owning `specialist`. A foreign owner gets `conflict` and the row stays. An unnamed call gets `bad_request`. A row that is already gone answers `removed: false`. Review caught one protocol test that passed for the wrong reason; it now names the owner and asserts the state message.
> - Open notes from #329: an explicit path equal to the canonical path is refused although the comment says explicit paths are honoured (later PR); `wake-on-event.mjs` opens the local store on the PC and was already quiet before the guard (own Issue).

> **Ruling · 11-06 · specialists host port**
> - Correction: the earlier diagnosis of SPECIALISTS-4398 mixed two stores. The specialists host reads the PC’s stale local `state.db` and ignores `substrate.remote`.
> - Decision: refactor the host ports to async (option i). Rejected: a worker-thread synchronous facade (ii) and ssh-exec of `sb --json` (iii), which would add 5 to 8 seconds per dispatch. Size: 10 methods on `IssueServicePort`, 2 on `IssueStorePort`, 14 on `SpecialistWorkItemBoundary`, 6 source call sites, 24 test call sites, 5 fakes.
> - No default-off switch for `authority.*`. Sequence is the control: SPECIALISTS-4398 first, then SPECIALISTS-4399 with XTRM-700 (done), then XTRM-701 (row cap and TTL), and the authority switch (SPECIALISTS-4395) last.
> - Status: worker 6vnw holds SPECIALISTS-4398 on branch `xt/SPECIALISTS-4398-worktree-dispatch`. The ports return promises and the code does not typecheck yet (25 errors in one file). Evidence required: a live worktree dispatch against the server store. Specialists releases publish from the server and need the coordinator’s go.

> **Status · 11-07**
> - **Done and merged:** remote mode, the typed stdio service, Pi and Claude consumers, the Pi gate, the stale-store guard (XTRM-693 closed, xtrm#329) and the owner-required removal (xtrm#330). Substrate 0.2.6 is released. Live proof: the PC reads and writes the server store, and `gate.check` and `gate.dispatch` are answered over the wire.
> - **In progress:** SPECIALISTS-4398, the specialists host reads the server store. The async port and the async settlement exclusion are built and typecheck (branch `xt/SPECIALISTS-4398-worktree-dispatch`, `b8095bfb`, pushed, no PR). The remote adapter, its fail-closed tests and the two live dispatch runs are not built. The first worker handed off with a full mapping note on the Issue; a new worker must pick it up.
> - **Ruled:** over the remote, `completedBlockers` answers “no blocker information”. It only feeds prompt context. Parity is a draft, XTRM-715 (`issue.listActiveEdges`), unscheduled.
> - **Still ahead, in order:** the adapter, then SPECIALISTS-4399 (host `stop()` names its owner), XTRM-701 (row cap and TTL), the authority switch (SPECIALISTS-4395) last. XTRM-700 stays open until the row-rewrite part is settled.
> - **Correction:** the 11-06 checkpoint was written on CORE-2524 by mistake. CORE-2524 is the robot-identities Issue (step 20). Journal seq 23 there marks seq 22 as misfiled. A home for these checkpoints is an open question to you.

> **Merged · 11-07 · specialists reach the server store**
> - SPECIALISTS-4398 is closed. specialists#522 (`436b4a62`) and #523 (`5d881836`) are on master; xtrm#332 (ADR-008 consumer section) is on main. With `substrate.remote` set, a dispatch from a core worktree creates and claims its Issue on the server (probe CORE-2583). An unreachable server refuses with `connection_lost` and never opens the local store. After a dropped link the next call reopens a fresh connection; the failed call is not retried.
> - Not released: the PC’s installed specialists does not have this yet. A specialists release needs your go.
> - Parked by your priority call: XTRM-715 (blocker parity), SPECIALISTS-4399, XTRM-701, and the authority switch (SPECIALISTS-4395). XTRM-700 is open with no holder.
> - Decided: `acli` and the Exa key stay on the server; the PC reaches them over ssh.

### Step 8 — Duty map: every Substrate feature gets an owner

(v3) [new] `ADR in prj_xtrm · XT-114`

- **Brings** — One decision record lists each Substrate duty, who performs it (host, hook, gate or agent) and what makes it unavoidable. The table above is the draft.
- **Why here** — Steps 15, 16, 22 and 30 each implement part of it. Without one map, each of them would decide again who owns what.

> **Ruling on your note · 10-29**
> - Skill-suggest is not a duty-map item. The hotfix is step 4c and the redesign is step 12b.

## Phase 2 · XT-114 — One command to install, one to update

Goal: `xt init` brings a fresh machine to a verified ready state and `xt update` brings an existing one to latest, both from one release manifest with exact pins. The release also ships PR recording and the link gate.

### Step 9 — Install runtimes before Substrate enrollment

[draft] `CORE-2380 · XT-126`

- **Brings** — `xt init` installs node packages, Pi, Claude plugins and Python tools, then calls `sb init`. The audit needed six manual fixes on a fresh machine.
- **Why here** — It shapes the installer; the Pi, plugin and picker steps plug into it.

### Step 10 — Real Pi runtime, current Pi, packages that really upgrade

[partly done] [draft] `CORE-2378 · CORE-2400 · CORE-2379 · XT-125`

- **Brings** — The real `pi`, no oh-pi, the extension audit, and a refresh that verifies the installed version. The pin target is Pi 1.4.0 if that upgrade is proven first; otherwise 1.3.0. Specialists bundles keep their extension selection.
- **Why here** — Pi runs the specialists. Dispatch in phase 3 breaks if Pi drifts between machines.

Folded in: **XT-191** Pi 1.4.0 upgrade · **XT-183** bundle drops extension selection

> **Ruling on your note · 10-29**
> - After the parity sync (step 5), a specialist inventories `~/.pi` settings and the packages that core, specialists and xtrm declare.
> - A package counts as active only when Pi loads it, it ran in the last 30 days, and code depends on it.
> - You get the result as a list and mark keep or remove per package. Step 11 removes only what you marked.

> **Done · 11-01 · packages (version open)**
> - Your choice, applied on both machines (backups `*.bak-20261101-pi-parity`): gitnexus, guardrails, pi-goal, pi-tasks, ast-grep, our pi-extensions (core checkout), service-knowledge, native-specialists, xtmux, agentrun-pi, billion-context, Substrate 0.2.2. Removed: ponytail, structured-return, mermaid-viewer and every retired package; Pi’s built-in MCP re-enabled on the PC; Orca extensions binned.
> - core#865 (CORE-2572): `xt update` keeps exactly this set and sweeps the retired ones. specialists#515 (SPECIALISTS-4394): researcher off `pi-mcp-adapter`, python-kernel pin at 0.15.3.
> - Pi version: your ruling 11-01 is 1.4.0 (agentrun runs through its DSL, rarely through pi-durable). PC upgraded and smoke-tested: every package loads and registers its tools (gitnexus, specialists, Substrate, agentrun, tasks, goal, ast-grep, python, background, messaging), no load errors. billion-context injects its tools per request, so its check is the next long session. Server upgraded 11-01 with the same result; the long-running session survived. Pi settings, models and auth now identical on both machines (manifest checks settings and models by digest).
> - Follow-up: Exa is in neither machine’s built-in MCP config, so the researcher has no Exa tools until an Exa key is added.

> **Filed · 11-11 · CORE-2591**
> - `npm:pi-claude-bridge` joins the managed Pi package set as managed optional, so `xt init` installs it and `xt update` reconciles it. Today it is on the PC only because it was installed by hand (0.12.0). Installing it does not turn the Claude route on: that stays `claude_bridge.enabled`, opt-in, operator login only.
> - Worker `bridge-pkg` (xt pi). The server gets the package but not the switch (unattended fleet).

### Step 11 — Manage the unmanaged Pi packages; remove dead ones

[partly done] [draft] `CORE-2385 · CORE-2386 · XT-125`

- **Brings** — pi-subagents and pi-processes join the managed list; the dead quality-gates extension goes.
- **Why here** — Until every package has an owner, the update cannot tell a stale package from one you installed. That is how `~/.pi` drifted.

> **Ruling on your note · 10-29**
> - After the parity sync (step 5), a specialist inventories `~/.pi` settings and the packages that core, specialists and xtrm declare.
> - A package counts as active only when Pi loads it, it ran in the last 30 days, and code depends on it.
> - You get the result as a list and mark keep or remove per package. Step 11 removes only what you marked.

> **Done · 11-01**
> - The unmanaged and dead packages are gone on both machines; the quality-gates extension removal stays CORE-2386 (step 13b).

### Step 12 — One versioned xtrm Claude plugin

[draft] `CORE-2391 · XT-130`

- **Brings** — One marketplace plugin owns the XTRM hooks, picker hooks, primer, coordination hooks and watch tools. The status lines merge into one. Third-party plugins stop rewriting `settings.json` on boot.
- **Why here** — The two machines' hook sets differ today. A plugin makes them equal by version, and phase 3 adds hooks.

Folded in: **XT-181** coordination hooks in the roster · **XT-186** context-mode re-registers a hook · **XT-192** one status line

### Step 12b — Context-aware suggestions, also as a Claude mod

[partly done] (v4) [new] `CORE-2532 · specialists Claude mod`

- **Brings** — One core library (roster, classifier client, decision log) used by the Pi extension and by a Claude mod. The mod is a plugin monitor, not a hook: it reads the end of the session transcript, knows whether a turn is running, binds each suggestion to the turn it was computed for, and drops it if that turn has ended. It never wakes an idle session. substrate-suggest moves into the same library.
- **Why here** — It ships with the Claude plugin (12), so both runtimes get the same suggestions from the same version.

> **Ruling on your note · 10-29**
> - What the extension reads today: the `input` event, which is the prompt that starts a turn. In your sessions that is what you type; in a worker it is the dispatcher's prompt. It never reads the agent's reasoning or tool output.
> - Challenge: reading the transcript costs more, not less. A second process would tail and re-parse a growing file for every session. The extension itself is cheap in memory; its cost is one model call per prompt.
> - Better context at the same cost: send the classifier a small structured context with the prompt: the claimed Issue (ref, kind, title), its work stage, the repo and service territory, and the last few tool names. All of it is already in memory or in the claim.
> - Skip the call when the prompt is a continuation (“go on”, “yes”), and reuse the last decision.
> - Success measure: how often agents act on a suggestion. Today it is about 6%. I set the target after one week of clean logs.

> **Evidence · 10-30 · XTRM-681 field report**
> - The field report (worker XTRM-680-bili) proves the extension has been dead since 10-13: 281 roster items against a classifier limit of 255, every call HTTP 422, the error swallowed.
> - Before it died, its pointers were acted on in 6.3% of 446 injections. Agents do not open a file they are told exists. So every pointer we design from here (22c, 22d, 16b) hands over an explicit “read these first” list with absolute paths, or the rule text itself, never a bare mention.
> - Your note asks for the same thing as a Claude plugin after hardening: that is this step; 4c is the hotfix.

> **Measurement · 11-11 · CORE-2580 Journal seq 3 and 5**
> - Why a monitor and not a hook: your constraint on this work is that a hook, if used, adds no memory and no latency (CORE-2580 Journal seq 2). On Claude Code 2.1.318, median of 8 turns per path, machine load 9 to 11, the hook was the slowest path and the only one that starts a process on every call. The differences are tens of milliseconds, so read them as direction.
> - Time from pressing Enter to the request leaving: no mod 54 ms; hook running node 104 ms, with a process of about 45 MB for each call; hook running `true` 80 ms; plugin monitor 68 ms, one resident process of about 46 MB with node; channel 63 ms, one resident process of about 45 MB.
> - A monitor can tell whether a turn is running from the transcript tail within about 0.15 s: six live scenarios, 2.2% disagreement with the terminal indicator, 0.16 ms to read and classify the tail. It answers “unknown” when the transcript layout changes, and then sends nothing. The transcript layout is internal and undocumented, so that guard is required.
> - A wake turn on an idle session cost about 39.6k cached input tokens, so a suggestion for a finished turn is dropped, never delivered by waking the session.
> - Not yet measured: an authenticated classifier call from the monitor process, and the drop rate. CORE-2594 measures both before anything is built.
> - The mod is a standalone plugin directory that the xtrm Claude plugin (step 12, CORE-2391) adopts unchanged. Nothing is merged into that plugin before step 12.

### Step 12c — Substrate recall: one search over project memory

(v6) [draft] [new] `CORE-2581 · CORE-2594 to CORE-2599 · packages/substrate`

- **Brings** — `sb recall "<terms>"` and a `recall` tool for Claude and Pi. One local index over the Substrate journals of all projects, then Jira comments, PRs and commits for core and MMD. An answer is at most three short snippets with a link, a date, an authority and a superseded flag. Secrets are scrubbed before anything is stored. Operator rulings rank first. The suggestions of step 12b can append the snippets to a nudge.
- **Why here** — Facts recorded in journals, Jira comments and PRs are missed because nothing searches them together: on 11-04 a Substrate result was reported as missing and operator rulings were recovered by hand. It follows 12b because the nudge carries the snippets, and the generated Substrate reference (16) teaches the tool from `sb help --json`.

### Step 13 — Picker fixes; remove herdr and orca writers

[ready] `CORE-2387 · CORE-2393 · XT-129`

- **Brings** — Correct pane states; the picker looks exactly as now; two competing writers go.
- **Why here** — Pane state seeds the phase 3 registry. Wrong states here would be wrong there.

> **Ruling on your note · 10-29**
> - herdr and orca removal stays here.
> - The richer picker and the roster sidebar move to step 28b: the precise statuses need the registry (24) and the work stages (30).

### Step 13b — Retire dead commands and roles

(v5) [partly done] `CORE-2552 · SPECIALISTS-4391 · CORE-2386`

- **Brings** — `xt merge` (unused since July, CORE-2552), the `xt-merge` and `node-coordinator` specialists (usage checked first), and the dead quality-gates Pi extension (CORE-2386). Each retirement counts real uses before removal and asks you if it finds one.
- **Why here** — A stale command is a wrong route for agents. Removing them before the coordinator and identity work means nothing new is built on them.

> **Found · 11-11 · design note**
> - `xt end` is a retirement candidate: `xt end --dry-run` read a conventional-commit scope as an issue ref (`end.ts:191`) and invented an issue; its markers appear in 0 of the last 80 core PRs; it force-pushes, rebases and removes the worktree. Count real uses first, as this step requires.

### Step 14 — Substrate records PRs and commits

(v2) [new] `XT-178 amendment · prj_xtrm · XTRM-725 · XTRM-726 … 730`

- **Brings** — A new `sb provenance attach <ref> pr github:org/repo#n` verb, using the existing `attachArtifact`. The host records the PR (number, URL, head SHA) in the same step that opens it, and the commit SHA at receipt. `sb issue show` and `trace` print them as clickable links.
- **Why here** — It is the core of your ruling: an open PR means Substrate has its number and link. It ships in this release, so every PR from phase 3 on is recorded.

> **Ruling on your note · 10-29**
> - Confirmed as fully mechanical. The host writes the PR record locally in the step that opens the PR; no API call is involved.
> - The reconciler (26) uses conditional GitHub requests, so an unchanged answer costs almost nothing against the rate limit.

> **Answer to your note · 10-31**
> - Two plans propose one tool set for both runtimes: XTRM-668 (commit `70879746`, “shared tool surface” for the Substrate Claude plugin and Pi extension) and XTRM-638 (codemode-first Pi tool architecture). This step uses that surface.

> **Ruling · 11-11 · your answers to the design note**
> - Yes to all seven: `github:org/repo#n` is an input form and `org/repo#n` is stored; a PR known only from its title or branch is a mention, not delivery; `sb links check` is a new top-level verb owned by step 33 and used by step 15; the relations are named `created_from` and `mentioned`; mentions are stored rows written by an explicit verb; a trailer on the PR’s commits (T2) counts as delivery where the merged message keeps it; an explicit link without a receipt or trailer can never claim `created_from`.
> - xtrm’s squash merge now keeps the commit messages (title stays the PR title), as core already did, so T2 works in both repositories.

> **Ruling · 11-11 · design note**
> - Refined by the design note “Linking a Substrate issue to its pull request” (11-11, `soulful-karma-8zk3.here.now`, copy in `notes/issue-pr-linking.html`). A PR link has two relations: `created_from` (this PR delivered the issue; may close it) and `mentioned` (only named in prose; never closes it). Stored in a new `issue_pull_requests` table, written in one transaction with the PR artifact.
> - Two kinds of delivery evidence: T1 a receipt (host record at PR open, or an `XTRM-Receipt` trailer of this issue); T2 a commit in the PR carrying `XTRM-Issue: <this issue>`, which survives squash because it reads the PR’s own commits.
> - `sb provenance attach` accepts `github:org/repo#n`, `org/repo#n`, a PR URL or a bare `#N` (scoped to the issue’s repository) and stores `org/repo#n`. The opener is the `gh` shim now, the host later; not `xt end`.
> - Delivery in five slices, each shippable alone: schema and read model with a dry-run check; writers; reconciler; enforcement (last, flagged, warn-only first); console.
> - Filed 11-11: the epic is `XTRM-725`; the slices are `XTRM-726` schema, read model and `sb links check` dry run, `XTRM-727` T1 and T2 writers, `XTRM-728` reconciler, `XTRM-729` close gate and `sb links check`, `XTRM-730` console. `XTRM-734` (parseTrailers keeps only the last `XTRM-Issue` trailer) blocks `XTRM-727`.

### Step 15 — Gates refuse unlinked work

(v2) [new] `XT-178 amendment · XT-167 · XTRM-729`

- **Brings** — pr-review-gate fails a PR whose title or link block names no Substrate ref. `sb issue close` needs a live claim, a result entry, and a PR or commit record (or an explicit no-code reason). A claim refuses a contract that fails `sb issue validate`.
- **Why here** — A rule nothing enforces decays, as the 1-in-400 figure shows. The gate goes live before agents open PRs by themselves. The gate template is fanned out by hand to the 16 repos.

Folded in: **XT-167** close succeeds after the claim lapsed · **CORE-2527** to **CORE-2531** identity apps, merge guard, `xt decision`, audit

> **Ruling on your note · 10-29**
> - pr-review-gate was not removed: it is still required on core's main. It fails in 3–4 seconds with zero steps because Actions is locked (step 4b).
> - So the link requirement is enforced where no runner is needed: the host writes the links when it opens a PR, and the merge guard (CORE-2530) refuses a PR without them. The Actions check is a third layer that runs when runners exist.
> - The agent identities programme (CORE-2524, XT-190) plugs in here: reviewer, builder and release GitHub Apps, `xt decision` and the merge guard.

> **Ruling · 10-30 · CORE-2524 rev 9**
> - Two Apps now: reviewer (reviews, no code write) and builder (pushes `xt/*`, opens PRs). The release App and CORE-2530 are deferred: merging needs the same permission the builder has, so a separate actor only helps where a ruleset limits merges to it.
> - No new agent surface: agents keep plain `git`, `gh` and `sb`; wrappers add tokens, trailers and markers. No `xt decision`, no `--identity`. Coordinators record an accept with `sb journal append --kind decision`.
> - Role source: a plain `xt` session is builder; `--role` and specialists use one map under `~/.xtrm/config`; reviewer and merge tokens belong to the action, not the session.
> - `xt merge` is retired: CORE-2552.

> **Ruling · 11-08 · CORE-2530 rev 4**
> - The merge guard is now a read-only check, `xt identity merge-check`, repo-agnostic: the `gh pr merge` shim calls it, so it covers every repo and needs no stable branch. A repo with its own merge or promotion command may call the same check (market-data's `make promote-merge` is one optional example, owned by that repo). It allows a merge only when the latest `xtrm-reviewer[bot]` review is APPROVED and pinned to the PR's current head SHA, or is a COMMENT with a valid `decision` entry. A new push makes the review stale and the guard refuses. It also refuses on an active CHANGES_REQUESTED, no review, no resolvable Issue, or GitHub unreachable.
> - Why it is needed: the org is on the Free plan, so nothing refuses a merge, and `pr-review-gate` never requires a review to exist (a PR with no review passes it). The gate stays out of scope.
> - Reminder (CORE-2530 rev 5): every refusal says the review is missing or stale at head *sha12* and lists the ways to get one (the `reviewer` subagent in PR mode, `xt claude --role pr-reviewer`, or the specialist for a job verdict). A local hook, `xtrm-review-gate`, built as a policy and compiled to `hooks.json` (no GitHub Actions), reminds the agent after `gh pr create` and runs the check before `gh pr merge`.
> - Override for the operator and the coordinator role only: `XTRM_MERGE_GUARD_OVERRIDE=<reason>`. Each use writes a log line and a Journal decision entry. The App is a dependency: if it is down the guard blocks, and the override is the way out.
> - Stop condition: a throwaway PR approved at head H, a new push, and the guard refusing the merge. Origin: the market-data build coordinator (errors this week were all about who reviewed or which head).
> - The guard is client-side. An agent with the operator's gh login can still call the API; this stays documented. The release App remains deferred.

> **Ruling · 11-11 · design note**
> - The close gate reads rows, not prose: `created_from` plus its live artifact (T1), or the trailered commits merged into the default branch (T2), passes; a `mentioned`-only issue is refused with `gate_mentioned_only`; a link without its artifact fails as `gate_orphan_link`.
> - Manual close accepts T1 or T2 while the PR is still open (stage stays merged-pending). `sb links check` is a new top-level verb owned by step 33 and consumed here.

### Step 15b — A review is a step in the trail, not a new issue

(v4) [new] `pr-reviewer · Substrate provenance`

- **Brings** — A review pass becomes a receipt on the reviewed Issue, with an artifact of kind `review` (head SHA, verdict, GitHub review link) and a Journal finding. Follow-up work found in review is a new Issue with a `discovered_from` edge to the reviewed one. `sb provenance trace <ref>` then shows the whole trail: dispatch, receipts, PR, reviews, decision, merge.
- **Why here** — It needs the PR record (14) and the gates (15), and it must land before agents review each other at volume. MMD has 66 open issues named “pr-reviewer: …”, one per review pass; the Beads CLI had the same pattern.

> **Ruling on your note · 10-29**
> - No Substrate refactor: receipts, review artifacts, Journal entries and `discovered_from` (2,604 uses) all exist today. The pr-reviewer specialist and the coordinator skill change to write them.
> - The original design (`substrate_design_it.md`) has a `validates` edge: the verifier is a node in the implementation's chain, not a separate blocker. It was never built. Substrate stores blocks, relates_to, discovered_from, supersedes, duplicates and parent_child. Chains live in the specialists database (`epic_chain_membership`, `node_runs`), not in Substrate.
> - I don't add `validates` now. A review artifact on the reviewed Issue says the same thing. I revisit it only if the trail view needs an edge.
> - The 66 open review issues close as superseded, with their verdicts copied into review records (step 37 backfill).
> - The review process page (MMD-2934, 10-26) already returns PASS, PARTIAL or FAIL at an exact head. That verdict is what the review record stores. Step 15e decides which reviewer writes it.

### Step 15c — Service-knowledge: harden it, then install it everywhere

(v4) [new] `XTRM-631 · MMD-2437 · XTRM-641 · MMD-2788`

- **Brings** — Drift is measured by content hashes instead of modification times, and top-level files count. The post-merge hook design gets its critique (XTRM-641). After that, a full install, including the git hooks, is part of every `xt init`.
- **Why here** — A default that reports 364 drifted files in a fresh worktree when 81 really changed (XTRM-631) teaches agents to ignore it. Accuracy comes first, then reach.

Open evidence: **INFRA-620** 14 services and 53 files drifted, with three runtime claims that were false · **DARTHFEEDOR-579** lags main · **INFRA-288** 8 repos not installed · **MMD-2321** a standing human maintainer

> **Ruling on your note · 10-29**
> - Git hooks yes: they record drift after a merge or checkout. Per-edit Claude hooks no, as MMD-2788 already decides.
> - Reconcile stops depending on a person remembering: the drift marker feeds the work stage and the promotion rule (15d).

### Step 15d — Stable promotion updates service-knowledge

(v4) [new] `market-data first ·`

- **Brings** — `make promote` runs service-knowledge drift on the master→stable range and posts a comment on the promotion PR listing what changed. The heavy lane on the stable PR fails unless drift is cleared or carries a written waiver. A local pre-push hook is the backup.
- **Why here** — Your ruling for market-data needs a place that nobody can skip. `make promote` is already the only way to promote, and market-data's self-hosted runners make the heavy lane reliable.

> **Ruling on your note · 10-29**
> - Of your options: rule in the skill (no, memory), hook in the skill (no, only agents load it), CI (yes, heavy lane), local githook (yes, as backup), PR comment (yes, written by `make promote`).
> - The product-management skill (46) only names the rule. It does not enforce it.

> **Ruling on your note · 10-31**
> - Our repo setup (stable branch, promotion, `make` targets) becomes a product-management reference with a `make` template, offered, never required.
> - Service-knowledge reads the repo’s own configuration (default branch, release branch if any, sync trigger) instead of assuming `stable`.

> **Audit · 11-01**
> - A service-knowledge librarian reported 13 weaknesses after a `market-data` sync (MMD-3392). No Substrate Issue is filed yet. Two claims are checked in core’s copy of the code: #3 (`sync` always stamps `_git_head`, `drift_detector.py:78`) and #5 (`reconcile.py:421` takes the repo name from the directory). The others are the reporter’s observations, not rechecked.
> - **First, dispatch and counts.** #1 `drift_detector.py scan` took 134.5 s and timed out a dispatch. #2 the drift headline is meaningless: 22 services and 180 files after one commit pair; the truthful set is `git diff <last_sync_ref>..HEAD` intersected with territory globs.
> - **Second, stamping.** #3 `sync` cannot stamp the audited ref, which conflicts directly with this step: a stamp on `origin/stable` leaves the gate drifted. #4 the stamp and the umbrella table are separate writes, so the gate fails with an umbrella mismatch.
> - **Third, runtime.** #5 the umbrella renames the skill after a worktree directory; it needs an explicit repo name. #6 two markers with different ranges, and a worktree cannot clear the parent marker. #7 `cli_error` degrades silently to `tier=unknown`. #8 the index is per-checkout state, so “index rebuilt” cannot be checked by anyone else.
> - **Instructions.** #9 no tool emits or validates the per-service verdict schema. #10 write boundaries omit the umbrella `SKILL.md` and the index cache. #11 “`audited-and-unchanged` is gitnexus-only” cannot hold while real symbols are missing from the graph. #12 “do not append sections” conflicts with the per-sync sections in `release-flow`. #13 load limits are not in the doctrine.
> - Fix order follows the report: 1 and 2, then 3 and 4. It fits your note on this step, because the audited ref must come from the repo’s own configuration, not a hardcoded `stable`.

### Step 15e — One reviewer, chosen by evidence

(v4) [partly done] `MMD-2934 · SPECIALISTS-4386 · CORE-2528`

- **Brings** — The eight-step comparison from the review process page runs on at least three qualifying PRs: a frozen head SHA, one brief, three arms (the `reviewer` specialist, the `pr-reviewer` specialist, the Claude `reviewer` subagent), and a blind arbiter scoring the findings. The winner becomes the one reviewer definition, with two modes: job review (verdict to the coordinator) and PR review (verdict on GitHub). It posts as `xtrm-reviewer[bot]`, and its verdict is stored as the review record of step 15b.
- **Why here** — Three definitions share one checklist family and drift apart. Two of them post under the same GitHub account, told apart only by the first line of the comment. No live run has proven the OCR preflight yet. The gates (15) and the review trail (15b) need one reviewer whose verdict can be trusted.

From the review process page: OCR preflight (`ocr delegate preview`, `rule`) stays mandatory and the LLM OCR commands stay banned · **SPECIALISTS-4386** the seconder runs no OCR · **MMD-2938** quality baseline · market-data `rule.json` (PR #1092) is the first repo rule set

> **Ruling on your note · 10-29**
> - The verdict maps to the GitHub review type as the identities page proposes: PASS is APPROVE, PARTIAL is COMMENT, FAIL is REQUEST_CHANGES. The merge guard reads the record, not the comment text.
> - Provider risk: two of three providers are unusable today (opencode-go returns 429; openai-codex needs an interactive re-login), and one quota limit stops every reviewer at once. The comparison also records which provider each arm used, and the chosen reviewer gets a second provider as fallback.
> - A live MCP server keeps the old model configuration until it is reloaded. That is XT-157, fixed in step 21; until then every definition change ends with a reload.

> **Ruling · 11-08 · CORE-2528 rev 3**
> - Reviews are posted through one path with no new agent command: the `gh` shim posts a formal review through the REST create-review call with `commit_id` set to the reviewed head, because `gh pr review` has no commit flag. It refuses if the head moved, and it refuses a review by the holder who opened the PR.
> - The Claude `reviewer` subagent in PR mode (today `gh pr comment`, "never run gh pr review") and `xt claude --role pr-reviewer` both move to this path.
> - Ruling (11-08, you): the `pr-reviewer` specialist stays valid, but is not advised for critical reviews at the moment. That is temporary and is lifted if Claude Code becomes a specialists backend. The routing must be universal, or a repo convention, or your instruction in the chat; precedence in that order, chat first. So all arms stay in the comparison, and the default routes by SCRUTINY tier: HIGH or critical goes to a Claude-backed reviewer (subagent or `xt claude --role pr-reviewer`), lower tiers may use the specialist. The merge guard never checks which kind of reviewer ran.

> **State · 11-11 · Claude route for specialists**
> - Proven live 11-09 (SPECIALISTS-4405): a specialist ran on `claude-bridge/claude-sonnet-5-5` with Pi’s own tools, so the permission guard and READ_ONLY still bind. The route needs both the definition flag and `claude_bridge.enabled` in your `user.json`; your switch is on.
> - Merged 11-11, each reviewed at its exact head: specialists #529 (a bridged model with the route off is refused instead of silently falling back to another provider), #528 (bridge found in Pi’s package store, no env variable; relative paths ignored), #530 (dist refresh, byte-identical rebuilds). Next: a small test follow-up, docs, release, installs; core #893 adds the bridge to the installer (pinned 0.12.0).
> - Coordination: lane B (this route, installs, the 15e test) is run by `core-xt-claude-1rmj`; lane A (identities, merge guard) by `core-85`.
> - Once merged, the 15e arm “pr-reviewer specialist on the Claude route” can be tested on Pi and as a specialist, against the Claude subagent.

### Step 16 — Instructions generated from the CLI

(v3) [new] `using-xtrm · primer · mandatory rules · XT-162`

- **Brings** — One Substrate reference built from `sb help --json` and the duty map. It feeds using-xtrm, the session primer, the managed blocks, and a new specialists mandatory rule that every writer role loads. The 74 leftover Beads mentions go. A CI check fails when an instruction names a verb that does not exist, or a duty has no description.
- **Why here** — It comes after the gates (15), so the text describes gates that exist, and before the release (18), so every machine gets it.

Folded in: **XT-162** one complete specialists skill per runtime

> **Ruling on your note · 10-29**
> - A check must never depend on a runner being available. Every required check gets one local command, in the `make ci-light` style.
> - Jobs do not cancel each other. A cheap check such as instruction drift fails alone, and the heavy jobs still run.
> - When runners are unavailable, the merge guard accepts a local run record (command, commit SHA, exit code, host) stored in Substrate as a validation artifact. It is written down and never silent.
> - This is a per-repo setting: local run record or hard block. For users other than you, the default is to block.

### Step 16b — One testing canon that reaches every judging role

[done] (v4) [done] `MMD-2999 · MMD-2331 · “Regole dei test”`

- **Brings** — The ten prepared patches in `~/.cache/MMD-test-canon/proposed/` on the server, none applied yet. The canon lives once, in `engineering-quality/references/testing.md` (01, 04). Planning points to it instead of keeping its own level table (02). Every VALIDATION check names its command, expected result, setup and cleanup, and what a failure would mean (03). The seconder may judge the value of changed tests and gets a `test-value` finding (05). The reviewer gates judge test value, not only test theatre (06). The test-engineer and the executor get the keep / fix / delete rule, and the executor's contradiction about running tests is fixed (07, 08). market-data's OCR rule and AGENTS.md point at the canon (09, 10).
- **Why here** — It is the instruction gap of step 16, measured for tests: across 796 jobs in 6 roles, 0 say what a failure would mean, and only reviewer (18 of 186) and pr-reviewer (7 of 80) ever name test theatre. It lands next to step 16 so the same drift check covers it, and before the release (18) so every machine gets it.

> **Ruling · 10-29**
> - Not yet as written. The standalone `test-planning` skill (542 lines, removed in the 09-04 refactor, core `4c82c4be`) held much more than today's 58 lines plus patch 01: three triggers (contract authoring, in-chain after the writer, a drift check at closure), layer signals, strategy by situation, the live → recorded fixture → mock ladder, the smoke command contract, the telemetry field list, done-when templates per layer, critical-path and deferred-path maps, test priority rules, three more anti-patterns (no assertion, shared mutable state, cannot fail under a realistic regression) and a who-enforces-what table.
> - Draft v2, translated from Beads to Substrate: `~/.cache/MMD-test-canon/proposed-v2/` on the server. It adds `engineering-quality/references/test-planning.md` (the procedure; `testing.md` stays the rules) and changes 01, 02, 04, 05, 06 and 07 to point at it. 03, 08, 09 and 10 are unchanged. The old evals are kept to test it.
> - Then approve, in order: 01 + the new reference, 04, 02, 03; then 05, 07, 08; then 06; then 09 and 10 as a normal market-data PR. Editing now is fine: it is text, and it does not wait for the parity sync.
> - 06 edits three copies of the reviewer gate. Apply it to all three now, because it is small; step 15e then keeps one reviewer, so the copies stop drifting.
> - 05 changes the seconder's JSON output (a new enum value). Before it merges, the readers of that enum are listed and checked.
> - Make it mechanical: the step 16 drift check also fails when a judging role (reviewer, pr-reviewer, seconder, test-engineer, executor) does not load the canon, or when a second copy of the level table appears.
> - A change counts as proven only when a later run shows it in use, as the page says: an OCR preflight digest, a job output using the new field, a new audit with the rubric.
> - No “25% useless tests” figure: the repo audit measured 1.1% (26 of 2,444). Any new number comes from a re-measurement with the rubric.
> - G0 on the page is an install problem: the runtime checkout under `~/.local/share/xtrm/runtime-checkouts/` still holds reviewer 2.1.0 and seconder 1.1.0, while the source has 2.6.0 and 1.5.0. Step 10 makes the update verify installed versions, so audits and runs read what is current.

> **Applied · 10-29**
> - Live on the server: the skill files in `~/.xtrm/skills/default` (testing.md, new planning-tests.md, SKILL.md route, planning pointer, VALIDATION template), and the Claude reviewer and executor subagents.
> - The pointer agents cannot skip: a `test-canon` mandatory rule set, appended to the prompt of seconder, reviewer, pr-reviewer, test-engineer and executor at spawn. It carries the rules inline, names both files by path, and requires a closing line `Test canon: read … · applied …` or `Test canon: NOT READ (reason)`. That line is the evidence the canon reached the role.
> - Merged with admin: xtrm-dev/specialists#513, xtrm-dev/core#852, mercuryintelligence/market-data#1139. `~/.xtrm` pushed. Live check: all five roles resolve to the package definitions with `test-canon` and every skill path present.
> - Found on the way: seven repos tracked May snapshots of reviewer and executor that named retired skills, so those roles could not dispatch there. Pruned and merged in economic-data, market-archive, quant, sierra-vps, terminal, website and transcriptoz; darth-feedor's stale reviewer overlay moved aside.

### Step 17 — One install story in docs; doctor checks

[draft] `CORE-2383 · CORE-2384 · XT-126`

- **Brings** — Docs, skills and help describe the same two commands, expired aliases go, and `sp doctor` warns about a second specialists MCP server.
- **Why here** — Written after steps 9–16, so it describes what exists.

Folded in: **XT-160** doctor warns on a second MCP server

### Step 18 — Clean-PATH end-to-end test, then publish

[you] `CORE-2382 · CORE-2377 · XT-128`

- **Brings** — A CI sandbox installs from scratch and ends with `xt doctor` exit 0. After your approval, core, specialists, substrate and pi-extensions are published, and later releases publish on merge.
- **Why here** — The release must contain everything above, and it carries the topology feed for phase 5.

Folded in: **XT-26** auto-publish pi-extensions on merge

## Phase 3 · XT-184 — Every session owns its resources

Goal: a session, its processes, worktree, claim and PR live and die together. Nothing is reaped by age or by text matching.

### Step 19 — Sessions keep their identity on resume

[done] [done] `CORE-2536 · core#845 · XT-190`

- **Brings** — `xt attach` restores `SUBSTRATE_HOLDER`. 26% of Journal entries had no participant before.
- **Why here** — Already merged. Ownership needs an owner name.

### Step 19b — The environment contract, tested

[done] (v4) [new] `CORE-2390 · CORE-2536`

- **Brings** — One contract lists each variable, who sets it, who reads it and how long it lives: `SUBSTRATE_HOLDER`, `SUBSTRATE_ISSUE_REF`, `SUBSTRATE_PROJECT`, `XTRM_DISPATCHER_NAME` and `XTRM_DISPATCHER_ADDRESS` (who dispatched me), `XTRM_PARENT_PANE_ID` and `XTRM_PARENT_SESSION_ID`, and `XTRM_JIRA_AS`. One test launches `xt claude`, `xt pi`, `sp run` and an `xt attach` resume, and checks the variables inside each.
- **Why here** — Ownership, the roster and the app all read these names. A variable that is set in one launcher and missing in another breaks them silently.

> **Ruling on your note · 10-29**
> - “Who dispatched me” exists: `xt` sets `XTRM_DISPATCHER_NAME` and `XTRM_DISPATCHER_ADDRESS` from the nearest ancestor Claude or Pi session (CORE-2390). The test checks that specialists runs carry them too; I have not verified that yet.
> - The roster (28b) and the app's Sessions navigator show “dispatched by” from these variables.
> - Monorepo migration: deferred by your ruling. It is listed under “Not in this plan”.

### Step 20 — Agent commits carry an agent author

[partly done] [draft] `CORE-2525 · XT-190`

- **Brings** — Per-agent git author and committer, plus an `Agent:` trailer, from xt and the specialists supervisor.
- **Why here** — The reconciler and the lifecycle read who made a branch.

> **Ruling on your note · 10-29**
> - Confirmed.

> **Ruling · 10-30 · CORE-2524 rev 9**
> - Two GitHub Apps now: `xtrm-reviewer[bot]` and `xtrm-builder[bot]`. None exists yet; the runbook is CORE-2527. Release App deferred (see step 14).
> - One App per role, not per agent: the agent name travels as the git author, the `Agent:` trailer and the comment marker. The service-knowledge updater is the service-skills-sync specialist, so it is a builder, not a fourth App.
> - Role source: a plain `xt` session is builder; `--role` and specialists read one map under `~/.xtrm/config` (never the specialist JSON); reviewer and merge tokens belong to the action. No `--identity` flag.
> - Jira side is done: CORE-2526 and CORE-2540 (agent account `xtrm-bot`).
> - Unused third-party Apps (`grok-by-xai` and `claude` with org administration, `chatgpt-codex-connector`) are still installed: uninstall if unused.

> **Ruling · 11-02 · CORE-2524 rev 10**
> - Three GitHub Apps now: `xtrm-reviewer`, `xtrm-coord` (new) and `xtrm-worker` (renamed from `xtrm-builder`). This replaces the two-App ruling of 10-30.
> - `xtrm-coord` lets a person tag a coordinator on a PR with a question such as “why not merged”, and routes it. It comments only: no contents write, no merge.
> - Every App post carries the run header: agent name, run id, and specialist activation id when present.
> - Order: XTRM-685, then the runbook CORE-2527 (rev 2), then you create the Apps. The runbook must establish how a mention reaches XTRM with Actions locked and no public webhook endpoint.

> **Done · 11-02**
> - Runbook merged: `docs/github-apps-operator-runbook.md` in core (#870, CORE-2527). The three App names are not taken on GitHub as of 11-02. You can create the Apps now; nothing uses them until token minting (Phases 3 and 4).
> - Apps are registered as **Any account**, because a private App cannot cover the three accounts. Anyone with the link can install one, so tokens are minted only for recorded installation ids.
> - `xtrm-coord` mentions: polling first (next check, no new public surface). A webhook behind Traefik on the server is possible and near-instant, but needs your ruling. A correction: the server does have public ingress.
> - Still unverified: whether an App approval counts toward required reviews; the runbook carries the live test.

> **State · 11-08**
> - None of the three Apps exists: `api.github.com/apps/xtrm-reviewer`, `xtrm-coord` and `xtrm-worker` return 404. You create them from the runbook; `xtrm-reviewer` first, because the reviewer path and the merge-guard test need it.
> - Contracts revised to match rev 10, all draft and structurally valid, not yet attested: CORE-2525 (git author and trailer), CORE-2528 (tokens, shim, formal reviews), CORE-2529 (worker App and push guard), CORE-2530 (merge guard), CORE-2531 (audit). Attestation waits for your go and the first App.

> **State · 11-11**
> - Merged in core, each reviewed at its exact head: #881 agent git author (CORE-2525); #882 App tokens, `gh` shim, reviews pinned to the head, merge guard (CORE-2528); #883 `xtrm-review-gate` hook (CORE-2530); #884 guard follow-ups; #885 the launcher exports the role App identity only where that App is installed.
> - `xtrm-reviewer` exists (App 5669067) and is installed on Jaggerxtrm, mercuryintelligence and xtrm-dev. `xtrm-coord` and `xtrm-worker` are not created; until they are, workers and coordinators keep your identity.
> - Live run found real defects. The first review on core #888 posted **as you** (`Jaggerxtrm`, plain comment) because the reviewer’s tmux pane did not get the shim on its PATH. #891 fixed that and merged (4de65af8) on the first real bot review: APPROVED by `xtrm-reviewer[bot]` pinned to the head. It carries the run marker (agent, run, Issue). Gap: its Journal receipt failed (`sb` exited 1), so CORE-2524 has no receipt for it; fix due in #887.
> - Server side: `main` on core requires linear history only, no review and no check. The guard is the only review gate.
> - Open core PRs, in merge order: #887 guard C1, #888 live-run fixes, #890 guard checks the Issue really exists, #889 guard on by default (last).
> - Limit that stays: the guard is client-side. A pane that bypasses the shim can still act with your `gh` login.

> **Decisions · 11-11**
> - Settled: you asked for the guard to be set automatically, so #889 (on by default for launched agents, `XTRM_MERGE_GUARD=off` opts out) replaces the 11-08 off-by-default ruling. It merges last. Your own shell still has it unset, so merges you run are not checked unless you set it.
> - Remove your `gh` login from agent panes, so a pane that bypasses the shim fails instead of posting as you. Recommendation: yes, once `xtrm-worker` exists, since workers push and open PRs with your login today.
> - Server-side enforcement: core is public, so a required approving review on `main` is possible and would make the rule unbypassable. Whether an App approval counts toward it is still the open live test.

### Step 21 — Reliable claims and activations

[draft] `SPECIALISTS-4358 · 4359`

- **Brings** — Claim then bind, claim renewal, fail closed on loss. Preflight runs before the claim. A coordinator restart no longer orphans activations. Dispatch reloads changed definitions, and a late wake does not replace the settled result.
- **Why here** — XT-184 orders this before any PR flow, and Jira status follows these claims.

Folded in: **XT-161** claims before preflight · **XT-159** restart orphans activations · **XT-157** cached definition · **XT-158** first settle kept

> **Ruling on your note · 10-29**
> - XT-157 (an edited definition is ignored until restart) also explains why a live MCP server reviews with the old models until it is reloaded (review process page).

> **Found · 10-31**
> - The `sp` CLI is deprecated: dispatch goes through the Claude Code plugin and the Pi extension. Its `sp run --issue-ref` still creates worktrees with the retired `bd` (only `src/cli/run.ts` and the legacy node supervisor do; the native activation path does not). SPECIALISTS-4392 closed as won’t fix. Skills and agent guides that still say `sp run` or `sp list` (this repo’s CLAUDE.md among them) should point at the plugin and extension tools: step 16.

> **Finding · 11-02**
> - `in_progress` exists, but only as a view of a live claim. Claims default to 15 minutes, and no CLI, Pi or MCP path renews them, so a working session can drop back to READY. XTRM-685 did this live, and the board then showed nothing in progress.
> - Consequences: the board under-reports active work, and a second worker can claim an Issue that is still being worked.
> - Proposed: keep it derived (a stored status would drift). The session host renews claims while a session lives, and the board shows a lapsed claim on an Issue with recent activity. Interim: claim with a long `--ttl-ms`.

### Step 22 — The host does the bookkeeping

(v3) [new] `specialists native host · xt · substrate plugin`

- **Brings** — Every dispatch writes a binding (today 38%). Every settle writes a checkpoint, finalizes the receipt (today 1%) and records the commit SHA. The commit hook adds the `XTRM-Issue` and `XTRM-Receipt` trailers. The stop hook checkpoints every claimed session, not only bound ones. An executor's final report is checked against the real diff.
- **Why here** — A receipt belongs to a claim, so this follows the claim fixes (21). The reconciler (26) then finds a receipt to attach each PR to.

Folded in: **XT-6** executor report reconciled against the diff

> **Ruling on your question · 10-29**
> - The commit side of this step is two git hooks, not a Claude hook: `prepare-commit-msg` adds `XTRM-Receipt` when the session has a live receipt (6b already adds the Issue), and `post-commit` records the new SHA in that receipt. Both are local writes.

> **Status · 10-30 · XTRM-668 sb-improve**
> - The Substrate plugin and Pi extension redesign is under way as XTRM-668: equal behaviour on the sb CLI, the Claude plugin and the Pi extension; Claude hook outputs that were dropped; nudges for Pi; better resume capsule and errors; smaller MCP tool text. Branch `xt/sb-improve`, 4 commits ahead.
> - Overlap to settle: its “worktree identity” commit and core CORE-2536 both derive the holder. One derivation wins; CORE-2524 consumes it (Journal notes on both Issues).
> - This step builds on it rather than duplicating it.

### Step 22b — Specialist sessions are saved, named and resumable

(v4) [new] `specialists · Pi sessions`

- **Brings** — Pi saves a session file for every activation, named the way the xt launcher names sessions (role, Issue, slug). A killed run gets its own status, `killed`, with a reason (memory, operator stop, timeout, host restart, scope exit) and the exact resume command. Resume restarts Pi on the same session file, with the same claim if it is still live, like `xt attach`. The fleet pane, the Pi footer and xtmux show it as loudly as any other event.
- **Why here** — It needs the claim fixes (21) and the host bookkeeping (22). The resource budgets (23b) can then kill a run without losing it.

> **Ruling on your note · 10-29**
> - Verified: specialists start Pi with `--no-session` (`src/pi/session.ts`), so no session file exists and a killed run cannot be resumed.
> - Your question about duplication: partly yes. `observability.db` stores the event stream (text, tool calls) that a Pi session file would also hold. Its jobs, status and metrics tables have no Pi equivalent.
> - So the database keeps jobs, status, metrics and a pointer to the session file, and stops storing full event payloads. Old payloads get a retention limit. The files are large today: 2.8 GB in the specialists repo, 1.5 GB in console, 1.2 GB in core.

### Step 22c — Take a role inside a running session

(v5) [new] `SPECIALISTS-4389`

- **Brings** — `sp role <name>` prints the specialist prompt, its mandatory rules (the same text a spawn appends) and a “Read these first” list of absolute skill, reference and script paths. `/role` in the Claude plugin and Pi wraps it; adoption leaves a Journal note on the claimed Issue. Review roles are refused: spawn them, because a reviewer is worth its separate context.
- **Why here** — It reuses the resolver that 22b and the parity work fix. An adopted role is guidance only: model, tools and identity stay what the session started with.

> **Follow-ups · 10-30**
> - Name as role: `xt claude reviewer` or `xt claude test-engineer-2` applies that role and prints one line, `--no-role` to skip. No current session name collides with a specialist name.
> - Tab completion of specialist names for `xt claude|pi|codex`.
> - A session that grows into coordinating can take `coordinator` (22d) this way.

### Step 22d — A coordinator role that picks its scale

(v5) [new] `SPECIALISTS-4390 · 4391`

- **Brings** — A top-level `coordinator` specialist you talk to: never implements product code, Substrate owns the record, dispatches through multiplexing or specialists, verifies worker claims. Its first step picks a scale reference unless you name one, and its first line says so: `Coordinating as: epic (planning + multiplexing)`. `chain-coordinator` stays the subordinate for one Issue chain. The legacy `node-coordinator` is retired after a usage check (4391).
- **Why here** — It needs 22c to be taken mid-session and 46 for the programme reference. It has no GitHub identity of its own: a builder session, merges stay with you.

| You ask for | Reference |
| --- | --- |
| One Issue through a specialist chain | using-specialists chain recipes (may spawn chain-coordinator) |
| An epic: a few Issues, a few peers | planning + multiplexing |
| A multi-week programme, Jira view | programme-coordination → product-management (46) |
| A PR queue or release window | review/merge reference + mercury-release |

### Step 23 — Each session in a limited systemd scope

[new] `XT-184 items 1–2`

- **Brings** — MemoryHigh, TasksMax and CPUWeight per session, tagged with session and Issue; MemoryMax only after measurement; a cap on live agents and parallel chains; `XT_NO_SCOPE=1` opts out.
- **Why here** — The 10-22 incident can repeat any day. MemoryHigh slows a session down and never kills it, so it is safe first.

Folded in: **XT-173** live-agent process cap

### Step 23b — Resource budgets for everything that runs

(v4) [new] `XT-184 · systemd`

- **Brings** — Each scope reports memory and CPU to the registry, and the process panel shows it. Specialist runs, their extensions and their MCP servers share one slice with a total memory limit and a lower CPU weight. systemd-oomd watches that slice and, under pressure, stops the worst specialist run instead of letting the kernel kill the tmux server. Node processes get a heap cap per role through `NODE_OPTIONS`; Bun processes run with `--smol`, which collects garbage more often. A session idle beyond a limit with no claim saves a checkpoint and exits; `xt attach` resumes it.
- **Why here** — It needs scopes (23). It comes before the registry (24) so the registry carries measured numbers from the start, and after 22b so a stopped specialist run can be resumed.

> **Ruling on your note · 10-29**
> - Measure first: the first week only samples and reports. Limits are set from those numbers, never guessed.
> - The session losses that `session-recovery` exists for were OOM kills. oomd on the specialists slice targets exactly that.

### Step 24 — Owned-resource registry and scope kill on exit

[new] `XT-184 items 3–4`

- **Brings** — One inventory of what each session owns: scope, MCP chains, worktree, branch, PR, claim, scratch dir. A session's exit ends its scope. The reaper reads only the inventory, never `pgrep -f`, and starts in dry run.
- **Why here** — It needs scopes (23). The lifecycle (27) and the graph (44) read it.

Folded in: **XT-10** abandoned worktrees · **XT-174** per-activation scratch

### Step 25 — Lighter MCP chains; memory in xt status

[new] `XT-184 items 5–6`

- **Brings** — GitNexus MCP as one direct process instead of three; per-session RSS and tasks in `xt status`.
- **Why here** — Immediate load relief, and you can see step 23 working.

### Step 26 — The GitHub reconciler

(v2) [new] `XT-178 amendment · XT-184 · XTRM-728`

- **Brings** — One poller in the agent host, using conditional requests a few minutes apart. It is the only writer of PR state into Substrate (review, merged with SHA, closed). It also repairs a PR the host missed when its title, branch or trailer names a ref.
- **Why here** — One event source serves three consumers: the lifecycle (27), the Jira status map (34) and the app. Built once, it adds no load per consumer.

> **Ruling on your question · 10-29**
> - The reconciler links a PR to an Issue from evidence, in this order: the PR record the host wrote when it opened the PR; the `XTRM-Issue` trailers in the PR's commits; the Substrate ref in the branch name or title. Each link stores which evidence made it.
> - Trailers are the evidence that survives every way of landing code. A rebase merge rewrites SHAs but keeps messages. A squash merge on core, specialists and market-data keeps them too: those repos build the squash message from the commit messages (`COMMIT_MESSAGES`). A cherry-pick keeps the message.
> - A commit record keeps both SHAs: the one the agent made and the one that landed on the default branch (squash or rebase), so `sb provenance commit` finds either.
> - A merged PR with no evidence at all is listed by `sb links check`. The merge guard (15) refuses such a PR in the first place.

> **Ruling · 11-11 · design note**
> - The reconciler is trailer-first. A trailer receipt must belong to the issue being linked; a foreign one gives `mentioned` plus a check finding. Title and branch references only ever give `mentioned`. Each row keeps its source. Live PR state lives in a separate `pull_requests` table.

### Step 27 — PR merged closes the Issue and reaps the worktree

[new] `XT-184 lifecycle · XT-172 · XT-148 · XTRM-729`

- **Brings** — The host pushes a writer's branch and opens one PR into the coordinator branch, recorded at once (14). On merge, the reconciler closes the Issue citing the PR record, stops the activation, and removes worktree and branch. Today 47 merged worktrees are never reaped.
- **Why here** — It needs claims (21), the inventory (24), authors (20) and merge events (26).

Folded in: **XT-172** executor worktree and PR integration · **XT-148** parallel writers

> **Ruling on your question · 10-29**
> - Your case, a different PR lands the work: the trail is rebuilt from the commits, not from who opened the PR. The merged PR is linked to the Issue by its commits' trailers, the Issue moves to merged, and the original activation's receipt points at that PR.
> - Merged into the default branch is what counts. A writer PR merged into the coordinator branch is integration, not done. When the coordinator PR reaches main, each Issue whose trailered commits it contains gets its merged evidence. One PR can close several Issues.
> - Automatic close needs all of: a merged PR linked to the Issue, no other open PR linked to it, no live claim still working on it, and no deploy or production window in the contract. If any is missing, the Issue stays in merged and the coordinator's queue shows why.
> - Stopping and reaping apply only to the activation and worktree that own the branch, from the registry (24). If the work landed through another PR, the owning activation gets a message naming it. Its worktree is removed only when every commit on its branch is already in the default branch (patch-id check) and nothing is uncommitted; otherwise it is kept and flagged.
> - A revert of a trailered commit on main creates a reopen proposal for the coordinator. It never reopens the Issue by itself.
> - Today none of this happens: Substrate has no PR records, and only 9 of 746 receipts carry a commit SHA. Steps 14, 22 and 26 create the evidence; this step only reads it.

> **Ruling · 11-11 · design note**
> - Auto-close needs T1 or T2, merged into the default branch, no other open PR linked, no live claim and no deploy window. A writer PR into a coordinator branch is integration, not delivery. Unreachable GitHub fails closed; an override is a Journal decision.

### Step 28 — Launcher options and the process panel

[new] `XT-184 operator proposals`

- **Brings** — `xt --main` in the current folder (also outside git), a "HEAD is behind origin" warning, a full pre-launch summary, a `--window` fallback outside tmux, a launchable coordinator role, and a light `/processes` command that lists and kills the processes under the pane.
- **Why here** — The panel reads the registry (24).

Folded in: **XT-166** window fallback, resume by attach · **XT-165** coordinator role via --role

### Step 28b — A richer picker and a roster sidebar

(v4) [new] `xtmux · XT-129`

- **Brings** — The xtmux picker for Pi and Claude shows the Issue, work stage, dispatcher, memory and last event. A tmux key opens a narrow read-only roster pane beside the current one. It refreshes on events instead of redrawing previews, so it stays light next to the full PREFIX+b picker.
- **Why here** — The precise statuses come from the registry (24) and the stages (30), and the dispatcher from 19b.

> **Ruling on your note · 10-29**
> - One renderer serves the sidebar, the picker and later the app's Sessions navigator (41).

## Phase 4 · XT-178 — Jira, GitHub and Substrate bound both ways

Goal, from ruling D12: Jira tickets are the human-readable ADRs and Substrate holds the work. Version 2 adds GitHub as the third side. Each fact gets one owner; Substrate does not get slimmer.

<!-- figure: Field ownership between Jira and Substrate with events driving Jira status -->
<figure class="fig small" style="margin:0">
    <svg viewBox="0 0 760 300" role="img" aria-label="Field ownership between Jira and Substrate with events driving Jira status">
      <defs><marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#a8581c"/></marker>
      <marker id="ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#2a62c9"/></marker></defs>
      <g font-family="Public Sans, sans-serif">
        <rect x="10" y="20" width="250" height="260" rx="12" fill="#eaf0fb" stroke="#2a62c9"/>
        <text x="26" y="48" font-size="17" font-weight="700" fill="#1c2321">Jira · for people</text>
        <text x="26" y="68" font-size="11" fill="#2a62c9" font-family="JetBrains Mono, monospace">mercuryintel · XT, ISSUE</text>
        <g font-size="13" fill="#1c2321">
          <text x="26" y="100">Epic brief, written as an ADR</text>
          <text x="26" y="124">Stories and sprints</text>
          <text x="26" y="148">Assignee and priority</text>
          <text x="26" y="172">Portfolio status</text>
          <text x="26" y="196">Dev panel: branches, PRs</text>
          <text x="26" y="220">Comments: results, reports</text>
        </g>
        <text x="26" y="258" font-size="11" fill="#5b6661">label substrate:&lt;ref&gt; + remote link</text>
        <rect x="500" y="20" width="250" height="260" rx="12" fill="#f8ede3" stroke="#a8581c"/>
        <text x="516" y="48" font-size="17" font-weight="700" fill="#1c2321">Substrate · for agents</text>
        <text x="516" y="68" font-size="11" fill="#a8581c" font-family="JetBrains Mono, monospace">state.db on the server</text>
        <g font-size="13" fill="#1c2321">
          <text x="516" y="100">Seven-field contract</text>
          <text x="516" y="124">Readiness and attestation</text>
          <text x="516" y="148">Claims and leases</text>
          <text x="516" y="172">Journal, resume capsule</text>
          <text x="516" y="196">PR and commit records</text>
          <text x="516" y="220">Leaf tasks, never mirrored</text>
        </g>
        <text x="516" y="258" font-size="11" fill="#5b6661">Jira binding: key + URL</text>
        <g font-size="11" fill="#a8581c" text-anchor="middle">
          <text x="380" y="34" font-weight="600">events drive Jira status</text>
          <text x="380" y="50">claim → In corso</text>
          <text x="380" y="64">PR open → In Review</text>
          <text x="380" y="78">merged → Completata</text>
        </g>
        <path d="M496 94 C 430 86, 330 86, 264 94" stroke="#a8581c" stroke-width="1.6" fill="none" marker-end="url(#ar2)"/>
        <rect x="280" y="108" width="200" height="98" rx="10" fill="#ffffff" stroke="#5b6661" stroke-dasharray="4 3"/>
        <text x="380" y="132" font-size="13" font-weight="600" fill="#1c2321" text-anchor="middle">Binding</text>
        <g font-size="11" fill="#5b6661" text-anchor="middle">
          <text x="380" y="152" font-family="JetBrains Mono, monospace">sb jira bind</text>
          <text x="380" y="168" font-family="JetBrains Mono, monospace">sb links check</text>
          <text x="380" y="186">lists broken pairs</text>
        </g>
        <path d="M264 220 C 330 228, 430 228, 496 220" stroke="#2a62c9" stroke-width="1.6" fill="none" marker-end="url(#ar3)"/>
        <g font-size="11" fill="#2a62c9" text-anchor="middle">
          <text x="380" y="246">a brief edit in Jira raises</text>
          <text x="380" y="260">a drift proposal; the contract</text>
          <text x="380" y="274">is never rewritten</text>
        </g>
      </g>
    </svg>
    <figcaption>One owner per field. Status lives in Jira but moves only on Substrate events. Leaf tasks stay in Substrate.</figcaption>
  </figure>

### Step 29 — Answer the three remaining decisions

[you] `XT-110 §1 · prompt 4`

- **Brings** — Your answers on the primary ID (Jira key for epics and Stories, Substrate ref for leaves), brief authority (Jira only), and the Deferred category in XT. Two earlier questions are settled: GitHub for Jira is installed, and XTRM-versus-ISSUE was replaced by the move to XT.
- **Why here** — XT-178 depends on them. I prepare a one-page list with a recommendation for each.

### Step 30 — Work stage model

(v3) [new] `XT-178 · packages/substrate`

- **Brings** — Substrate derives the stage of each Issue (draft, ready, in progress, in review, merged, done, plus blocked and stalled) from attestation, claims, edges and PR records. Each change writes an `issue.stage_changed` event. `sb issue show`, the board and `sb issue ready` show it.
- **Why here** — It comes after the decisions (29) and before the Jira setup (31), so the Jira statuses copy the stages. The status map (34) then has one event to follow.

### Step 31 — Configure the XT project in Jira

[you] `XT-110 phase 1`

- **Brings** — Renamed transitions; In Review, waiting-production, Blocked and Won't Do statuses that match the work stages; Substrate ref and Readiness fields, label namespaces, workflow and labels exported first. The GitHub for Jira connection is checked per repo.
- **Why here** — The status map (34) needs these statuses. Only an admin in the Jira UI can change team-managed workflows; about one hour.

> **Ruling on your note · 10-29**
> - The setup steps also go into the product-management skill as a reference (step 46), so another user can map a different board.

### Step 32 — Plan XTRM-639's children with full contracts

[draft] `XTRM-639`

- **Brings** — One child per step 33–37, each passing `sb issue validate`, with no added host memory or CPU.
- **Why here** — Contracts follow the decisions in step 29.

### Step 33 — sb jira bind and sb links check

(v2) [new] `XT-178 scope 1–2 · XT-179 · XT-169`

- **Brings** — One command binds a Jira item and an Issue: the label, the remote link, and a binding row in Substrate. `sb links check` lists closed Issues without a record, merged PRs on open Issues, open PRs on closed Issues, stale Jira statuses and unbound items. A reparent verb fixes misplaced Issues.
- **Why here** — The coordinator stops typing keys by hand, and drift becomes visible. The check needs the bulk edges read path.

Folded in: **XT-179** bulk edges read path · **XT-169** reparent verb

### Step 34 — Jira sender and status map

[new] `XT-178 scope 3 · XT-110 phase 3`

- **Brings** — A Jira sender on the existing outbox. Each `issue.stage_changed` event fires the matching transition as xtrm-bot. Closures and receipts post as comments, each citing the PR link from Substrate.
- **Why here** — It needs bindings (33), statuses (31), claims (21) and reconciler events (26).

### Step 35 — Test Teamwork Graph CLI as the read path

[draft] `XT-168`

- **Brings** — A read-only trial against `jira.py` and `gh`, with a pinned installer, quarantined skills and no admin login. TWG also reads the dev panel, so it is a candidate for cross-checking links.
- **Why here** — It decides whether the inbox (36) reads through TWG or plain JQL.

### Step 36 — Read changes back from Jira

[new] `XT-110 phase 3`

- **Brings** — A JQL cursor poll feeds intake events; a brief edit raises a drift proposal; `sb jira pull KEY` maps a brief into the seven fields.
- **Why here** — Sending works alone; receiving with drift handling is the riskier half.

### Step 37 — Backfill the links that exist only as text

(v2) [you] `XT-178 amendment`

- **Brings** — A dry-run parser turns the 2,468 PR mentions in close reasons into proposed PR records, and the Substrate refs listed in Jira theme tickets into proposed bindings. You approve; rows are marked `source=backfill`.
- **Why here** — After bind (33) and check (33) exist, so backfilled links are checked like new ones.

### Step 38 — Clean the boards with the new rules

[you] `XT-110 phase 2 · jira-cleanup`

- **Brings** — Parents for every non-epic, labels mapped, Relates links for follow-ups, the XTRM archive finished. The old backlog XT-1 to XT-83 is triaged: close, fold or keep. You approve each change.
- **Why here** — Clean once, into a shape the sync keeps.

## Phase 5 · XT-110 + XT-104 — xtrm-app: one place to work

Goal, from XT-104: "I want to stay here, not in the terminal, not another harness."

### Step 39 — Choose the design direction

[you] `XTRM-628 · ADR-001 · XT-104`

- **Brings** — Your pick among focus canvas, cockpit, or fleet and focus, after the component study and a Claude design pass.
- **Why here** — ADR-001 requires design first. It needs only your time, so it can run during phases 3 and 4.

### Step 40 — Agent host Jira client and the J / S / S·J model

[new] `XT-110 slice 1`

- **Brings** — One client in the agent host, shared with Substrate, with the token kept on the host. Items are Jira-only, Substrate-only or linked, each with its PRs.
- **Why here** — It reuses the sender (34). Linked items exist because of phase 4.

### Step 41 — Sessions navigator

[draft] `XTRM-630 · XT-105`

- **Brings** — Navigation from live tmux sessions, attention first, in rows that move only on state change.
- **Why here** — It needs the released topology feed (18), correct pane states (13) and the registry (24).

### Step 42 — Merged list, drawer and issue page

[new] `XT-110 slices 2–4`

- **Brings** — One list across Jira and Substrate with source marks, sync dots, owner glyphs and a PR column (state, checks, merge). The issue page has the brief first, then the contract, then one timeline of comments, Journal entries, PR events and receipts.
- **Why here** — It uses the model (40), the design (39) and the PR records (14, 26).

### Step 43 — @jira: and @pr: references

[new] `XT-110 slice 8`

- **Brings** — `@jira:XT-178` sits next to `@issue:`, `@agent:` and `@pr:`, and each resolves to its linked partners.
- **Why here** — Small once the client and the links exist.

### Step 44 — Graph workspace

[new] `XT-110 slice 5 · XT-105`

- **Brings** — Jira item → Issue → agent → session → worktree → branch → PR → commit, with every node opening its own surface.
- **Why here** — Every edge comes from a stored link: the registry (24), PR records (14, 26) and bindings (33). Built earlier, the graph would have no edges.

### Step 45 — Your 30-minute working session

[you] `XT-104 acceptance`

- **Brings** — Screenshots match the design; no layout shift while streaming; the 45-test host suite stays green; it works over SSH and Tailscale; then 30 minutes of real work.
- **Why here** — XT-104 closes on your verdict, because XTRM-557 passed every test and still looked wrong.

## Phase 6 — The programme loop runs itself

### Step 46 — The programme skill becomes product-management

[new] `XT-110 phase 5 · XT-163`

- **Brings** — A window issue created in Substrate creates the Jira Task with parent, sprint and link. The daily report is written once. The skill loses every step about copying keys, PR numbers and statuses.
- **Why here** — It is the payoff of phases 4 and 5, and it answers the original complaint.

Folded in: **XT-163** programme-coordination final rewrite

> **Ruling on your note · 10-29**
> - Rename programme-coordination to product-management. Today it is 446 lines of SKILL.md plus 1,258 lines of references.
> - SKILL.md keeps the daily loop. Each surface (Substrate, Jira, fleet, AgentRun) is a reference loaded on demand.
> - New reference: Jira board setup for Substrate. It covers the minimal steps and a mapping table: work stages to Jira statuses, Issue kinds to Jira types, the Substrate ref field and remote link, GitHub for Jira, the bot account, the `actor=agent` label. A user with other preferences fills in their own column.
> - Self-improvement lands as a reviewed change with evidence, not as edits in place. The skill folder holds two `.bak` copies from 10-28 edits today.

> **Ruling · 10-30**
> - Product-management becomes the programme-scale reference of the new `coordinator` role (22d), next to planning, multiplexing and the chain recipes. The Jira board setup reference lives here.

## Not in this plan

**Separate programmes:** XT-131 (codemode) and XT-132 (coordinators on Specialists and AgentRun), with their decision tickets XT-138 to XT-150, XT-164 and XT-171. They share no blocking dependency with this plan, except XT-172 and XT-148, which are folded into step 27.

**Infrastructure:** XT-7 (CI runner disk) and XT-9 (filesystem alert) belong to the infra repo.

**Monorepo migration:** deferred by your ruling of 10-29. `docs/monorepo-migration.md` is a draft from June and needs re-checking against today's repos before it is picked up.

**Old backlog:** XT-1 to XT-83 are triaged in step 38.

## Where the work runs

<!-- figure: The server holds the single Substrate database and the agent host; the PC uses an sb wrapper over SSH -->
<figure class="fig small" style="margin:0">
    <svg viewBox="0 0 760 210" role="img" aria-label="The server holds the single Substrate database and the agent host; the PC uses an sb wrapper over SSH">
      <defs><marker id="ar4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#5b6661"/></marker></defs>
      <g font-family="Public Sans, sans-serif">
        <rect x="10" y="20" width="330" height="170" rx="12" fill="#ffffff" stroke="#1f5a85"/>
        <text x="26" y="48" font-size="16" font-weight="700" fill="#1c2321">Server · the authority</text>
        <g font-size="13" fill="#1c2321">
          <text x="26" y="78">~/.xtrm/state.db, the only Substrate</text>
          <text x="26" y="102">Agent host: registry, reconciler, Jira</text>
          <text x="26" y="126">Bound agents: xt claude | pi, specialists</text>
          <text x="26" y="150">Mercury timers and cron (not copied)</text>
        </g>
        <rect x="420" y="20" width="330" height="170" rx="12" fill="#ffffff" stroke="#2f7a4f"/>
        <text x="436" y="48" font-size="16" font-weight="700" fill="#1c2321">This PC · the same stack</text>
        <g font-size="13" fill="#1c2321">
          <text x="436" y="78">Same repos, tools, settings, tmux</text>
          <text x="436" y="102">sb = SSH wrapper to the server</text>
          <text x="436" y="126">Unbound local sessions edit freely</text>
          <text x="436" y="150">Remote Control into server sessions</text>
        </g>
        <path d="M418 92 H342" stroke="#5b6661" stroke-width="1.6" marker-end="url(#ar4)"/>
        <text x="380" y="84" font-size="11" fill="#5b6661" text-anchor="middle">sb over ssh</text>
        <path d="M342 136 H418" stroke="#5b6661" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#ar4)"/>
        <text x="380" y="128" font-size="11" fill="#5b6661" text-anchor="middle">manifest diff</text>
      </g>
    </svg>
    <figcaption>One database, two machines. Step 7 turns the SSH wrapper into a proper remote client.</figcaption>
  </figure>

## What I need from you, in order

### Step A

Run prompts 1 and 2 on the server, and run `gh auth login` on this PC. That unblocks steps 4–5.

### Step B

Approve the local sync (step 5) once CORE-2513 has merged.

### Step C

Approve publishing at step 18 and the backfill at step 37.

### Step D

About an hour of Jira admin at step 31, three answers at step 29, and the design pick at step 39, which can happen any time before phase 5.

### Step E

Fix the xtrm-dev billing lock (step 4b). Until then no check on core can pass.

Each step has a notes box. Your notes save to this site as you type, and Claude reads them back with the site owner's key.

Sources: Jira XT-104, XT-110, XT-114 with themes XT-125 to XT-130, XT-168, XT-178 (amendment of 2026-10-28), XT-184, XT-190, and the open XT list. Substrate CORE-2376, CORE-2377, CORE-2513, CORE-2538, CORE-2381, CORE-2536, XTRM-639. Server `state.db`, read-only, on 2026-10-28 and 10-29. GitHub billing usage and check runs for xtrm-dev. specialists and core source on the server. Jira dev-status for XT-114, and GitHub org app installations. Steps marked "new" have no Substrate issue yet; I file them when the phase starts.
