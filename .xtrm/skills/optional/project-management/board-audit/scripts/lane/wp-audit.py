#!/usr/bin/env python3
"""Waiting Production audit, 60-minute cadence, read-only: reports, never transitions.

Method: board-audit/references/waiting-production-audit.md rev 5. Instrument rev 10.
A row is Waiting Production when every build vehicle it needs is merged and nothing its own step
consumes is unrun. "Not live" is measured against the RUNNING image SHA per container
(`make deploy-status`), never against origin/stable - a merge on stable says nothing about what runs.

Classes this instrument reports for every row currently reading Waiting Production:
  OPEN-PR        an open (incl. draft) PR binds the row: its own step is not the only thing left
  NO-VEHICLE     no merged PR binds the row: the status is a claim, not a measurement
  AMBIGUOUS-KEY  the row's substrate key appears in a merged PR title/branch, but two or more open rows
                 carry that key: the PRs stay an advisory hint and the vehicle cannot be attributed
  UNMEASURABLE   the vehicles scope to no running image (docs/tests/migrate/rust): absence of
                 evidence, not absence of work
  LIVE           every scoped container already contains the merge: the row is not Waiting Production
  PENDING        merged, not live on at least one scoped container: correctly Waiting Production,
                 with the per-container comparison printed
Each row also prints its unrun inward Blocks links, so a coordinator can apply the "consumes the
output" test without another read.

rev 6: a substrate key (MMD-nnnn, case-insensitive) in a merged PR TITLE or BRANCH now binds the row that
carries exactly one open `substrate:<key>` label, at Jira-key strength; a key shared by two or more open rows
is AMBIGUOUS-KEY. A PR body mention remains a hint only.

rev 7: an empty scope derivation is never cached, and a cached empty list is re-derived on read - a merge can
be absent from the local checkout when first scoped and fetched later. The substrate tier is unchanged.

rev 8: a merge commit's scope is `git diff --name-only M^1 M`; `git show`'s combined diff is empty for a clean
merge, which froze four bound rows. A single-parent commit keeps the rev 6 derivation unchanged.

rev 9: a compose change is a deploy vehicle, not documentation: `docker-compose.ya?ml` is no longer DOC_ONLY and
scopes to the services that file defines, read from its `services:` keys at run time. An unparseable compose
file scopes to nothing, exactly as before. And the scope cache is now trusted by derivation scheme: an entry
written under an older scheme (or with no marker) is re-derived once instead of being believed.

rev 10: a compose change scopes to the services its changed hunks touch (`git diff -U0 M^1 M`, or `git show -U0`
for a single-parent commit), not to every service in the file. A hunk outside every service block (anchors,
networks, volumes, the top-level keys), a deletion-only hunk, or an unreadable file/diff falls back to all
services: conservative, it can produce PENDING but never LIVE.

Controls, from the same artefact, printed every run: a known merged binding must resolve (config key
wp_known_binding), both ancestry poles are derived from the running images, and the reference rows
(config key wp_reference_keys) are re-classed and printed. A control that disagrees exits 2 and the
caller shouts. The path -> container map is config key container_paths.
"""
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile

import lanecfg

LANE = lanecfg.lane()
REPO = lanecfg.repo()
PROJECT = lanecfg.project()
SB_PREFIX = lanecfg.sb_prefix()
WAITING = lanecfg.statuses()["waiting_production"]
CYCLE = str(lanecfg.SCRIPTS / "cycle" / "cycle.py")
SCOPE_CACHE = f"{LANE}/wp-scope-cache.json"
# Derivation scheme the cached file lists were produced by (rev 9). Trust is per scheme, not per entry: a
# list cached under an older derivation (rev <= 7 cached `git show`'s combined diff for a merge, which is
# empty for a clean merge) may contradict the current rule, and a pre-scheme file carries no marker at all.
# Bumping SCOPE_SCHEME invalidates the whole cache, which is the intended one-time re-derive.
SCHEME_KEY = "_scheme"
SCOPE_SCHEME = "rev9"
SNAP = f"{LANE}/deploy-snapshot.json"

_spec = importlib.util.spec_from_file_location("boardcycle", CYCLE)
C = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(C)

FIELDS = ["key", "summary", "status", "labels", "issuelinks", "duedate", "parent", "description"]
BINDING = re.compile(r"Jira binding:\s*(" + lanecfg.jira_key_re() + ")", re.I)
ISSUE_REF = re.compile(lanecfg.jira_key_re(group=True))
# A PR number in a row summary: "#123" or "<repo>#123" for the delivery repo and any gate repo.
_REPOS = [lanecfg.repo_name()] + list(lanecfg.data("PM_GATE_REPOS", {}))
PR_IN_TEXT = re.compile(r"(?:" + "|".join(re.escape(r) for r in _REPOS) + r")?#(\d{1,4})\b")

# Fail-closed control (coordinator rule 2026-11-10): a known merged binding must resolve or every
# verdict is UNKNOWN. The configured PR (wp_known_binding = [jira-key, pr-number]) is MERGED and declares
# "Jira binding: <key>" in its body, so a complete index always places it under that key. When it
# does not, the index is partial and a NO-VEHICLE verdict is a rendering artefact, not a measurement:
# on 2026-11-10 two runs produced exactly that on three rows.
# Coordinator ruling 2026-11-10 (after both poles were shown): the block on acting from a NO-VEHICLE
# verdict is lifted, with one condition - a status change driven by NO-VEHICLE still goes to the
# coordinator as a PROPOSAL first. This instrument never transitions a row; it only reports.
KNOWN_BINDING = tuple(lanecfg.data("PM_WP_KNOWN_BINDING", required=True))
REFERENCE_KEYS = list(lanecfg.data("PM_WP_REFERENCE_KEYS", []))
CONTROL = {"ok": None, "line": ""}

DOC_ONLY = re.compile(r"^(docs/|tests/|examples/|\.github/|Makefile|.*\.md$)")
# rev 9: a compose change ships at a deploy, so it is a vehicle. rev 10: its scope is the services whose blocks
# the changed hunks touch, not every service in the file. A service name is the container name in this
# deployment, so no service list is hard-coded: the file is parsed at run time.
COMPOSE_FILE = re.compile(r"^docker-compose\.ya?ml$")
_COMPOSE = {}
_COMPOSE_HUNKS = {}
MIGRATIONS = re.compile(r"^(alembic/|alembic\.ini|config/|requirements[^/]*\.txt$)")
# Ordered rules, first match wins: {"prefixes": [...], "match": optional regex, "containers": [...]}
CONTAINER_PATHS = lanecfg.data("PM_CONTAINER_PATHS", required=True)


def _last_content_line(lines, first, stop):
    """1-based number of the last non-blank, non-comment line before <stop> (0-based, exclusive), at or after
    <first>. Trims a service block back to its own content, so a hunk on the blank line before `volumes:` is
    not attributed to the service above it."""
    for k in range(stop - 1, first - 1, -1):
        s = lines[k].strip()
        if s and not s.startswith("#"):
            return k + 1
    return first


def compose_layout(text):
    """(name, first_line, last_line) for each service under the top-level `services:` key, 1-based and
    inclusive (rev 10). Stdlib only: the block's own indentation decides what is a service key, so
    `image:`, `environment:` and list items below a service are not mistaken for services. [] when there is
    no parseable services block - the caller then scopes to nothing rather than inventing containers."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if not re.match(r"^services:\s*(?:#.*)?$", line):
            continue
        blocks, indent, end = [], None, len(lines)
        for j in range(i + 1, len(lines)):
            nxt = lines[j]
            if not nxt.strip() or nxt.lstrip().startswith("#"):
                continue
            ind = len(nxt) - len(nxt.lstrip())
            if ind == 0:
                end = j  # the next top-level key: the services block is over
                break
            if indent is None:
                indent = ind
            if ind != indent:
                continue  # a nested key of the service above, not a service
            m = re.match(r"^([A-Za-z0-9_.-]+):\s*(?:[#&*{].*)?$", nxt.strip())
            if m:
                if blocks:
                    blocks[-1][2] = _last_content_line(lines, blocks[-1][1], j)
                blocks.append([m.group(1), j + 1, None])
        if blocks:
            blocks[-1][2] = _last_content_line(lines, blocks[-1][1], end)
        return [tuple(b) for b in blocks]
    return []


def parse_compose_services(text):
    """Service names under the top-level `services:` key, in file order (rev 9)."""
    return [name for name, _, _ in compose_layout(text)]


def services_on_lines(text, new_lines):
    """Services whose block contains every given post-image line number (rev 10). None as soon as one line
    falls outside every service block - the caller then falls back to all services, never to an invented set."""
    blocks = compose_layout(text)
    if not blocks:
        return None
    out = set()
    for n in sorted(new_lines):
        hit = {name for name, a, b in blocks if a <= n <= b}
        if not hit:
            return None
        out |= hit
    return out


def git_text(args):
    """Raw stdout of a git command in the delivery checkout ('' when it fails). Unlike git_lines it keeps
    indentation, which the compose parse depends on. A seam the selftest can stub like git_lines."""
    p = subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, timeout=60)
    return p.stdout if p.returncode == 0 else ""


def compose_text(rel, sha=None):
    """(compose file text, True when it is the merge's own post-image). The post-image is read first so the
    changed line numbers and the parsed blocks come from the same file; the working tree is only a fallback,
    and then `exact` is False because hunk lines cannot be lined up against a different image."""
    key = (rel, sha or "")
    if key not in _COMPOSE:
        text, exact = "", False
        if sha:
            text = git_text(["show", f"{sha}:{rel}"])
            exact = bool(text)
        if not text:
            try:
                text = open(os.path.join(REPO, rel)).read()
            except OSError:
                text = ""
        _COMPOSE[key] = (text, exact)
    return _COMPOSE[key]


def commit_hunks(sha, rel):
    """(start, count) added-line spans a commit's diff introduces for one path, from its `-U0` hunk headers:
    a merge is read as `git diff -U0 M^1 M` (rev 8's derivation), a single-parent commit as `git show -U0`.
    [] when the diff is unavailable or carries no hunk - the caller falls back to every service."""
    parents = git_lines(["rev-list", "--parents", "-n", "1", sha])
    if parents and len(parents[0].split()) - 1 >= 2:
        lines = git_lines(["diff", "-U0", f"{sha}^1", sha, "--", rel])
    else:
        lines = git_lines(["show", "-U0", "--format=", sha, "--", rel])
    out = []
    for l in lines:
        m = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", l)
        if m:
            out.append((int(m.group(1)), int(m.group(2)) if m.group(2) is not None else 1))
    return out


def compose_change_services(rel, sha=None):
    """Services a compose change configures (rev 10): the `services.<name>` blocks its changed hunks touch,
    unioned across hunks.

    The fallback to ALL services in the file is deliberately conservative - it can produce PENDING but never
    LIVE, so it cannot hide outstanding work. It applies when a hunk falls outside every service block
    (x-anchors, networks, volumes, the top-level keys, anything above `services:`), when a hunk only deletes
    lines (a `+c,0` header has no post-image span to place), when the diff is unavailable, or when the file
    cannot be read or parsed."""
    text, exact = compose_text(rel, sha)
    services = parse_compose_services(text)
    if not services:
        return set()
    if not exact or sha is None:
        return set(services)
    lines = set()
    key = (sha, rel)
    if key not in _COMPOSE_HUNKS:
        _COMPOSE_HUNKS[key] = commit_hunks(sha, rel)
    for start, count in _COMPOSE_HUNKS[key]:
        if count <= 0:
            return set(services)  # a deletion has no post-image span to place it in
        lines |= set(range(start, start + count))
    hit = services_on_lines(text, lines) if lines else None
    return set(hit) if hit else set(services)


def containers_for(paths, sha=None):
    """Path -> container set (rev 5 mapping, from config key container_paths; a compose change scopes to the
    services its changed hunks configure, rev 9/10)."""
    out = set()
    for p in paths:
        if COMPOSE_FILE.match(p):
            out |= compose_change_services(p, sha)
            continue
        if DOC_ONLY.match(p) or MIGRATIONS.match(p):
            continue
        for rule in CONTAINER_PATHS:
            if not p.startswith(tuple(rule["prefixes"])):
                continue
            if rule.get("match") and not re.search(rule["match"], p):
                continue
            out |= set(rule["containers"])
            break
    return out


def deploy():
    """Running image SHAs. Falls back to a live `make deploy-status` when no snapshot exists, so an
    empty map can never masquerade as 'nothing is running' (the failure that made 19 rows UNMEASURABLE
    on the first run of this instrument)."""
    try:
        return json.load(open(SNAP))["containers"]
    except (OSError, ValueError, KeyError):
        pass
    spec = importlib.util.spec_from_file_location("deploycheck", str(lanecfg.SCRIPTS / "deploy-check.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.snapshot() or {}


def git_lines(args):
    """stdout lines of a git command in the delivery checkout; [] when it fails. The one impure git seam, so
    the merge-scope rule can be proved without a repository (selftest case E)."""
    p = subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, timeout=60)
    return [l.strip() for l in p.stdout.splitlines() if l.strip()] if p.returncode == 0 else []


def derive_scope(sha):
    """Files a commit touches, straight from git. A two-or-more-parent merge is read as `git diff M^1 M`: the
    default `git show` combined diff is empty for a clean merge, which is how four bound rows were frozen
    (rev 8). A single-parent commit keeps the rev 6 derivation exactly - `git show --name-only --format=`.
    Empty still means the derivation produced nothing (absent commit, or a merge with no first-parent diff),
    never that the merge has no scope: rev 7's reason for keeping an empty result out of the cache."""
    parents = git_lines(["rev-list", "--parents", "-n", "1", sha])
    if parents and len(parents[0].split()) - 1 >= 2:
        return git_lines(["diff", "--name-only", f"{sha}^1", sha])
    return git_lines(["show", "--name-only", "--format=", sha])


def scope(sha, cache_path=None):
    """Files a merged PR's merge commit touches, cached by the merge SHA.

    Every caller passes a merged PR's merge SHA (verdicts and controls both walk merged PRs). An empty
    derivation is never written: the fixed-size PR window and a partial local checkout make an absent commit,
    and `git show` a merge commit's combined diff, transient readings rather than durable answers. A cached
    empty list is therefore re-derived on read, and the entry is healed when the re-derivation yields files
    (rev 7). Rev 9 adds trust by derivation scheme: a file list is only believed when it was written under
    SCOPE_SCHEME, so a list cached by an older derivation (`git show`'s combined diff for a merge, rev <= 7)
    cannot keep a scope the current rule disagrees with. The scheme marker is one per cache file, not per
    entry, because a single writer owns the file: a scheme bump invalidates all of it at once."""
    path = cache_path or SCOPE_CACHE
    cache = {}
    try:
        cache = json.load(open(path))
    except (OSError, ValueError):
        pass
    if not isinstance(cache, dict):
        cache = {}
    files = cached_scope(cache, sha)
    if files:
        return files
    files = derive_scope(sha)
    if files:
        write_scope(cache, sha, files, path)
    return files


def cached_scope(cache, sha):
    """Files this cache vouches for under the current derivation scheme, or None when the entry must be
    re-derived: the file carries no scheme marker (written by rev <= 8) or an older one, or the entry itself
    is empty or malformed (rev 7's rule, kept)."""
    if cache.get(SCHEME_KEY) != SCOPE_SCHEME:
        return None
    files = cache.get(sha)
    return files if isinstance(files, list) and files else None


def write_scope(cache, sha, files, path):
    """Store <sha> -> <files> under SCOPE_SCHEME, keeping only entries the current scheme vouches for. After a
    scheme bump that is one re-derive pass over the cache, never a re-derivation on every read (which would
    cost a git call per entry)."""
    keep = ({k: v for k, v in cache.items() if isinstance(v, list) and v}
            if cache.get(SCHEME_KEY) == SCOPE_SCHEME else {})
    keep[SCHEME_KEY] = SCOPE_SCHEME
    keep[sha] = files
    json.dump(keep, open(path, "w"), indent=0)


def ancestry(merge, running):
    """(True|False|None) - is <merge> in <running>? None when a commit is absent locally: unknown, not no."""
    for sha in (merge, running):
        if subprocess.run(["git", "cat-file", "-e", f"{sha}^{{commit}}"], cwd=REPO,
                          capture_output=True).returncode != 0:
            return None
    return subprocess.run(["git", "merge-base", "--is-ancestor", merge, running], cwd=REPO,
                          capture_output=True).returncode == 0


def pr_keys(pr):
    keys = []
    m = BINDING.search(pr.get("body") or "")
    if m:
        keys.append(m.group(1).upper())
    text = (pr.get("title") or "") + " " + (pr.get("headRefName") or "")
    keys += [f"{PROJECT}-{n}" for n in dict.fromkeys(ISSUE_REF.findall(text))]
    return list(dict.fromkeys(keys))


MMD_REF = re.compile(re.escape(SB_PREFIX) + r"[-_ ]?(\d{4,})", re.I)


def substrate_labels(fields):
    """Substrate keys the row declares as labels. Labels only: a key merely named in the summary is a
    reference for the hint line, not a declaration (rev 6 keeps the two apart)."""
    return list(dict.fromkeys(
        x.split(":", 1)[1] for x in (fields.get("labels") or []) if x.startswith(f"substrate:{SB_PREFIX}-")
    ))


def substrate_refs(row):
    refs = substrate_labels(row)
    refs += [f"{SB_PREFIX}-" + n for n in MMD_REF.findall(row.get("summary") or "")]
    return list(dict.fromkeys(refs))


def fetch_pr(num):
    """Read a single PR by number (gh pr view N), so a bound PR that has aged out of the 500-row
    merged list is still resolved. Returns the PR dict or None."""
    fields = "number,title,body,mergeCommit,mergedAt,headRefName,isDraft,state,files"
    out = C.gh(["pr", "view", str(num), "--json", fields])
    return out if isinstance(out, dict) else None


def load_prs():
    """500 merged PRs reach back to 2026-09-06, well past the 2026-10-06 project cut-off. The window is
    a window: its read time is printed with the audit. Bound PRs (KNOWN_BINDING and any named in rows) are
    also fetched by number, because the fixed-size list can age them out (2026-11-10)."""
    fields = "number,title,body,mergeCommit,mergedAt,headRefName,isDraft,state,files"
    merged = C.gh(["pr", "list", "--state", "merged", "--limit", "500", "--json", fields])
    opens = C.gh(["pr", "list", "--state", "open", "--limit", "200", "--json", fields])
    merged = (merged if isinstance(merged, list) else [])
    opens = (opens if isinstance(opens, list) else [])
    # fetch the known binding PR by number so the control never depends on list size
    kb = fetch_pr(KNOWN_BINDING[1])
    if kb is not None and kb.get("number") not in {p.get("number") for p in merged}:
        merged.append(kb)
    return merged, opens


def index(prs):
    """(Jira index, Substrate hint index, Substrate binding index, prs).

    The Jira index is strict - only the declared `Jira binding:` line or a title/branch key, never body
    prose (rev 5). The hint index (title+body+branch) is what the advisory line prints. The binding index
    is the rev 6 tier: the substrate key in the PR TITLE or BRANCH only - a body mention never binds."""
    idx, mdx, sdx = {}, {}, {}
    for p in prs:
        for k in pr_keys(p):
            idx.setdefault(k, []).append(p)
        blob = " ".join((p.get("title") or "", p.get("body") or "", p.get("headRefName") or ""))
        for n in dict.fromkeys(MMD_REF.findall(blob)):
            mdx.setdefault(f"{SB_PREFIX}-{n}", []).append(p)
        declared = " ".join((p.get("title") or "", p.get("headRefName") or ""))
        for n in dict.fromkeys(MMD_REF.findall(declared)):
            sdx.setdefault(f"{SB_PREFIX}-{n}", []).append(p)
    return idx, mdx, sdx, prs


def verdicts(key, merged_idx, open_idx, dep, refs=(), named=(), substrate=None):
    """(class, detail lines) for one row.

    A vehicle is a DECLARED binding only: the `Jira binding:` line, a Jira key in the PR title or branch, a
    PR number the row's own text names, or (rev 6) a substrate key in the PR title or branch when exactly
    one open row carries that `substrate:<key>` label. Body prose mentioning a `substrate:SB-n` ref is a
    reference, not a vehicle (rev 5 correction: 16 of 22 rows flip under a mention-counts reading), so those
    PRs are printed as an advisory hint and never decide a class. A substrate key carried by two or more open
    rows cannot decide either - the row is AMBIGUOUS-KEY and the PRs stay a hint (rev 6). A row that already
    binds - Jira key, or a PR its own text names - keeps its class: the substrate tier is consulted only when
    nothing binds it."""
    merged = list(merged_idx[0].get(key, []))
    opens = list(open_idx[0].get(key, []))
    bynum_m = {p["number"]: p for p in merged_idx[3]}
    bynum_o = {p["number"]: p for p in open_idx[3]}
    for n in named:
        if n in bynum_m and bynum_m[n] not in merged:
            merged.append(bynum_m[n])
        if n in bynum_o and bynum_o[n] not in opens:
            opens.append(bynum_o[n])
    detail = []
    hint = [p["number"] for ref in refs for p in merged_idx[1].get(ref, [])]
    if hint:
        detail.append(f"{SB_PREFIX} prose mentions (not bindings): " + ", ".join(f"#{n}" for n in sorted(set(hint))))
    ambiguous = []
    if not merged and not opens and substrate:
        sub_m, sub_o = [], []
        for sk, sharing in sorted(substrate.items()):
            bound = merged_idx[2].get(sk, [])
            bound_o = open_idx[2].get(sk, [])
            if not bound and not bound_o:
                continue
            nums = ", ".join(f"#{p['number']}" for p in sorted(bound + bound_o, key=lambda x: x["number"]))
            if len(sharing) >= 2:
                ambiguous.append(f"substrate {sk} shared by open rows {', '.join(sorted(sharing))}: {nums} "
                                 "stay an advisory hint, not a binding")
                continue
            sub_m += [p for p in bound if p not in sub_m]
            sub_o += [p for p in bound_o if p not in sub_o]
            detail.append(f"substrate {sk} in PR title/branch: {nums}")
        if sub_m or sub_o:
            merged += [p for p in sub_m if p not in merged]
            opens += [p for p in sub_o if p not in opens]
        elif ambiguous:
            return "AMBIGUOUS-KEY", detail + ambiguous
        detail += ambiguous
    if opens:
        detail.append("open PR(s): " + ", ".join(f"#{p['number']}({p['state']})" for p in opens))
    if not merged:
        return "NO-VEHICLE", detail + ["no merged PR binds this key"]
    conts = set()
    for p in merged:
        sha = (p.get("mergeCommit") or {}).get("oid")
        if not sha:
            detail.append(f"#{p['number']}: no merge commit (squash/rebase): unmeasurable")
            continue
        conts |= containers_for(scope(sha), sha)
        detail.append(f"#{p['number']} merge {sha[:10]} scopes {sorted(containers_for(scope(sha), sha)) or 'nothing'}")
    if not conts:
        return ("OPEN-PR" if opens else "UNMEASURABLE"), detail
    live, pending, unknown = [], [], []
    for c in sorted(conts):
        running = (dep.get(c) or {}).get("sha", "absent")
        if running == "absent":
            unknown.append(f"{c}: not running")
            continue
        if running == "unknown":
            unknown.append(f"{c}: no git SHA in the tag")
            continue
        r = None
        for p in merged:
            sha = (p.get("mergeCommit") or {}).get("oid")
            if not sha:
                continue
            if containers_for(scope(sha), sha) >= {c}:
                a = ancestry(sha, running)
                if a is True:
                    r = True
                    break
                if a is None:
                    r = None
                elif r is None:
                    r = False
        (live if r is True else unknown if r is None else pending).append(f"{c}@{running}")
    detail.append(f"live: {live or '-'} | not live: {pending or '-'} | unknown: {unknown or '-'}")
    if opens:
        return "OPEN-PR", detail
    if pending:
        return "PENDING", detail
    if live and not unknown:
        return "LIVE", detail
    return "UNMEASURABLE", detail


def unrun_blocks(row):
    out = []
    for l in row.get("issuelinks") or []:
        t = (l.get("type") or {}).get("name", "")
        inward = l.get("inwardIssue")
        if not inward or t.lower() != "blocks":
            continue
        st = (inward.get("fields") or {}).get("status") or {}
        cat = (st.get("statusCategory") or {}).get("key")
        if cat != "done":
            out.append(f"{inward['key']} ({st.get('name')})")
    return out


def binding_control(merged, midx):
    """Fail closed: the known merged binding must resolve, and its PR must be inside the PR window.

    Returns (ok, line). ok is False when the PR is missing from the window or the index does not place it
    under its declared key - both mean the run cannot distinguish "no vehicle" from "index incomplete".
    """
    key, num = KNOWN_BINDING
    present = any(p.get("number") == num for p in merged)
    under = [p for p in midx[0].get(key, []) if p.get("number") == num]
    ok = present and bool(under)
    why = ("PR #%d absent from the merged window" % num) if not present else (
        "#%d present but not indexed under %s" % (num, key) if not under else "resolved")
    return ok, "- bound control #%d -> %s: %s" % (num, key, why.upper() if not ok else "RESOLVED")


def audit(keys=None, label_counts=None):
    """label_counts: substrate key -> open rows carrying it, from the population the caller already loaded.
    The reference-row re-audit passes the main population's counts so its classes are not decided by the
    three rows it fetched (a key shared by another open row must still read AMBIGUOUS-KEY there)."""
    merged, opens = load_prs()
    midx, oidx = index(merged), index(opens)  # (issue index, hint index, binding index, prs) each
    dep = deploy()
    q = f"project = {PROJECT} AND statusCategory != Done"
    if keys:
        q = "key in (%s)" % ", ".join(keys)
    rows, complete = C.jql(q, fields=FIELDS)
    if not complete:
        print("WP-AUDIT-INCOMPLETE jql did not finish: population unknown, refuse to report")
        return None
    CONTROL["ok"], CONTROL["line"] = binding_control(merged, midx)
    # Uniqueness guard (rev 6): how many open rows carry each substrate label. Counted over the open rows
    # loaded here, so a key shared with a row that is not Waiting Production still reads ambiguous.
    if label_counts is None:
        label_counts = {}
        for i in rows:
            for k in substrate_labels(i["fields"]):
                label_counts.setdefault(k, []).append(i["key"])
    pop = []
    all_named = set()
    for i in rows:
        r = C.row_of(i)
        if keys or r["status"] == WAITING:
            r["blocks"] = unrun_blocks(i)
            r["refs"] = substrate_refs(i["fields"])
            r["substrate"] = {k: label_counts.get(k, []) for k in substrate_labels(i["fields"])}
            r["named_prs"] = sorted({int(n) for n in PR_IN_TEXT.findall(r["summary"])})
            all_named |= set(r["named_prs"])
            pop.append(r)
    # fetch named PRs by number so they are not lost to the 500-row list limit
    merged_nums = {p.get("number") for p in merged}
    for n in all_named:
        if n not in merged_nums:
            p = fetch_pr(n)
            if p is not None:
                merged.append(p)
                merged_nums.add(n)
    midx, oidx = index(merged), index(opens)
    CONTROL["ok"], CONTROL["line"] = binding_control(merged, midx)
    res = []
    for r in pop:
        if CONTROL["ok"] is not True:
            cls, detail = "UNKNOWN", [f"control failed (#{KNOWN_BINDING[1]} -> {KNOWN_BINDING[0]} did not resolve): "
                                      "the binding index is incomplete, so no row can be classed"]
        else:
            cls, detail = verdicts(r["key"], midx, oidx, dep, r["refs"], r["named_prs"], r["substrate"])
        res.append({"key": r["key"], "summary": r["summary"], "status": r["status"],
                    "cls": cls, "detail": detail, "blocks": r["blocks"]})
    return res, dep, len(rows), merged, label_counts


def controls(dep, merged):
    """Two poles from the live artefact, so a moved image can never silently invert the instrument.

    positive: ancestry(running, running) must be True for every container with a known SHA (the primitive
    answers yes to a case whose answer is known).
    negative: the newest PR merged AFTER a container started, scoped to that container, must NOT be in its
    running image - an image cannot contain a merge that happened after it started. A True here means the
    SHA comparison is wrong (wrong container, wrong SHA, or an inverted return).
    """
    lines, bad = [], []
    for c, v in sorted(dep.items()):
        sha = v.get("sha")
        if not sha or sha in ("unknown", "absent"):
            continue
        a = ancestry(sha, sha)
        if a is not True:
            bad.append(f"{c}: reflexivity ancestry({sha[:10]},{sha[:10]})={a}, expected True")
        lines.append(f"- {c} positive pole: ancestry({sha[:10]},{sha[:10]})={a}")
    for c, v in sorted(dep.items()):
        sha, started = v.get("sha"), v.get("started")
        if not sha or sha in ("unknown", "absent") or not started:
            continue
        after = [p for p in merged if (p.get("mergedAt") or "") > started
                 and (p.get("mergeCommit") or {}).get("oid")
                 and containers_for(scope((p.get("mergeCommit") or {})["oid"]),
                                    (p.get("mergeCommit") or {})["oid"]) & {c}]
        if not after:
            continue
        p = max(after, key=lambda x: x["mergedAt"])
        a = ancestry((p.get("mergeCommit") or {}).get("oid"), sha)
        ok = a is False
        lines.append(f"- {c} negative pole: #{p['number']} merged {p['mergedAt']} after start, "
                     f"ancestry={a} — {'OK' if ok else 'FAIL'}")
        if not ok:
            bad.append(f"{c}: #{p['number']} merged after start reads ancestry={a}, expected False")
    return lines, bad


def vehicle_labels(keys):
    """key -> labels for the audited rows. A label read is the only honest way to ask whether a row
    declares the vehicle its status claims."""
    out = {}
    for k in keys:
        st, d = C.jira.call("GET", f"/rest/api/3/issue/{k}?fields=labels")
        out[k] = list((d["fields"].get("labels") or [])) if st == 200 else []
    return out


def main():
    out = audit()
    if out is None:
        return 1
    res, dep, total, merged, label_counts = out
    by = {}
    for r in res:
        by.setdefault(r["cls"], []).append(r)
    lines = [f"# Waiting Production audit {C.stamp()} — read-only, rev 10",
             "",
             "rev 6: a substrate key in a merged PR title/branch now binds the uniquely-labelled row; a key "
             "carried by two or more open rows is AMBIGUOUS-KEY (PRs stay a hint).",
             "rev 7: an empty scope derivation is never cached, and a cached empty list is re-derived on read.",
             "rev 8: a merge commit's scope is git diff M^1 M (git show's combined diff is empty for a clean merge).",
             "rev 9: a compose change scopes to the services its compose file defines (a deploy vehicle, not docs); "
             "a cache entry from an older derivation scheme is re-derived.",
             "rev 10: a compose change scopes to the services its changed hunks touch, all services (PENDING at "
             "worst) when a hunk falls outside every service block.",
             "",
             f"population: {total} open {PROJECT} rows; audited {len(res)} rows reading Waiting Production",
             "", "## Verdicts", ""]
    for cls in ("UNKNOWN", "LIVE", "OPEN-PR", "NO-VEHICLE", "AMBIGUOUS-KEY", "UNMEASURABLE", "PENDING"):
        rows = by.get(cls, [])
        if not rows:
            continue
        lines.append(f"### {cls} — {len(rows)}")
        for r in rows:
            blocks = f" | unrun blocks: {', '.join(r['blocks'])}" if r["blocks"] else ""
            lines.append(f"- {r['key']} | {r['summary'][:80]}{blocks}")
            for d in r["detail"]:
                lines.append(f"  - {d}")
        lines.append("")
    # B291: a Waiting Production row whose vehicle is known must say so in a label, otherwise the class
    # stays a reading exercise. A WP row with no vehicle label is a finding to report each audit.
    lab = vehicle_labels([r["key"] for r in res])
    no_lab = [k for k, ls in lab.items() if not any(x.startswith("vehicle:PR-") for x in ls)]
    lines += ["", f"## Vehicle labels (B291 check) - {len(no_lab)} of {len(res)} WP rows carry none", ""]
    for r in res:
        ls = [x for x in lab.get(r["key"], []) if x.startswith("vehicle:PR-")]
        lines.append(f"- {r['key']} [{r['cls']}] vehicles: {', '.join(ls) if ls else 'NONE - finding'}")
    lines += ["", "## Containers (running image SHA)", ""]
    for name, v in sorted(dep.items()):
        if v.get("sha") not in ("absent", "unknown"):
            lines.append(f"- {name} {v['sha']} since {v['started']}")
    ctrl_lines, bad = controls(dep, merged)
    lines += ["", "## Controls (self-calibrating: both poles derived from the live artefact)", ""]
    lines += [CONTROL["line"]]
    lines += ctrl_lines
    lines += ["", "Reference rows (config key wp_reference_keys) - class now, with the image that decided it. "
              "No pass/fail: their expected verdict moves when the running images move, so a merge once "
              "outside an image may be inside it now."]
    ref = audit(REFERENCE_KEYS, label_counts) if REFERENCE_KEYS else None
    for r in (ref[0] if ref else []):
        lines.append(f"- {r['key']}: {r['cls']} - {r['detail'][-1]}")
    lines += ["", "A row whose PR carries no `Jira binding:` line is not usable as a control: a "
              "binding-strict index cannot see it by construction. Known limit, recorded not hidden."]
    stamp = C.stamp()
    path = f"{LANE}/WP-AUDIT-{stamp[11:16].replace(':', '')}Z.md"
    open(path, "w").write("\n".join(lines) + "\n")
    counts = {k: len(v) for k, v in by.items()}
    counts["no_vehicle_label"] = len(no_lab)
    # An hourly pass that reports the same classes is a state, not an event. Print the counts line only
    # when the population actually moved (or when a class that must never be quiet - LIVE/OPEN-PR - is
    # non-empty), so an unchanged board does not wake the coordinator every hour. The file is always written.
    classes = ("UNKNOWN", "LIVE", "OPEN-PR", "NO-VEHICLE", "AMBIGUOUS-KEY", "UNMEASURABLE", "PENDING")
    sig = " ".join(f"{k}={counts.get(k, 0)}" for k in classes) + f" novh={counts.get('no_vehicle_label', 0)}"
    state_path = f"{LANE}/wp-last-classes.txt"
    prev = open(state_path).read().strip() if os.path.exists(state_path) else ""
    changed = sig != prev
    if changed or counts.get("LIVE") or counts.get("OPEN-PR"):
        print(f"WP-AUDIT {stamp} {sig}")
    print(f"WP-AUDIT-FILE {path}")
    if changed:
        open(state_path, "w").write(sig)
    if CONTROL["ok"] is not True:
        print(f"WP-AUDIT-CONTROL-FAILED {stamp} {CONTROL['line']} — every row UNKNOWN, exit 2")
        print(f"WP-AUDIT-FILE {path}")
        return 2
    live = by.get("LIVE", []) + by.get("OPEN-PR", [])
    if live:
        print("WP-AUDIT-ACTION " + ", ".join(r["key"] for r in live))
    if bad:
        print("WP-AUDIT-CONTROL-FAILED " + "; ".join(bad))
        return 2
    return 0


def selftest():
    """Offline proof of the substrate tier, the scope-cache rule, the merge-scope rule and the compose rule: no
    gh, no Jira, no git. Synthetic rows, PRs and deploy map are fed to verdicts(); the impure seams it touches
    (the git command, git file derivation, the scope cache path, git ancestry, the path -> container map, which
    is instance config, and the compose read) are stubbed. One PASS/FAIL line per case, exit 1 on fail."""
    global scope, ancestry, containers_for, derive_scope, git_lines, compose_change_services, compose_text, commit_hunks

    def pr(number, title, branch, body=""):
        return {"number": number, "title": title, "body": body, "headRefName": branch,
                "mergeCommit": {"oid": "0" * 40}, "mergedAt": "2026-11-01T00:00:00Z", "state": "MERGED"}

    dep = {"app": {"sha": "a" * 12, "started": "2026-10-01T00:00:00Z"}}
    cases = [
        ("A unique substrate key in the PR title binds",
         [pr(9001, "fix(volatility): honest empty value (MMD-4001)", "xt/MMD-4001-vol-null")],
         "ISSUE-1", {"MMD-4001": ["ISSUE-1"]}, ("MMD-4001",),
         lambda c, d: (c != "NO-VEHICLE" and any("#9001" in x for x in d),
                       f"expected a bound class naming #9001, got {c}")),
        ("B substrate key shared by two open rows is AMBIGUOUS-KEY",
         [pr(9002, "feat: daily stats backfill (MMD-4002)", "xt/MMD-4002-backfill")],
         "ISSUE-2", {"MMD-4002": ["ISSUE-2", "ISSUE-3"]}, ("MMD-4002",),
         lambda c, d: (c == "AMBIGUOUS-KEY" and any("ISSUE-3" in x for x in d),
                       f"expected AMBIGUOUS-KEY naming ISSUE-3, got {c}")),
        ("C body-only mention stays NO-VEHICLE with a hint",
         [pr(9003, "chore: unrelated", "xt/other", "context: MMD-4003 only in the body")],
         "ISSUE-4", {"MMD-4003": ["ISSUE-4"]}, ("MMD-4003",),
         lambda c, d: (c == "NO-VEHICLE" and any("#9003" in x and "not bindings" in x for x in d),
                       f"expected NO-VEHICLE with #9003 as a hint, got {c}")),
    ]
    real = scope, ancestry, containers_for, derive_scope, git_lines, compose_change_services, compose_text, commit_hunks
    derived = []

    def fake_derive(sha):
        derived.append(sha)
        return ["app/x.py"]

    scope = lambda sha: ["app/x.py"]
    ancestry = lambda merge, running: True
    containers_for = lambda paths, sha=None: {"app"} if paths else set()
    derive_scope = fake_derive
    failures = 0
    try:
        for name, prs, key, substrate, refs, want in cases:
            merged_idx, open_idx = index(prs), index([])
            cls, detail = verdicts(key, merged_idx, open_idx, dep, refs, (), substrate)
            ok, why = want(cls, detail)
            print(f"SELFTEST {'PASS' if ok else 'FAIL'} {name}: {cls}" + ("" if ok else f" - {why}"))
            failures += 0 if ok else 1
        # D: the real scope() must not trust a cached empty list - it re-derives (no git: derive_scope is
        # stubbed) and heals the entry; an empty derivation must not become a durable cache entry.
        scope = real[0]
        sha = "0" * 40
        with tempfile.TemporaryDirectory() as td:
            healed_path = os.path.join(td, "wp-scope-cache.json")
            with open(healed_path, "w") as f:
                json.dump({sha: []}, f)
            derived.clear()
            files = scope(sha, healed_path)
            healed = json.load(open(healed_path)).get(sha)
            ok = files == ["app/x.py"] and healed == ["app/x.py"] and derived == [sha]
            why = f"files={files} healed={healed} derived={derived}"
            empty_path = os.path.join(td, "empty.json")
            derive_scope = lambda s: []
            scope(sha, empty_path)
            wrote = os.path.exists(empty_path) and sha in json.load(open(empty_path))
            if wrote:
                ok, why = False, why + "; an empty derivation was persisted"
            print(f"SELFTEST {'PASS' if ok else 'FAIL'} D a cached empty scope is re-derived and healed, "
                  f"an empty derivation is not persisted: {'re-derived' if ok else why}")
            failures += 0 if ok else 1
        # E: a 2+-parent merge must be scoped as `git diff M^1 M`, whose first-parent diff is non-empty even
        # when `git show`'s combined diff is empty; a single-parent commit keeps `git show`. The git command
        # is the stub, so no repository (and no network) is needed.
        derive_scope = real[3]
        merge_sha, plain_sha = "1" * 40, "2" * 40
        forms = []

        def fake_git(args):
            if args[0] == "rev-list":
                forms.append(("rev-list", args[-1]))
                parents = f" {'a' * 40} {'b' * 40}" if args[-1] == merge_sha else f" {'a' * 40}"
                return [args[-1] + parents]
            if args[0] == "diff":
                forms.append(("diff", args[-1]))
                return ["api/mcp_v2/market.py", "svc_feed/src/engine.rs"]
            if args[0] == "show":
                forms.append(("show", args[-1]))
                return ["app/plain.py"]
            return []

        git_lines = fake_git
        merge_files = derive_scope(merge_sha)
        plain_files = derive_scope(plain_sha)
        ok = (merge_files == ["api/mcp_v2/market.py", "svc_feed/src/engine.rs"]
              and plain_files == ["app/plain.py"]
              and ("diff", merge_sha) in forms and ("show", merge_sha) not in forms
              and ("show", plain_sha) in forms)
        print(f"SELFTEST {'PASS' if ok else 'FAIL'} E a two-parent merge scopes as git diff M^1 M, a single-parent "
              f"commit keeps git show: " + (f"merge={len(merge_files)} files" if ok else
                                              f"merge={merge_files} plain={plain_files} forms={forms}"))
        failures += 0 if ok else 1
        # F: a compose change is a production vehicle (rev 9), not documentation: it scopes to the services the
        # file defines - read from the file, not a hard-coded list - and an unparseable file scopes to nothing,
        # which is the audit's existing unknown reading. The compose read, the scope and ancestry are stubbed,
        # so no repository, no network and no real merge commit are needed.
        containers_for = real[2]
        parsed = parse_compose_services(
            "version: '3.8'\n"
            "services:\n"
            "  app:\n"
            "    image: mmd-python:1\n"
            "    environment:\n"
            "      - FOO=1\n"
            "  worker:\n"
            "    image: mmd-python:1\n"
            "    labels: {tier: data}\n"
            "volumes:\n"
            "  app-data:\n")
        nothing = parse_compose_services("version: '3.8'\nvolumes:\n  app-data:\n")
        compose_change_services_stub = lambda rel, sha=None: {"app", "worker"}
        compose_change_services = compose_change_services_stub
        scope = lambda sha: ["docker-compose.yml"]
        ancestry = lambda merge, running: False
        scoped = containers_for(["docker-compose.yml"], "9" * 40)
        dep_f = {"app": {"sha": "a" * 12, "started": "2026-10-01T00:00:00Z"},
                 "worker": {"sha": "b" * 12, "started": "2026-10-01T00:00:00Z"}}
        cls, detail = verdicts("ISSUE-5",
                               index([pr(9004, "fix(compose): mirror default (MMD-4004)",
                                         "xt/MMD-4004-mirror")]),
                               index([]), dep_f, ("MMD-4004",), (), {"MMD-4004": ["ISSUE-5"]})
        compose_change_services = lambda rel, sha=None: set()
        fallback = containers_for(["docker-compose.yml"], "9" * 40)
        ok = (parsed == ["app", "worker"] and nothing == [] and scoped == {"app", "worker"}
              and fallback == set() and cls == "PENDING"
              and any("app@" in x and "worker@" in x for x in detail))
        print(f"SELFTEST {'PASS' if ok else 'FAIL'} F a compose change scopes to the services the file defines, "
              f"not to nothing: {cls}" + ("" if ok else f" - parsed={parsed} nothing={nothing} scoped={scoped} "
                                                       f"fallback={fallback} detail={detail}"))
        failures += 0 if ok else 1
        # G: a cached file list is trusted only under the current derivation scheme (rev 9): a pre-scheme file
        # (rev <= 8 wrote bare lists) or an older scheme marker is re-derived once, and the re-derived list is
        # written back WITH the current marker; a matching marker is trusted and costs no derivation at all.
        scope = real[0]
        fresh = []

        def fake_derive_g(s):
            fresh.append(s)
            return ["fresh/app.py"]

        derive_scope = fake_derive_g
        sha_g = "3" * 40
        with tempfile.TemporaryDirectory() as td:
            upgraded = []
            for name, cached in (("pre-scheme", {sha_g: ["old/only.py"]}),
                                 ("older-scheme", {SCHEME_KEY: "rev8", sha_g: ["old/only.py"]})):
                p = os.path.join(td, name + ".json")
                json.dump(cached, open(p, "w"))
                upgraded.append((name, scope(sha_g, p), json.load(open(p))))
            p = os.path.join(td, "current.json")
            json.dump({SCHEME_KEY: SCOPE_SCHEME, sha_g: ["kept/app.py"]}, open(p, "w"))
            fresh.clear()
            kept = scope(sha_g, p)
            ok = (all(files == ["fresh/app.py"] and c.get(SCHEME_KEY) == SCOPE_SCHEME
                      and c.get(sha_g) == ["fresh/app.py"] for _, files, c in upgraded)
                  and kept == ["kept/app.py"] and not fresh)
            print(f"SELFTEST {'PASS' if ok else 'FAIL'} G an entry from an absent or older derivation scheme is "
                  f"re-derived and re-stamped, a current one is trusted: "
                  + (f"{sha_g[:8]} re-derived under {SCOPE_SCHEME}" if ok else
                     f"upgraded={upgraded} kept={kept} fresh={fresh}"))
            failures += 0 if ok else 1
        # H: a compose change is scoped by its hunks (rev 10): a hunk inside exactly one service block scopes to
        # that one service, not to every service in the file. The compose post-image and the -U0 diff are
        # stubbed (the seams set by rev 10), so no repository, network or real merge commit is needed.
        sample = ("version: '3.8'\n"
                  "services:\n"
                  "  app:\n"
                  "    image: mmd-python:1\n"
                  "    environment:\n"
                  "      - FOO=1\n"
                  "  worker:\n"
                  "    image: mmd-python:1\n"
                  "  db:\n"
                  "    image: postgres:16\n"
                  "volumes:\n"
                  "  app-data:\n")
        containers_for, compose_change_services = real[2], real[5]
        compose_text = lambda rel, sha=None: (sample, True)
        commit_hunks = lambda sha, rel: [(5, 1)]  # line 5: inside app's block only
        sha_h, sha_i = "4" * 40, "5" * 40
        _COMPOSE_HUNKS.clear()
        one = containers_for(["docker-compose.yml"], sha_h)
        commit_hunks = lambda sha, rel: [(11, 2)]  # lines 11-12: volumes, outside every service block
        _COMPOSE_HUNKS.clear()
        all_of = containers_for(["docker-compose.yml"], sha_i)
        ok = one == {"app"} and all_of == {"app", "worker", "db"}
        print(f"SELFTEST {'PASS' if ok else 'FAIL'} H a hunk inside one service block scopes to that service, and a "
              f"hunk outside every block falls back to all: "
              + (f"hunk -> {sorted(one)}, outside -> {len(all_of)} services" if ok else
                 f"one={one} all_of={all_of}"))
        failures += 0 if ok else 1
    finally:
        (scope, ancestry, containers_for, derive_scope, git_lines, compose_change_services,
         compose_text, commit_hunks) = real
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv[1:]:
        sys.exit(selftest())
    sys.exit(main())
