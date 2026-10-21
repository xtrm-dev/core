#!/bin/sh
# Fast pre-filter for the service-knowledge Claude Code hooks (XTRM-556).
#
# These hooks fire on EVERY tool call, and a python3 spawn costs ~31 ms on the Mercury
# host before any application code runs (interpreter start + json import) — already over
# the 20 ms per-call budget. This wrapper answers the only question the common path needs
# ("can this payload touch a registered service territory?") in awk, and runs the real hook
# only when the answer is maybe. A proven NO is a no-op, exactly as the hook itself would
# have decided.
#
# SAFETY RULE (XTRM-556 review): this filter may exit 0 ONLY when it can prove, from
# input it has actually verified, that the hook would have produced nothing. Every
# ambiguity defers to the hook. Concretely it defers on:
#   - a key present but not in plain "key": "value" form (escapes, newlines, repeats)
#   - a value or root containing "//", "./" or "../"
#   - CLAUDE_PROJECT_DIR unset, symlinked, or not an ancestor of the payload path
#   - an absolute path outside the root (python may resolve the root differently)
#   - a missing / truncated / partial index, or one whose recorded registry size or
#     pattern count no longer matches the registry it claims to describe
#   - SERVICE_REGISTRY_PATH set (precedence cannot be verified cheaply)
#   - Bash payloads, which carry command matching and the dispatch/promotion gates
#   - no awk on the host
# A stale or untrusted index costs the hook its fast path, never its output.
#
# usage: hook_prefilter.sh <pre|post> <script.py> [args...]
#   pre   -> skill_activator.py semantics (PreToolUse evidence/blocking)
#   post  -> drift_detector.py semantics (PostToolUse drift marker)
set -u

mode=${1:-}
script=${2:-}
if [ -z "$mode" ] || [ -z "$script" ]; then
  printf '%s\n' "usage: $0 <pre|post> <script.py> [args...]" >&2
  exit 0
fi
shift 2

self_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
index=$self_dir/../cache/territory.index
root=${CLAUDE_PROJECT_DIR:-}

# The payload is held in a shell variable rather than a temp file: a temp file leaks the
# full tool payload at a predictable path, survives `exec` (which skips the EXIT trap),
# and is a symlink target. A variable has none of those problems.
payload=$(cat)
run_hook() { printf '%s' "$payload" | python3 "$self_dir/$script" "$@"; }

# No awk -> the hook stays authoritative.
command -v awk >/dev/null 2>&1 || { run_hook "$@"; exit $?; }
[ -f "$index" ] || { run_hook "$@"; exit $?; }

# SERVICE_REGISTRY_PATH overrides the registry the hook would read, and we cannot verify
# which file that resolves to without redoing the precedence search in shell.
[ -n "${SERVICE_REGISTRY_PATH:-}" ] && { run_hook "$@"; exit $?; }

# Index header: <registry_path> <registry_size> <pattern_count> <cksum>. Read with the
# builtin so this costs no process.
registry=""; idx_size=""; idx_count=""; idx_digest=""
IFS=' ' read -r registry idx_size idx_count idx_digest < "$index" 2>/dev/null || true
case ${idx_count:-} in ''|*[!0-9]*) { run_hook "$@"; exit $?; } ;; esac
[ -n "$registry" ] && [ -f "$registry" ] || { run_hook "$@"; exit $?; }
case ${idx_size:-} in ''|*[!0-9]*) { run_hook "$@"; exit $?; } ;; esac

# Freshness is keyed on CONTENT, not on metadata. Size and mtime are both defeated by
# `cp -p` / `rsync -t` / `tar`, and a same-length edit (docs/** -> newd/**) defeats the
# size check on its own. cksum of a registry-sized file costs about a millisecond, and
# correctness is not negotiable against latency here.
reg_size=$(wc -c < "$registry" 2>/dev/null)
# Numeric compare, so wc's possible leading whitespace does not matter.
[ "${reg_size:-0}" -eq "${idx_size:-1}" ] 2>/dev/null || { run_hook "$@"; exit $?; }
[ "$index" -nt "$registry" ] || { run_hook "$@"; exit $?; }

case ${idx_digest:-} in ''|*[!0-9]*) { run_hook "$@"; exit $?; } ;; esac
command -v cksum >/dev/null 2>&1 || { run_hook "$@"; exit $?; }
reg_digest=$(cksum < "$registry" 2>/dev/null)
reg_digest=${reg_digest%% *}
[ -n "$reg_digest" ] && [ "$reg_digest" = "$idx_digest" ] || { run_hook "$@"; exit $?; }

# Re-walk the precedence ladder bootstrap.get_registry_path() uses and confirm it still
# resolves to the registry this index was built from. A registry that outranks ours but
# did not exist at build time (a new umbrella-owned pack, say) would silently win in the
# hook while the index kept describing the old one. Shell globbing costs no process.
[ -n "$root" ] || { run_hook "$@"; exit $?; }
resolved=""
for candidate in \
    "$root"/.xtrm/skills/*/service-knowledge/service-registry.json \
    "$root"/.xtrm/skills/*/service-skills/service-registry.json \
    "$root"/.xtrm/skills/*/service-registry.json; do
  [ -e "$candidate" ] || continue
  resolved=$candidate
  break
done
if [ -z "$resolved" ] && [ -e "$root/service-registry.json" ]; then
  resolved=$root/service-registry.json
fi
if [ -z "$resolved" ] && [ -e "$root/.claude/skills/service-registry.json" ]; then
  resolved=$root/.claude/skills/service-registry.json
fi
[ -n "$resolved" ] && [ "$resolved" = "$registry" ] || { run_hook "$@"; exit $?; }

# awk prints GO when the hook must run, NO only on a proven miss. Anything else
# (including an awk error) falls through to the hook.
verdict=$(printf '%s' "$payload" | awk -v MODE="$mode" -v ROOT="$root" \
  -v IDX="$index" -v IDXCOUNT="$idx_count" '
function startswith(s, p) { return substr(s, 1, length(p)) == p }
function rtrim(s) { sub(/\/+$/, "", s); return s }
function countocc(s, t,   n) { n = 0; while ((p = index(s, t)) > 0) { n++; s = substr(s, p + length(t)) } return n }

# NOTE: mawk index() takes no start offset (unlike gawk), so walk manually.
# NOTE: no apostrophes anywhere in this awk program - it lives inside shell single quotes.

# fnmatch.translate for the subset we decide on: literals, * and ?. Callers must refuse
# any pattern containing [ or ] (character classes) instead of approximating them.
function fn2re(p,   out, i, ch, n) {
  out = "^"; n = length(p)
  for (i = 1; i <= n; i++) {
    ch = substr(p, i, 1)
    if (ch == "*") out = out ".*"
    else if (ch == "?") out = out "."
    else if (ch == "\\" || ch == "]" || ch == "[" || ch == "^" || ch == "$" || ch == "." ||
             ch == "|" || ch == "(" || ch == ")" || ch == "+" || ch == "{" || ch == "}")
      out = out "\\" ch
    else out = out ch
  }
  return out "$"
}
# Python: pattern.split("/*")[0].split("/**")[0]
function patbase(p,   i, t) {
  t = p
  i = index(t, "/*"); if (i > 0) t = substr(t, 1, i - 1)
  i = index(t, "/**"); if (i > 0) t = substr(t, 1, i - 1)
  return t
}
# Literal text before the first wildcard; pathlib.glob only ever matches below it.
function litprefix(p,   i, j) {
  i = index(p, "*")
  j = index(p, "?"); if (j > 0 && (i == 0 || j < i)) i = j
  j = index(p, "["); if (j > 0 && (i == 0 || j < i)) i = j
  return i == 0 ? p : substr(p, 1, i - 1)
}
# Port of skill_activator.match_territory for one pattern. 1 = match, 0 = no.
function terr(rel, p,   first, prefix, suffix, rel_check, base) {
  if (index(p, "[") > 0 || index(p, "]") > 0) return -1
  if (index(p, "**") > 0) {
    if (countocc(p, "**/") == 1) {
      first = index(p, "**/")
      prefix = substr(p, 1, first - 1)
      suffix = substr(p, first + 3)
      rel_check = startswith(rel, prefix) ? substr(rel, length(prefix) + 1) : rel
      if (rel_check ~ fn2re(suffix)) return 1
      if (rel ~ fn2re(prefix "*/" suffix)) return 1
      if (prefix != "" && startswith(rel, rtrim(prefix))) return 1
    }
  } else if (rel ~ fn2re(p)) return 1
  base = patbase(p)
  if (base != "" && (rel == base || startswith(rel, base "/"))) return 1
  return 0
}

# Strict extraction. Returns the value in V when the key appears exactly once in plain
# "key": "value" form with no escapes; otherwise sets AMBIGUOUS and returns "".
# A key that is present but escaped / split across lines / repeated is AMBIGUOUS, because
# guessing would risk deciding NO for a payload the hook would have acted on.
V = ""; AMBIGUOUS = 0
function extract(buf, key,   plain, present, cnt, s) {
  V = ""; AMBIGUOUS = 0
  present = "\"" key "\""
  cnt = countocc(buf, present)
  if (cnt == 0) return ""
  if (cnt > 1) { AMBIGUOUS = 1; return "" }
  plain = "\"" key "\"[ \t]*:[ \t]*\"[^\"\\\\]*\""
  if (match(buf, plain) == 0) { AMBIGUOUS = 1; return "" }
  s = substr(buf, RSTART, RLENGTH)
  sub("^\"" key "\"[ \t]*:[ \t]*\"", "", s)
  sub("\"$", "", s)
  V = s
  return s
}
function ambiguous() { print "GO"; exit 0 }

BEGIN {
  # --- index integrity -------------------------------------------------------
  # Line 1 is the header, the last line is an end marker naming the pattern count.
  # A truncated or partial index fails here and defers.
  if ((getline hdr < IDX) <= 0) { print "GO"; exit }
  close(IDX)
  lines = 0
  while ((getline line < IDX) > 0) {
    n++
    if (n == 1) first = line
    else if (substr(line, 1, 5) == "#end ") { sentinel = substr(line, 6); last = n }
    else if (line != "") { pat[++np] = line }
  }
  close(IDX)
  total = n
  if (np != IDXCOUNT + 0) { print "GO"; exit }
  if (sentinel != IDXCOUNT + 0) { print "GO"; exit }
  if (first != hdr) { print "GO"; exit }
}

{ buf = buf $0 "\n" }

END {
  if (np == 0) { print "GO"; exit }

  tool = extract(buf, "tool_name")
  # Bash carries command matching plus the dispatch and promotion gates; the activator
  # must always see it.
  if (MODE == "pre" && index(tool, "Bash") > 0) { print "GO"; exit }

  fp = extract(buf, "file_path")
  if (MODE == "pre") {
    # The activator resolves file_path -> path -> notebook_path.
    if (fp == "" && !AMBIGUOUS) fp = extract(buf, "path")
    if (fp == "" && !AMBIGUOUS) fp = extract(buf, "notebook_path")
    # No path at all: the activator feeds that value only into `if file_path:`, so match
    # stays None and it exits 0. A key we could not read in plain form is NOT that case.
    if (fp == "") { if (AMBIGUOUS) print "GO"; exit }
  } else {
    # check-hook reads tool_input.file_path and nothing else.
    if (fp == "") { if (AMBIGUOUS) print "GO"; exit }
  }

  # --- path normalisation ----------------------------------------------------
  # Anything python would normalise differently than we do, or that we cannot attribute
  # to the project root, defers rather than guessing.
  if (index(fp, "\\") > 0) { print "GO"; exit }
  if (index(fp, "//") > 0) { print "GO"; exit }
  if (index(fp, "/./") > 0 || index(fp, "/../") > 0) { print "GO"; exit }
  if (fp == ".." || substr(fp, 1, 3) == "../") { print "GO"; exit }
  if (fp == "." || substr(fp, 1, 2) == "./") { print "GO"; exit }

  # pathlib strips trailing slashes, and fnmatch "*" crosses "/", so "a/b/x.tsx/"
  # normalises to "a/b/x.tsx" and matches "*.tsx". Match pathlib exactly.
  while (length(fp) > 1 && substr(fp, length(fp), 1) == "/") fp = substr(fp, 1, length(fp) - 1)
  if (fp == "") { print "GO"; exit }

  rel = fp
  if (substr(fp, 1, 1) == "/") {
    # An absolute payload is only decidable when the root is known, clean, and really
    # an ancestor. python falls back to git when CLAUDE_PROJECT_DIR is unset, and it
    # resolves symlinks differently, so those cases defer.
    if (ROOT == "") { print "GO"; exit }
    nr = rtrim(ROOT)
    if (nr == "") { print "GO"; exit }
    if (fp == nr) { print "GO"; exit }              # rel would be "." — no territory owns it
    if (!startswith(fp, nr "/")) { print "GO"; exit } # root is not an ancestor: python may disagree
    rel = substr(fp, length(nr) + 2)
  }

  if (MODE == "post") {
    # find_service_for_path: pathlib.glob equality below the pattern literal prefix,
    # plus a base-prefix test against the raw input string.
    for (i = 1; i <= np; i++) {
      p = pat[i]
      base = patbase(p)
      if (base != "" && (fp == base || startswith(fp, base "/"))) { possible = 1; break }
      lp = litprefix(p)
      if (lp == "") {
        # A leading wildcard leaves no mandatory prefix. With no "/" in the pattern
        # pathlib can only glob the root entry, so the basename test is exact.
        if (index(p, "/") == 0) {
          if (index(rel, "/") == 0 && rel ~ fn2re(p)) { possible = 1; break }
        } else {
          possible = 1; break      # undecidable without full glob semantics
        }
      } else if (startswith(rel, lp)) {
        possible = 1; break
      }
    }
  } else {
    for (i = 1; i <= np; i++) {
      r = terr(rel, pat[i])
      if (r != 0) { possible = 1; break }
    }
  }

  if (possible) print "GO"
  else print "NO"
}
')

case $verdict in
NO) exit 0 ;;
*) printf '%s' "$payload" | python3 "$self_dir/$script" "$@" ;;
esac