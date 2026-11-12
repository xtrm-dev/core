#!/usr/bin/env python3
"""The ONE Jira comment write path for every project that uses this skill's jira.py.

Why it exists: comment writes were ad-hoc scripts, so three rules lived in a head instead of the code — the
60-minute other-writer check, the mention-node assertion, and the agent-tag-last convention. A rule in a head
is a rule until the next context loss. Since B396 jira.py REFUSES a direct POST .../comment unless
POST_GUARD_ACTIVE=1, which only this file sets, so this file is the only way a comment reaches Jira.

General tool, no project paths hard-coded. Instance settings come from pm_config (references/setup.md):
JIRA_SITE, PM_JIRA_PROJECT (the key linkified as <KEY>-<n>), PM_SB_PREFIX (the Substrate prefix cited as
<PREFIX>-n), PM_REPO_SLUG (owner/repo for a bare #<n>), PM_REPO_DIR and known_repos (the repos a <repo>#<n> may
name), PM_OPERATOR_ACCOUNT_ID. Lane-specific state (the run-tag record and the list of this
lane's own comment ids) is opt-in through flags or env; without them nothing is recorded and nothing breaks:
  --own-writes <file>   append every posted/updated comment id (env POST_GUARD_OWN_WRITES)
  --run-file <file>     stamp the WORD tag for the record (env POST_GUARD_RUN_FILE)
A lane keeps a thin wrapper that sets those two and execs this file, so its callers stay unchanged.

Usage:
  post-guard.py <JIRA-key> <text-file> --run <WORD> [--mention-first] [--force] [--dry-run]
               [--update <cid>] [--reply-to <cid>] [--no-links] [--no-title-keys]
               [--own-writes <file>] [--run-file <file>]

--reply-to posts the text as a threaded reply: the id goes into the POST as Jira's `parentId`, so the comment
sits under the comment it answers instead of starting another flat entry in the list (operator, c16823,
2026-11-03). The target is READ before the write: a comment id that does not exist, or one that belongs
to a different ticket, is refused with nothing posted, so a bad reply can never leave a half-written thread.
The read-back then asserts `parentId` equals the target.

Checks, in order (stop at the first failure, write nothing):
  1. live re-read of the row: status, labels, updated
  2. --reply-to target: the id is parsed before any request; then the comment is read through this ticket, and a
     404 is classified by a bulk read by id, so a target that does not exist or belongs to another ticket is
     refused here, before the POST
  3. other-writer guard: refuse when `updated` is within 60 minutes and the newest comment is not the bot,
     unless --force is given. The clock comes from Jira, never from this host.
  4. duplicate check: refuse when the same normalised text is already one of the last 5 comments (a crash
     retry must not double-post; recover by reading, never by re-running)
Then insert the exact Substrate title after every `<PREFIX>-n` that lacks one (state.db, prefix PM_SB_PREFIX; the
operator's "cite <PREFIX>-n with its title" rule, 2026-11-02), print which titles went in, and refuse when a number
has no single Substrate issue OR when a parenthetical the poster wrote is not that exact title (B451: the check
compares the strings, so a paraphrase is refused and the refusal prints the right title). --no-title-keys keeps the old hard refusal for a caller that authors it itself.
Then: build ADF through jira.adf (mention-capable), append `[agent:<holder> | run:<id> | <utc>]` as the last
paragraph unless the text already ends with a bracket tag, POST, re-read by id and assert:
  - newest comment id == posted id
  - mention nodes == 1 and the FIRST node is a mention, when --mention-first
  - mention nodes == 0 otherwise
  - last paragraph is the agent tag
  - parentId equals the --reply-to target, when it was given
"""
import argparse
import json
import os
os.environ["POST_GUARD_ACTIVE"] = "1"
import pathlib
import re
import subprocess
import sys

JT = os.environ.get("JIRA_HELPER") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "jira.py")
import importlib.util

spec = importlib.util.spec_from_file_location("jt", JT)
J = importlib.util.module_from_spec(spec)
spec.loader.exec_module(J)
pm_config = J.pm_config  # the pack's settings loader, already on the path through jira.py

STALENESS_MINUTES = 60


def stamp():
    return subprocess.run(["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"], capture_output=True, text=True).stdout.strip()



def utc(value):
    """Any Jira timestamp -> 'YYYY-MM-DDTHH:MM:SSZ'. Never print a host-local clock as if it were UTC."""
    from datetime import datetime, timezone
    try:
        t = datetime.fromisoformat(str(value))
    except ValueError:
        return str(value)
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def norm(t):
    return re.sub(r"\s+", " ", (t or "")).strip().lower()



JIRA_PROJECT = re.escape(str(pm_config.get("PM_JIRA_PROJECT", required=True)))
SB_PREFIX = str(pm_config.get("PM_SB_PREFIX", required=True))
SB_KEY = re.escape(SB_PREFIX) + r"-(\d+)"
REPO_SLUG = str(pm_config.get("PM_REPO_SLUG", required=True)).strip("/")
REPO_OWNER = REPO_SLUG.split("/", 1)[0]
JIRA_BASE = str(J.site()) + "/browse/"
# BARE KEYS TOO (coordinator clarification, 2026-11-01T13:52Z): every bare <PROJECT>-<n> in the text becomes an
# inlineCard without needing brackets, and every PR number #<n> becomes its GitHub pull URL on PM_REPO_SLUG. The
# bracketed forms stay supported and are matched first, so [[<PROJECT>-434]] still works and is not double-linked.
LINK_TOKEN = re.compile(r"\[\[(" + JIRA_PROJECT + r"-\d+|url:[^\]]+)\]\]")
BARE_KEY = re.compile(r"\b(" + JIRA_PROJECT + r"-\d{1,6})\b")
BARE_PR = re.compile(r"(?<![\w/#])#(\d{2,5})\b")
# <repo>#<n> for a PR of another repo (coordinator, 2026-11-01T13:53Z): the repo prefix is always written for
# those, so the link can name the right repository. A bare #<n> keeps defaulting to PM_REPO_SLUG.
REPO_PR = re.compile(r"(?<![\w/.-])([A-Za-z][A-Za-z0-9._-]*)#(\d{2,5})\b")


def _known_repos():
    """The repos a <repo>#<n> may name: the real checkouts, not a guess at English.

    HARDENED after the first version linked "pull#123" to .../pull/pull/123 and "e.g.#1202" to .../e.g./pull/1202.
    A permissive pattern asks "does this look like a word before a hash", and prose is full of words. A checkout
    list asks "is this a repository I can name", which is the actual question and cannot be fooled by prose.
    """
    names = set()
    repo_dir = pm_config.path("PM_REPO_DIR")
    base = repo_dir.parent if repo_dir else None  # the sibling checkouts next to the project repo
    try:
        names = {d.lower() for d in os.listdir(base) if os.path.isdir(os.path.join(base, d))} if base else set()
    except OSError:
        pass
    names |= {str(n).lower() for n in (pm_config.get_data("PM_KNOWN_REPOS") or [])}
    names.add(str(pm_config.get("PM_REPO_NAME") or REPO_SLUG.rsplit("/", 1)[-1]).lower())
    return {n for n in names if not n.startswith(".")}


KNOWN_REPOS = _known_repos()
GH_PR = f"https://github.com/{REPO_SLUG}/pull/"


def _nodes(line, linkify=True):
    """One line of text -> ADF inline nodes. [[<PROJECT>-434]] and [[url:https://...]] become inlineCard links.

    Standing rule (sun01-coord, 2026-11-01): every Jira key in a comment is a real link and every PR is a
    link to its GitHub URL. A plain-text pointer makes the reader copy-paste, which is the complaint that
    produced the rule.
    """
    out = []
    for chunk, is_code in _code_spans(line):
        if is_code:
            # A backticked run is inline code, so it is neither linkified nor split: keys and PR numbers inside it
            # stay literal, and the backticks become a `code` mark instead of printing as characters (B454: the
            # guard used to emit "labelled `folded-into:" + a card, so the key vanished from the code span).
            out.append({"type": "text", "text": chunk, "marks": [{"type": "code"}]})
            continue
        pos = 0
        for m in (LINK_TOKEN.finditer(chunk) if linkify else []):
            out.extend(_plain_linked(chunk[pos:m.start()], linkify))
            tok = m.group(1)
            url = tok[len("url:"):] if tok.startswith("url:") else JIRA_BASE + tok
            out.append({"type": "inlineCard", "attrs": {"url": url}})
            pos = m.end()
        out.extend(_plain_linked(chunk[pos:], linkify))
    return out


CODE_SPAN = re.compile(r"`([^`\n]+)`")

def _code_spans(line):
    """(chunk, is_code) pairs for one line: `x` becomes a code chunk, everything else stays linkifiable."""
    pos = 0
    for m in CODE_SPAN.finditer(line):
        if m.start() > pos:
            yield line[pos:m.start()], False
        yield m.group(1), True
        pos = m.end()
    if pos < len(line):
        yield line[pos:], False


def _plain_linked(text, linkify):
    """Plain text -> nodes, turning bare <PROJECT>-<n> and #<pr> into cards between the plain runs.

    A PR number is linked to PM_REPO_SLUG by the standing rule. That is right for this project and wrong for a
    PR from another repo, so a card count is printed on every post and the guard names each URL it created; a
    wrong-repo link is then visible in the output rather than silent in the comment.
    """
    if not linkify:
        return _plain(text)
    out, pos = [], 0
    hits = sorted(list(BARE_KEY.finditer(text)) + list(REPO_PR.finditer(text)) + list(BARE_PR.finditer(text)),
                  key=lambda m: (m.start(), -m.end()))
    last_end = -1
    for m in hits:
        if m.start() < last_end:          # repo#n already consumed this '#n'; never emit two cards for one token
            continue
        out.extend(_plain(text[pos:m.start()]))
        if m.re is BARE_KEY:
            url = JIRA_BASE + m.group(1)
        elif m.re is REPO_PR:
            repo = m.group(1)
            if repo.lower() not in KNOWN_REPOS:
                # Not a repository: leave the token as prose rather than minting a dead link.
                out.extend(_plain(text[m.start():m.end()]))
                pos = m.end()
                last_end = m.end()
                continue
            url = f"https://github.com/{REPO_OWNER}/{repo}/pull/{m.group(2)}"
        else:
            url = GH_PR + m.group(1)
        out.append({"type": "inlineCard", "attrs": {"url": url}})
        pos = m.end()
        last_end = m.end()
    out.extend(_plain(text[pos:]))
    return out


def _plain(text):
    """@operator -> mention node; anything else -> text nodes split on the mention token."""
    nodes = []
    for j, part in enumerate(str(text).split(J.OPERATOR_MENTION)):
        if j:
            nodes.append({"type": "mention", "attrs": {"id": J.operator_account_id(), "text": J.OPERATOR_MENTION_TEXT}})
        if part:
            nodes.append({"type": "text", "text": part})
    return nodes


def prefix_check(text):
    """Refuse text that carries line-number prefixes. c16644 was posted that way on 2026-11-02: the post file
    was built from a numbered read of the draft, so the operator got ' 1 | ...' on every line."""
    bad = [ln for ln in text.splitlines() if re.match(r"^\s*\d+\s*\|\s", ln)]
    if bad:
        print(f"REFUSED: text carries line-number prefixes on {len(bad)} line(s), first {bad[0][:60]!r}; "
              "read the file with cat or python, never with a numbered reader")
        return False
    return True


def _mention_count(body):
    """Mention nodes anywhere in the document. `--mention-first` asserts one of these sits first."""
    return sum(1 for p in body.get("content", []) for n in p.get("content", [])
               if n.get("type") == "mention")


def ensure_mention(body):
    """Put exactly one operator mention at position 0, so `--mention-first` advises instead of only checking.

    The flag used to assert that the caller had already written the token, and a post that forgot it went out silently
    (c16652, 2026-11-02: mention_rule=False on a question the operator was meant to answer). A checker that
    runs after the write is a report, not a guard. Returns True when a node was inserted.
    """
    if _mention_count(body) and body["content"][0]["content"][0].get("type") == "mention":
        return False
    mention = {"type": "mention", "attrs": {"id": J.operator_account_id(), "text": J.OPERATOR_MENTION_TEXT}}
    placed = False
    for para in body.get("content", []):
        kept = [n for n in para.get("content", []) if n.get("type") != "mention"]
        placed = placed or len(kept) != len(para.get("content", []))
        para["content"] = kept
    if placed:
        body["content"][0]["content"].insert(0, mention)
        return True
    if body.get("content") and body["content"][0].get("content"):
        first = body["content"][0]["content"]
        first.insert(0, {"type": "text", "text": " "})
        first.insert(0, mention)
    else:
        body.setdefault("content", []).insert(0, {"type": "paragraph", "content": [mention]})
    return True


STATE_DB = os.environ.get("POST_GUARD_STATE_DB") or os.path.expanduser("~/.xtrm/state.db")

def _parenthetical(text, start):
    """The balanced parenthetical that starts at/after `start` (whitespace allowed), or None.

    A title can contain parentheses of its own ("Volatility HMM on CME trade-date bars (no Sunday stubs)"), so a
    naive "paren then no parens" pattern would truncate it and then refuse a correct citation. Depth-counted.
    """
    i = start
    while i < len(text) and text[i].isspace():
        i += 1
    if i >= len(text) or text[i] != "(":
        return None
    depth, j = 0, i
    while j < len(text):
        if text[j] == "(":
            depth += 1
        elif text[j] == ")":
            depth -= 1
            if depth == 0:
                return text[i + 1:j]
        j += 1
    return None

def substrate_titles(numbers):
    """Exact Substrate titles for <PREFIX>-n, from state.db, read-only.

    The operator's rule is "cite <PREFIX>-n with its title" (B365), so the guard inserts the title instead of making
    every WORD author remember it. A number that is missing or ambiguous is a REFUSAL, never a silent pass: a
    citation the board cannot resolve is worse than a blocked post.
    """
    try:
        import sqlite3
        con = sqlite3.connect(f"file:{STATE_DB}?mode=ro", uri=True)
    except Exception as e:
        return {}, {n: f"state.db unreadable ({type(e).__name__})" for n in numbers}
    out, bad = {}, {}
    try:
        for n in numbers:
            rows = [r[0] for r in con.execute(
                "select i.title from issues i join projects p on p.id = i.project_id "
                "where p.prefix = ? and i.human_number = ?", (SB_PREFIX, int(n)))]
            if len(rows) == 1 and rows[0]:
                out[n] = rows[0]
            else:
                bad[n] = "no such Substrate issue" if not rows else f"{len(rows)} issues share this number"
    finally:
        con.close()
    return out, bad

AGENT_TAG = re.compile(r"\[agent:[^\]]*\]")

def _mask_agent_tags(text):
    """Blank every [agent:...] tag, keeping the offsets, so a tag's own <PREFIX>-n is not read as a citation.

    <PREFIX>-3568 in "[agent:<PREFIX>-3568-board-audit-2]" is a worker name, not a Substrate citation. The first version of
    this check inserted its title INSIDE the tag and shipped "<PREFIX>-3568 (Board audit 2: ...)-board-audit-2" on four
    comments (2026-11-02). Masking keeps the rule about citations and leaves tags alone.
    """
    return AGENT_TAG.sub(lambda m: " " * len(m.group(0)), text)

def untitled_keys(text):
    """(numbers lacking a parenthesised title, masked text) — the masked text carries the same offsets."""
    mask = _mask_agent_tags(text)
    want = []
    for m in re.finditer(SB_KEY, mask):
        if not re.match(r"\s*\([^)]+\)", mask[m.end():m.end() + 200]) and m.group(1) not in want:
            want.append(m.group(1))
    return want, mask

def insert_titles(text):
    """Insert ' (exact title)' after every <PREFIX>-n that lacks one. Returns (text, inserted, want, bad).

    Insertion is followed by the existing assertion below, so the caller still refuses if anything lacks a title:
    the guard inserts and then proves, it never trusts the insertion. A number inside an [agent:...] tag is not a
    citation and is never touched.
    """
    want, mask = untitled_keys(text)
    if not want:
        return text, [], [], [], {}
    titles, bad = substrate_titles(want)
    hits, out, last = [], [], 0
    for m in re.finditer(SB_KEY, mask):
        n = m.group(1)
        if n not in titles or mask[m.end():m.end() + 1] == "(":
            continue
        out.append(text[last:m.end()])
        out.append(f" ({titles[n]})")
        last = m.end()
        hits.append(n)
    out.append(text[last:])
    # A Substrate title can itself contain another <PREFIX> key (one title carried "…follow-on of <PREFIX>-3279").
    # Return the inserted pairs so the caller can neutralise them before the citation assertion scans: otherwise a
    # correct insertion trips the very check it exists to satisfy.
    pairs = [(n, titles[n]) for n in dict.fromkeys(hits)]
    return "".join(out), list(dict.fromkeys(hits)), pairs, want, bad

def build_body(text, linkify=True):
    paragraphs = [p for p in re.split(r"\n\s*\n", text.strip()) if p.strip()]
    content = []
    for para in paragraphs:
        nodes = []
        for i, line in enumerate(para.split("\n")):
            if i:
                nodes.append({"type": "hardBreak"})
            nodes.extend(_nodes(line, linkify))
        content.append({"type": "paragraph", "content": nodes})
    return {"type": "doc", "version": 1, "content": content}


def comment_id(raw):
    """'c16823' or '16823' -> 16823. The project writes comment ids as c<id> in prose, Jira uses the digits.

    isdecimal(), not isdigit(): '²'.isdigit() is True and int('²') raises, so the flag would traceback on input
    it had just accepted. A comment id is an ASCII decimal number.
    """
    digits = str(raw or "").strip().lstrip("cC")
    return int(digits) if digits.isdecimal() else None


def _comment_issue_id(comment):
    """The numeric ticket id a comment belongs to, read from its `self` URL.

    Jira scopes the comment routes by ticket, so the only place a comment says which ticket owns it is
    `.../rest/api/3/issue/<issueId>/comment/<cid>`. That is a fact, not a guess about the id range.
    """
    m = re.search(r"/issue/(\d+)/comment/\d+", str((comment or {}).get("self") or ""))
    return m.group(1) if m else None


def _issue_key(issue_id):
    """The key of a numeric ticket id when it is readable, else None (a refusal must never fail on a nice-to-have)."""
    st, out = J.call("GET", f"/rest/api/3/issue/{issue_id}?fields=status")
    return (out or {}).get("key") if st == 200 and isinstance(out, dict) else None


def verify_reply_target(key, issue_id, cid):
    """(parent_id, None) when `cid` is a comment on this ticket, else (None, reason why not).

    Both refusals happen BEFORE the POST, so a bad --reply-to writes nothing and cannot leave a half-written
    thread. The target is read through this ticket first: that route only answers for a comment on it, so a 200
    with the same id is proof. When it 404s the two failure modes are told apart by POST /rest/api/3/comment/list,
    a bulk READ by id that also works across tickets: parsing Jira's 404 text would depend on the instance's
    locale (this site answers in Italian), and a guard that only understands English prose stops guarding the
    day someone changes a profile setting.
    """
    st, got = J.call("GET", f"/rest/api/3/issue/{key}/comment/{cid}")
    if st == 200 and isinstance(got, dict) and str(got.get("id")) == str(cid):
        owner = _comment_issue_id(got)
        if owner and str(owner) != str(issue_id):
            return None, f"comment {cid} belongs to issue id {owner}, not {key}"
        return cid, None
    st, listed = J.call("POST", "/rest/api/3/comment/list", {"ids": [cid]})
    if st != 200:
        # The bulk read is what separates the two refusals. An unreadable answer is not "no such comment":
        # saying so would tell the caller to check an id that may be perfectly good, and the real fault is a
        # failed read. Refuse on the fact, with both statuses, and write nothing.
        return None, (f"the target read failed (per-ticket read HTTP 404, bulk read HTTP {st}), so comment "
                      f"{cid} cannot be checked; nothing was posted")
    values = (listed or {}).get("values") if isinstance(listed, dict) else None
    if not values:
        return None, f"comment id {cid} does not exist (no readable comment carries that id)"
    owner = _comment_issue_id(values[0])
    other = _issue_key(owner) if owner else None
    if owner and str(owner) != str(issue_id):
        return None, (f"comment id {cid} belongs to {other or 'issue id ' + owner}, not {key}; a reply is threaded "
                      "under a comment of its own ticket")
    return None, f"comment id {cid} is not readable on {key}, so it cannot be replied to"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("key")
    ap.add_argument("text_file")
    ap.add_argument("--mention-first", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-links", action="store_true", help="disable [[<PROJECT>-n]] inlineCard links")
    ap.add_argument("--no-title-keys", action="store_true",
                    help=f"do not insert Substrate titles after {SB_PREFIX}-n; require the text to carry them (old B365)")
    ap.add_argument("--run", metavar="TAG", help="the WORD being applied (B407); required, stamped into "
                                                 "last-run.txt as a record, never read back")
    ap.add_argument("--update", metavar="CID", help="update this lane's own comment in place (PUT) instead of "
                                                    "posting; refused once anyone has replied after it")
    ap.add_argument("--reply-to", metavar="CID",
                    help="post as a threaded reply to this comment id on the same ticket (Jira parentId); assumed "
                         "to be a comment id, c<id> accepted, and refused before any write when it does not exist "
                         "or belongs to another ticket")
    ap.add_argument("--own-writes", metavar="FILE", default=os.environ.get("POST_GUARD_OWN_WRITES"),
                    help="append every posted comment id here so a lane can skip its own writes (env "
                         "POST_GUARD_OWN_WRITES); unset means nothing is recorded")
    ap.add_argument("--run-file", metavar="FILE", default=os.environ.get("POST_GUARD_RUN_FILE"),
                    help="stamp the WORD tag here as a record (env POST_GUARD_RUN_FILE); unset means no record")
    a = ap.parse_args()
    global RUN_FILE, OWN_WRITES
    RUN_FILE, OWN_WRITES = a.run_file, a.own_writes
    if a.reply_to and a.update:
        # A reply is a NEW comment under a parent; an edit rewrites one in place. Asking for both is a caller
        # mistake, and guessing which was meant would post into the wrong place.
        print("REFUSED: --reply-to posts a new threaded reply, --update edits an existing comment; use one or the other")
        return 6
    reply_cid = None
    if a.reply_to is not None:
        # Parse before the first request: a mangled id is a caller mistake, not a question for Jira.
        reply_cid = comment_id(a.reply_to)
        if reply_cid is None:
            print(f"REFUSED --reply-to: {a.reply_to!r} is not a comment id (expected <id> or c<id>); nothing was posted")
            return 10

    text = open(a.text_file, encoding="utf-8").read().strip()
    if not prefix_check(text):
        return 9
    st, iss = J.call("GET", f"/rest/api/3/issue/{a.key}?fields=status,labels,updated")
    if st != 200:
        print(f"REFUSED read failed HTTP {st}")
        return 1
    fields = iss["fields"]
    print(f"live: {a.key} status={fields['status']['name']} updated={fields['updated']} "
          f"labels={len(fields.get('labels') or [])}")

    reply_to = None
    if reply_cid is not None:
        reply_to, why = verify_reply_target(a.key, iss.get("id"), reply_cid)
        if reply_to is None:
            print(f"REFUSED --reply-to: {why}; nothing was posted")
            return 10
        print(f"reply-to: {a.key} comment {reply_to} is a comment on this ticket, read before the write")

    st, cm = J.call("GET", f"/rest/api/3/issue/{a.key}/comment?maxResults=5&orderBy=-created")
    recent = (cm.get("comments") or []) if st == 200 else []
    newest_author = (recent[0]["author"].get("displayName") if recent else "")

    # rename-aware staleness is not possible from Jira alone: the guard's job is to force a human look.
    from datetime import datetime, timezone
    try:
        upd = datetime.fromisoformat(fields["updated"].replace("Z", "+00:00"))
        age_min = (datetime.now(timezone.utc) - upd).total_seconds() / 60
    except Exception:
        age_min = None
    print(f"guard: updated {age_min:.0f} min ago, newest comment by {newest_author!r}" if age_min is not None
          else f"guard: updated age unknown, newest comment by {newest_author!r}")
    if a.update:
        # An edit is the narrowest write this lane has: only its own comment, only before a reply. Both
        # conditions are mechanical, because the intent ('fix my own formatting, nobody answered yet') is
        # exactly the intent a later session will mis-remember.
        st, tc = J.call("GET", f"/rest/api/3/issue/{a.key}/comment/{a.update}")
        if st != 200:
            print(f"REFUSED update: target comment unreadable HTTP {st}")
            return 1
        if (tc.get("author") or {}).get("accountId") != J.my_account_id():
            print(f"REFUSED update: comment {a.update} is not this lane's own")
            return 7
        st, cl = J.call("GET", f"/rest/api/3/issue/{a.key}/comment?maxResults=50&orderBy=-created")
        later = [c for c in ((cl.get("comments") or []) if st == 200 else [])
                 if int(c["id"]) > int(a.update)
                 and (c.get("author") or {}).get("accountId") != J.my_account_id()]
        if later:
            print(f"REFUSED update: {len(later)} reply(ies) after {a.update}, newest {later[0]['id']} by "
                  f"{(later[0].get('author') or {}).get('displayName')!r}; an edit is allowed only while "
                  "nobody has replied")
            return 8
        print(f"update mode: {a.update} is this lane's own comment and no reply follows it")

    if not a.update and not a.force and age_min is not None and age_min < STALENESS_MINUTES and newest_author not in ("", "xtrm-bot"):
        # Print WHAT changed, not only that something changed. On 2026-11-01 this guard fired on a row,
        # I assumed the recent change was the comment I was already answering, forced the write, and posted
        # on top of a brand-new operator question (c16387). A refusal that does not show the reason invites
        # exactly that assumption.
        newest = recent[0] if recent else {}
        body = " ".join(str(n.get("text", "")) for para in (newest.get("body") or {}).get("content", [])
                        for n in para.get("content", []) if n.get("type") == "text")
        print(f"REFUSED other-writer guard: row changed {age_min:.0f} min ago by {newest_author!r}")
        # Jira returned +0100 on one host; slicing the string printed a LOCAL clock as if it were UTC and I
        # quoted it that way on 2026-11-01 (c16393 reported as 06:40Z when it was 05:40Z). Convert, then label.
        print(f"  newest comment {newest.get('id')} at {utc(newest.get('created'))}: {body.strip()[:240]!r}")
        print("  read that comment before deciding; --force is for a change you have READ, never for an "
              "assumption about its age")
        return 2

    body_text = norm(text)
    for c in ([] if a.update else recent):
        flat = norm(" ".join(str(n.get("text", "")) for p in (c.get("body") or {}).get("content", [])
                             for n in p.get("content", []) if n.get("type") == "text"))
        if body_text and body_text[:200] in flat:
            print(f"REFUSED duplicate check: the same text is already comment {c['id']} (crash retry?)")
            return 3

    # Insert the exact Substrate title after every <PREFIX>-n that lacks one (operator rule, B365), then assert below.
    # --no-title-keys keeps the old hard refusal for a caller that wants to author the citation itself.
    if not a.no_title_keys:
        text, inserted, inserted_pairs, want, bad = insert_titles(text)
        if bad:
            for n, why in bad.items():
                print(f"REFUSED: {SB_PREFIX}-{n} has no single Substrate title ({why}), so it cannot be cited")
            return 5
        if inserted:
            print(f"titles: inserted {len(inserted)} Substrate title(s) into parentheses: "
                  + ", ".join(f"{SB_PREFIX}-{n}" for n in inserted))

    # <PREFIX>-n must be followed by ITS title in parentheses, not merely by a parenthetical (operator rule, B365; the
    # equality check is B451). An [agent:...] tag is not a citation. The refusal prints the right title, so the
    # poster can fix the text in one pass instead of guessing.
    _scan = text
    _inserted_keys = {n for n, _t in inserted_pairs}
    for _n, _t in inserted_pairs:
        # equal-length placeholder keeps every offset valid for the positioned _parenthetical() lookup below
        _scan = _scan.replace(f"({_t})", "(" + "_" * max(len(_t) - 2, 1) + ")", 1)
    for m in re.finditer(SB_KEY, _mask_agent_tags(_scan)):
        n = m.group(1)
        if n in _inserted_keys:
            continue  # proved correct by construction two steps above
        cited = _parenthetical(_scan, m.end())
        if cited is None:
            print(f"REFUSED: {SB_PREFIX}-{n} is not followed by its title in parentheses")
            print(f"  found at: ...{text[max(0,m.start()-40):m.end()+60]!r}")
            return 5
        titles, _bad = substrate_titles([n])
        want = titles.get(n)
        if want and " ".join(cited.split()) != " ".join(want.split()):
            print(f"REFUSED: {SB_PREFIX}-{n} carries a parenthetical that is not its Substrate title")
            print(f"  cited:  {cited[:200]!r}")
            print(f"  title:  {want[:200]!r}")
            print("  the parenthetical must be the exact title (or absent, and the guard inserts it); paraphrase "
                  "makes the citation unverifiable")
            return 5

    body = build_body(text, linkify=not a.no_links)
    if a.mention_first and ensure_mention(body):
        print("mention: injected the operator node at position 0 (--mention-first)")
    last = body["content"][-1]["content"][-1].get("text", "") if body["content"] else ""
    if not str(last).strip().startswith("[agent:"):
        holder = os.environ.get("SUBSTRATE_HOLDER") or "<unset>"
        run = run_tag(a.run)
        run = run if run.lower().startswith(("b", "run:")) else f"B{run}"
        print(f"run tag {run} (from --run)")
        body["content"].append({"type": "paragraph",
                                "content": [{"type": "text", "text": f"[agent:{holder} | run:{run} | {stamp()}]"}]})
    if a.dry_run:
        # --dry-run is a preview of a write, so it runs the same credential check the write runs: before this it
        # printed the whole ADF body, credential and all, into the transcript (MMD-3566 F2, SC-03).
        shape = J.secret_shape(json.dumps(body))
        if shape:
            print(f"REFUSED [SC-03] the body would contain something shaped like a credential ({shape[0]}, "
                  f"{shape[1]} characters, value not printed). A Jira comment is visible to every reader of the "
                  "board and cannot be un-shared. Rule: fleet.md:97-103 and jira.py:1-16. Do: remove the value, "
                  "describe it instead, and if the value was already posted, report it to the coordinator as an "
                  "incident rather than editing quietly.")
            return 4
        print("DRY-RUN would post" + (f" (parentId={reply_to})" if reply_to is not None else "") + ":\n"
              + json.dumps(body)[:600])
        return 0
    if a.update:
        st, out = J.call("PUT", f"/rest/api/3/issue/{a.key}/comment/{a.update}", {"body": body})
        cid = str(a.update)
    else:
        payload = {"body": body}
        if reply_to is not None:
            # Jira's comment-create schema takes parentId: the reply hangs under the comment it answers.
            payload["parentId"] = int(reply_to)
        st, out = J.call("POST", f"/rest/api/3/issue/{a.key}/comment", payload)
        cid = (out or {}).get("id") if isinstance(out, dict) else None
    if st >= 300:
        print(f"FAILED {'update' if a.update else 'post'} HTTP {st}: {str(out)[:300]}")
        return 4
    # Record the id so the lane's comment watch does not report this lane's own comment as a board event
    # (2026-11-02: c16644-c16646 were listed as someone else's; the watch only knew the wed2 marker).
    if OWN_WRITES:
        try:
            with open(OWN_WRITES, "a") as fh:
                fh.write(f"{cid}\n")
        except OSError as exc:
            print(f"warning: own-writes record not written: {exc}", file=sys.stderr)
    if a.update or (reply_to is not None and cid):
        # Read the reply by its own id, the way --update does. The comment-LIST read makes the same assumption
        # the mock does (a new post is the newest comment), so a real thread that Jira stored flat would still
        # look right there; a by-id read reports what was stored, parentId included.
        st, got = J.call("GET", f"/rest/api/3/issue/{a.key}/comment/{a.update or cid}")
        got = got if st == 200 else {}
    else:
        st, cm = J.call("GET", f"/rest/api/3/issue/{a.key}/comment?maxResults=1&orderBy=-created")
        got = (cm.get("comments") or [{}])[0]
    gm = [n for p in got.get("body", {}).get("content", []) for n in p.get("content", []) if n.get("type") == "mention"]
    first = got.get("body", {}).get("content", [{}])[0].get("content", [{}])[0]
    lastp = got.get("body", {}).get("content", [{}])[-1].get("content", [{}])[0].get("text", "")
    ok_id = str(got.get("id")) == str(cid)
    ok_ment = (len(gm) >= 1 and (first.get("type") == "mention")) if a.mention_first else (len(gm) == 0)
    ok_tag = str(lastp).strip().startswith("[agent:")
    ok_parent = True
    if reply_to is not None:
        # The write is only half the feature: a POST that carried parentId but a comment Jira stored flat would
        # look correct in this transcript and wrong on the board. Assert the thread on the read-back.
        ok_parent = str(got.get("parentId")) == str(reply_to)
    cards = [n for p in got.get("body", {}).get("content", []) for n in p.get("content", [])
             if n.get("type") == "inlineCard"]
    if LINK_TOKEN.search(text) and not a.no_links:
        ok_links = len(cards) >= len(LINK_TOKEN.findall(text))
    else:
        ok_links = True
    # The defect this guard now catches mechanically: on 2026-11-02 c16644 went out with every line prefixed
    # ' 1 | ', because the post file came from a numbered read. Assert on read-back, not on the input alone.
    flat_paras = ["".join(str(n.get("text", "")) for n in p.get("content", []) if n.get("type") == "text")
                  for p in got.get("body", {}).get("content", [])]
    prefixed = [p for p in flat_paras if re.match(r"^\s*\d+\s*\|\s", p)]
    ok_prefix = not prefixed
    paras = len(flat_paras)
    print(f"  inlineCards={len(cards)} ok_links={ok_links} paragraphs={paras} prefixes={len(prefixed)}")
    if reply_to is not None:
        print(f"  reply: parentId={got.get('parentId')} target={reply_to} ok_parent={ok_parent}")
    print(f"{'UPDATED' if a.update else 'POSTED'} {cid} assertions: id={ok_id} mention_rule={ok_ment} "
          f"tag_last={ok_tag} links={ok_links} no_prefix={ok_prefix}")
    return 0 if (ok_id and ok_ment and ok_tag and ok_links and ok_prefix and ok_parent) else 5


# Optional lane state. Both are records, never inputs: the run tag comes from --run and the own-writes list is
# only read by the lane's comment watch, so a missing file changes nothing here.
RUN_FILE = None      # set in main() from --run-file
OWN_WRITES = None    # set in main() from --own-writes


def run_tag(explicit):
    """The WORD this comment belongs to, taken from the caller and never inherited.

    The tag used to be read from RUN_FILE, which a previous session leaves behind, so on 2026-11-02 the
    B406 comments c16634/c16635 carried `run:B364` from epic-coord-6 (coordinator ruling B408: read the
    tag from the WORD being applied). `--run` is now required and the file is only stamped as a record,
    never read back; a batch that forgets its tag fails here instead of mislabelling the comment.
    """
    if not (explicit or "").strip():
        print("REFUSED: pass --run <WORD> (e.g. --run B407); the run tag is never inherited from a file")
        sys.exit(6)
    tag = explicit.strip()
    if RUN_FILE:
        try:
            pathlib.Path(RUN_FILE).write_text(tag + "\n")
        except OSError as exc:
            print(f"warning: run file not stamped: {exc}", file=sys.stderr)
    return tag


if __name__ == "__main__":
    sys.exit(main())
