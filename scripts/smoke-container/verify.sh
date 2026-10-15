#!/usr/bin/env bash
# xtrm trio pre/post-release smoke test. Exit 0 = PASS, nonzero = FAIL.
# See README.md. Runs inside the container built from ./Dockerfile.
set -uo pipefail

# --- repos under test -------------------------------------------------------
# name|clone url|npm package (package is what --branch installs from source)
REPOS=(
  "core|https://github.com/xtrm-dev/core.git|xtrm-tools"
  "specialists|https://github.com/xtrm-dev/specialists.git|@jaggerxtrm/specialists"
  "xtmux|https://github.com/Jaggerxtrm/xtmux.git|@jaggerxtrm/xtmux"
)

BRANCH_ALL=""
declare -A BRANCH_FOR=()
KEEP=0
SKIP_LIVE=0
TAG=latest
# XTRM_SMOKE_FAULT names a single fault to inject just before the global-surface
# assertions. Used to prove each new check catches its target. Values:
#   broken-claude-skills   dangling ~/.claude/skills symlink
#   broken-pi-skills       dangling ~/.pi/agent/skills symlink
#   missing-new-instance   drop --new-instance from the xtmux SessionStart hook
#   duplicate-hook         append a duplicate xtmux SessionStart entry
#   untagged-agent-state   append an untagged agent-state.sh entry (bead 4.27)
#   removed-pi-package     drop a package from ~/.pi/agent/settings.json
#   removed-specialists    delete a specialist definition file
FAULT="${XTRM_SMOKE_FAULT:-}"

usage() {
  cat <<'EOF'
usage: ./verify.sh [options]

  --branch <ref>            test <ref> in every repo that has it (checkout + install from source)
  --branch <repo>=<ref>     test <ref> in one repo only (repo: core|specialists|xtmux); repeatable
  --tag <dist-tag>          npm dist-tag installed and updated to in every stage (default: latest)
  --skip-live               skip the stage-5 tmux/sp live scenario
  --keep                    keep the work directory on exit
  -h, --help                this text

exit 0 = PASS; nonzero = FAIL, and the failing stage is named in the summary.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --branch)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      if [[ "$2" == *=* ]]; then BRANCH_FOR["${2%%=*}"]="${2#*=}"; else BRANCH_ALL="$2"; fi
      shift 2 ;;
    --tag) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; TAG="$2"; shift 2 ;;
    --skip-live) SKIP_LIVE=1; shift ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

WORK="$(mktemp -d /tmp/xtrm-smoke.XXXXXX)"
LOG="$WORK/commands.log"
: > "$LOG"
cleanup() { [ "$KEEP" -eq 1 ] && printf '\nwork dir kept: %s\n' "$WORK" || rm -rf "$WORK"; }
trap cleanup EXIT

FAILED=0 WARNED=0 SKIPPED=0 STAGE="0-init" FIRST_FAIL=""

stage() { STAGE="$1"; printf '\n=== STAGE %s ===\n' "$1"; printf '\n##### stage %s\n' "$1" >>"$LOG"; }
ok()    { printf '  [OK]   %s\n' "$1"; }
warn()  { WARNED=$((WARNED + 1)); printf '  [WARN] %s\n' "$1"; }
skip()  { SKIPPED=$((SKIPPED + 1)); printf '  [SKIP] %s\n' "$1"; }
fail()  {
  FAILED=$((FAILED + 1))
  [ -n "$FIRST_FAIL" ] || FIRST_FAIL="$STAGE: $1"
  printf '  [FAIL] %s\n' "$1"
}

# run <desc> <cmd...> — command output goes to the log, not the report.
run() {
  local desc="$1"; shift
  printf '\n$ %s\n' "$*" >>"$LOG"
  if "$@" >>"$LOG" 2>&1; then ok "$desc"; return 0; fi
  fail "$desc (tail of $LOG below)"
  tail -20 "$LOG" | sed 's/^/         /'
  return 1
}

# run_in <dir> <desc> <cmd...> — same, in another directory. Only the command
# runs in a subshell; ok/fail stay in this shell, so a failure still reaches
# FAILED and the exit code. `( cd … && run … )` would lose both.
run_in() {
  local dir="$1" desc="$2"; shift 2
  printf '\n$ (in %s) %s\n' "$dir" "$*" >>"$LOG"
  if ( cd "$dir" && "$@" ) >>"$LOG" 2>&1; then ok "$desc"; return 0; fi
  fail "$desc (tail of $LOG below)"
  tail -20 "$LOG" | sed 's/^/         /'
  return 1
}

field() { grep "^$1=" "$2" 2>/dev/null | cut -d= -f2-; }

# expect_ge <label> <actual> <floor>
expect_ge() {
  if [ "${2:-x}" != "x" ] && [ "$2" -ge "$3" ] 2>/dev/null; then
    ok "$1 = $2 (>= $3)"
  else
    fail "$1 = ${2:-<missing>}, expected >= $3"
  fi
}

expect_eq() {
  if [ "${2:-x}" = "$3" ]; then ok "$1 = $2"; else fail "$1 = ${2:-<missing>}, expected $3"; fi
}

# --- xtmux install needs a musl-capable bun --------------------------------
xtmux_root() { printf '%s/@jaggerxtrm/xtmux' "$(npm root -g)"; }

# Not `command -v bun`: npm relinks /usr/local/bin/bun to the glibc placeholder
# from xtmux's own `bun` dependency, so PATH lookup can point at the broken one.
MUSL_BUN="${XTRM_SMOKE_BUN:-/opt/bun/bin/bun}"

# The bun npm package that xtmux depends on ships a glibc bun.exe. On musl it is
# ENOEXEC, which fails xtmux's postinstall (and xtmux-obs at runtime). Overwrite
# it with the container's musl bun. Must run AFTER any npm install that would
# restore the package's node_modules.
# cp, not install(1): @jaggerxtrm/specialists ships a global `install` bin that
# shadows coreutils on PATH once it is installed globally (see the shadowing
# check in stage 5).
patch_bundled_bun() {
  local target; target="$(xtmux_root)/node_modules/bun/bin/bun.exe"
  [ -d "$(dirname "$target")" ] || return 1
  cp -f "$MUSL_BUN" "$target" && chmod 0755 "$target"
}

install_xtmux() {
  local spec="$1"
  printf '\n$ npm i -g %s\n' "$spec" >>"$LOG"
  if npm i -g "$spec" >>"$LOG" 2>&1 && xtmux-obs --help >>"$LOG" 2>&1; then
    ok "npm i -g $spec"
    return 0
  fi
  warn "npm i -g $spec needed the musl bun shim (bundled bun.exe is a glibc binary — Alpine/musl install path is not clean upstream)"
  npm i -g --ignore-scripts "$spec" >>"$LOG" 2>&1 || { fail "npm i -g --ignore-scripts $spec"; return 1; }
  patch_bundled_bun
  # Bare invocation, NOT --from-npm: that flag is the postinstall marker and
  # makes the installer exit 0 without doing anything unless npm_config_global
  # is set (install.mjs:18). Here we NEED it to run — the --ignore-scripts
  # install above deliberately skipped the postinstall (xtrm-9hq6w).
  node "$(xtmux_root)/scripts/install.mjs" >>"$LOG" 2>&1 || { fail "xtmux install.mjs"; return 1; }
  patch_bundled_bun || { fail "could not place musl bun in $(xtmux_root)/node_modules/bun/bin"; return 1; }
  run "xtmux-obs runs after musl bun shim" xtmux-obs --help
}

# install_from_source <name> <dir> <pkg> — pack the checked-out ref and install
# it globally. --ignore-scripts keeps prepublish gates (which need
# devDependencies) out of the smoke path; cli/dist is tracked so the packed
# tarball is complete.
install_from_source() {
  local name="$1" dir="$2" pkg="$3" tarball
  tarball="$(cd "$dir" && npm pack --ignore-scripts --silent 2>>"$LOG" | tail -1)"
  if [ -z "$tarball" ] || [ ! -f "$dir/$tarball" ]; then
    fail "$name: npm pack produced no tarball"
    return 1
  fi
  if [ "$pkg" = "@jaggerxtrm/xtmux" ]; then
    install_xtmux "$dir/$tarball"
  else
    run "install $name from source ($tarball)" npm i -g "$dir/$tarball"
  fi
}

# registry_parity <repo dir> — every file the registry declares must exist under
# its group's source_dir. Prints "total/missing/mismatch"; mismatch is recorded
# but only reported, because a source clone can legitimately sit ahead of the
# released registry's hashes.
registry_parity() {
  local dir="$1"
  local reg="$dir/.xtrm/registry.json"
  [ -f "$reg" ] || { printf '0/0/0'; return; }
  local total=0 missing=0 mismatch=0 path hash
  while IFS='|' read -r path hash; do
    [ -n "$path" ] || continue
    total=$((total + 1))
    if [ ! -f "$dir/$path" ]; then
      missing=$((missing + 1))
      continue
    fi
    [ "$(sha256sum "$dir/$path" | cut -d' ' -f1)" = "$hash" ] || mismatch=$((mismatch + 1))
  done < <(jq -r '.assets | to_entries[] | .value as $g
                  | ($g.files // {}) | to_entries[]
                  | "\($g.source_dir)/\(.key)|\(.value.hash)"' "$reg" 2>/dev/null)
  printf '%s/%s/%s' "$total" "$missing" "$mismatch"
}

# --- global-surface helpers ------------------------------------------------
# Everything the trio installs into $HOME. This is the surface the container
# used to ignore entirely — bead xtrm-wiy5n.4.32.

CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CLAUDE_SKILLS_LINK="$HOME/.claude/skills"
PI_SKILLS_LINK="$HOME/.pi/agent/skills"
PI_SETTINGS="$HOME/.pi/agent/settings.json"
SKILLS_DEFAULT_TARGET="$HOME/.xtrm/skills/default"

# resolve <path> — canonicalise a symlink (or file/dir) target; empty if broken.
resolve() { readlink -f -- "$1" 2>/dev/null || true; }

# jq_count <expr> <file> — count JSON hits without piping fragile grep chains.
jq_count() {
  local expr="$1" file="$2"
  [ -f "$file" ] || { printf 0; return; }
  jq -r "$expr" "$file" 2>/dev/null || printf 0
}

# check_symlink_target <label> <link> <expected>
check_symlink_target() {
  local label="$1" link="$2" expected="$3"
  if [ ! -L "$link" ]; then
    fail "$label: $link is not a symlink"
    return
  fi
  local actual; actual="$(resolve "$link")"
  local expected_resolved; expected_resolved="$(resolve "$expected")"
  if [ -z "$actual" ] || [ ! -e "$actual" ]; then
    fail "$label: $link resolves to <broken> (readlink: $(readlink -- "$link" 2>/dev/null))"
    return
  fi
  if [ "$actual" = "$expected_resolved" ]; then
    ok "$label: $link → $actual"
  else
    fail "$label: $link → $actual, expected $expected_resolved"
  fi
}

# --- global-surface fault injection ----------------------------------------
# Called just before global assertions to prove each check catches its target.
# Each fault MUST make one of the checks below trip.

inject_broken_claude_skills() {
  rm -rf -- "$CLAUDE_SKILLS_LINK"
  ln -s /nonexistent/xtrm-fault-target "$CLAUDE_SKILLS_LINK"
  warn "fault injected: $CLAUDE_SKILLS_LINK now points at /nonexistent/xtrm-fault-target"
}
inject_broken_pi_skills() {
  rm -rf -- "$PI_SKILLS_LINK"
  ln -s /nonexistent/xtrm-fault-target "$PI_SKILLS_LINK"
  warn "fault injected: $PI_SKILLS_LINK now points at /nonexistent/xtrm-fault-target"
}
inject_missing_new_instance() {
  local tmp="$CLAUDE_SETTINGS.fault-tmp"
  jq '(.hooks.SessionStart // []) |= (map(
        if (.hooks // []) | any(.command // "" | contains("agent-state.sh"))
        then . + {hooks: ([.hooks[] | .command |= gsub(" --new-instance"; "")])}
        else . end
      ))' "$CLAUDE_SETTINGS" > "$tmp" && mv "$tmp" "$CLAUDE_SETTINGS"
  warn "fault injected: stripped --new-instance from every SessionStart agent-state.sh entry"
}
inject_duplicate_hook() {
  local tmp="$CLAUDE_SETTINGS.fault-tmp"
  jq '(.hooks.SessionStart // []) |= (
        . + [([.[] | select((.hooks // []) | any(.command // "" | contains("agent-state.sh")))] | .[0])]
      )' "$CLAUDE_SETTINGS" > "$tmp" && mv "$tmp" "$CLAUDE_SETTINGS"
  warn "fault injected: appended a duplicate SessionStart xtmux entry"
}
inject_untagged_agent_state() {
  local tmp="$CLAUDE_SETTINGS.fault-tmp"
  # Copy an existing xtmux entry, strip its _source/_xtmux tags. Nothing else
  # in this file uses agent-state.sh, so a positive match here is the fault.
  jq '(.hooks.SessionStart // []) |= (
        . + [
          ([.[] | select((.hooks // []) | any(.command // "" | contains("agent-state.sh")))] | .[0])
          | del(._source, ._xtmux)
        ]
      )' "$CLAUDE_SETTINGS" > "$tmp" && mv "$tmp" "$CLAUDE_SETTINGS"
  warn "fault injected: appended an untagged agent-state.sh SessionStart entry"
}
inject_removed_pi_package() {
  local tmp="$PI_SETTINGS.fault-tmp"
  jq '.packages = (.packages // []) | .packages |= (if length > 0 then .[1:] else . end)' \
    "$PI_SETTINGS" > "$tmp" && mv "$tmp" "$PI_SETTINGS"
  warn "fault injected: dropped the first package from $PI_SETTINGS"
}
inject_removed_specialists() {
  local sp_dir; sp_dir="$(specialists_config_dir)"
  # Delete a canonical specialist the release contract depends on, not the
  # alphabetically-first template. A blunt count check floors far below the
  # real number and wouldn't notice one file missing; the per-name check
  # below is what catches this.
  local victim="$sp_dir/executor.specialist.json"
  [ -f "$victim" ] && rm -f -- "$victim" \
    && warn "fault injected: removed $(basename "$victim")"
}

apply_fault() {
  case "$1" in
    "")                       return 0 ;;
    broken-claude-skills)     inject_broken_claude_skills ;;
    broken-pi-skills)         inject_broken_pi_skills ;;
    missing-new-instance)     inject_missing_new_instance ;;
    duplicate-hook)           inject_duplicate_hook ;;
    untagged-agent-state)     inject_untagged_agent_state ;;
    removed-pi-package)       inject_removed_pi_package ;;
    removed-specialists)      inject_removed_specialists ;;
    *) fail "unknown XTRM_SMOKE_FAULT: $1"; return 1 ;;
  esac
}

# specialists_config_dir — where the installed package keeps its .specialist.json
# files. Read from `npm root -g` (single global path in this image), matches
# what `sp` loads. If neither structure is present the check downstream fails.
specialists_config_dir() {
  local root; root="$(npm root -g 2>/dev/null)"
  printf '%s/@jaggerxtrm/specialists/config/specialists' "${root:-/usr/local/lib/node_modules}"
}

# global_drift_and_repair — mirror the project drift+repair from stage 4 on the
# global install surface. Break each target xt update --apply is documented to
# own, then re-run the same command and assert the repair. Skipped when a
# specific fault is under test (that path needs the break to persist).
global_drift_and_repair() {
  # 1. Both global skill pointers. xt update --apply calls
  # ensureUserAgentsSkillsSymlink({force:true}) at cli/src/commands/update.ts:112
  # which is exactly what should repair this.
  rm -rf -- "$CLAUDE_SKILLS_LINK" "$PI_SKILLS_LINK"
  ln -s /nonexistent/xtrm-drift "$CLAUDE_SKILLS_LINK"
  ln -s /nonexistent/xtrm-drift "$PI_SKILLS_LINK"
  ok "drift: broke $CLAUDE_SKILLS_LINK and $PI_SKILLS_LINK"

  # 2. Global settings.json hook argument. Only the xtmux installer owns this
  # file, so trigger its repair path via re-install below.
  if [ -f "$CLAUDE_SETTINGS" ]; then
    inject_missing_new_instance
  fi

  # Re-run xt update (repairs the pointers) and xtmux install (repairs the
  # hooks). Both are idempotent and cheap. For xtmux the repair invokes the
  # ALREADY-INSTALLED install.mjs so a `--branch xtmux=<ref>` build survives
  # into stage 5 — reinstalling from @TAG here would silently overwrite the
  # branch-built candidate with the published tag (Codex #522: line 334).
  run_in "$SCRATCH" "xt update --apply (drift repair)" \
    env XTRM_GLOBAL_HOOKS=1 xt update --apply --repo .
  local xtmux_installer; xtmux_installer="$(xtmux_root)/scripts/install.mjs"
  if [ -f "$xtmux_installer" ]; then
    patch_bundled_bun
    # Bare invocation, NOT --from-npm — see install_xtmux above. Passing the
    # postinstall marker here silently no-opped the repair, so the gate
    # measured drift that was never repaired (xtrm-9hq6w, Codex xtmux#88).
    run "xtmux install.mjs (drift repair, in-place)" \
      node "$xtmux_installer"
  else
    fail "xtmux install.mjs missing at $xtmux_installer — cannot repair global hooks"
  fi

  # Assert repair. FAIL is deliberate — if xt/xtmux stopped restoring these,
  # the release gate should surface it. `check_symlink_target` records its own
  # ok/fail lines, so no extra chatter here.
  check_symlink_target "drift-repair: claude skills"   "$CLAUDE_SKILLS_LINK" "$SKILLS_DEFAULT_TARGET"
  check_symlink_target "drift-repair: pi agent skills" "$PI_SKILLS_LINK"     "$SKILLS_DEFAULT_TARGET"
  if [ -f "$CLAUDE_SETTINGS" ]; then
    local stripped
    stripped="$(jq_count '[.hooks.SessionStart // [] | .[]
                          | select((.hooks // []) | any(.command // "" | contains("agent-state.sh")))
                          | .hooks[] | select(.command // "" | contains("agent-state.sh") and (contains("--new-instance") | not))] | length' \
                "$CLAUDE_SETTINGS")"
    expect_eq "drift-repair: SessionStart entries missing --new-instance" "$stripped" 0
  fi
}

# check_global_surface — the assertions bead xtrm-wiy5n.4.32 requires. Runs
# after any drift-repair AND after any XTRM_SMOKE_FAULT injection, so a
# proof-run breaks exactly the surface the assertion below covers.
check_global_surface() {
  printf '  --- global surface (~/.claude, ~/.pi, specialists)\n'

  # 1. Symlinks: resolve targets, do not count. A count would pass a dangling link.
  check_symlink_target "claude skills pointer"   "$CLAUDE_SKILLS_LINK" "$SKILLS_DEFAULT_TARGET"
  check_symlink_target "pi agent skills pointer" "$PI_SKILLS_LINK"     "$SKILLS_DEFAULT_TARGET"

  # 2. Global settings.json — event coverage, hook ARGUMENTS, no duplicates.
  if [ ! -f "$CLAUDE_SETTINGS" ]; then
    fail "$CLAUDE_SETTINGS missing (xtmux install did not write it)"
  else
    # Event coverage: xtmux install writes eight named events. An aggregate
    # count would still pass if one whole category disappeared and another had
    # extra entries — Codex #522: line 369. Check each event by name.
    for ev in SessionStart UserPromptSubmit PreToolUse Notification \
              PostToolUse Stop SubagentStop SessionEnd; do
      local ev_count
      ev_count="$(jq -r --arg ev "$ev" \
        '[.hooks[$ev] // [] | .[] | select(._source == "xtmux")] | length' \
        "$CLAUDE_SETTINGS" 2>/dev/null || printf 0)"
      expect_ge "claude settings: xtmux $ev entries" "$ev_count" 1
    done

    # ARGUMENT check (bead 4.25): every SessionStart agent-state.sh entry must
    # carry --new-instance. A count of entries with the flag missing == 0.
    local missing_flag
    missing_flag="$(jq_count '[.hooks.SessionStart // [] | .[]
                              | (.hooks // []) | .[] | .command // ""
                              | select(contains("agent-state.sh") and (contains("--new-instance") | not))] | length' \
                    "$CLAUDE_SETTINGS")"
    expect_eq "claude settings: SessionStart entries missing --new-instance" "$missing_flag" 0

    # DUPLICATE check (bead 4.27): no two SessionStart xtmux entries share the
    # same command string. A raw count would not see the shape, so group by
    # command and pick groups of size > 1.
    local dupes
    dupes="$(jq_count '[.hooks | to_entries[] as $ev
                       | $ev.value // []
                       | map(select((.hooks // []) | any(.command // "" | contains("agent-state.sh")))
                             | (.hooks // []) | map(.command // "") | join(""))
                       | group_by(.) | map(select(length > 1)) | length] | add // 0' \
             "$CLAUDE_SETTINGS")"
    expect_eq "claude settings: duplicate agent-state.sh entries per event" "$dupes" 0

    # UNTAGGED check (bead 4.27): every agent-state.sh entry must carry an
    # ownership tag. An untagged entry survives every remove-then-write cycle.
    local untagged
    untagged="$(jq_count '[.hooks | to_entries[] | .value[]
                          | select((.hooks // []) | any(.command // "" | contains("agent-state.sh")))
                          | select((._source // "") == "")] | length' \
                 "$CLAUDE_SETTINGS")"
    expect_eq "claude settings: untagged agent-state.sh entries" "$untagged" 0
  fi

  # 3. ~/.pi/agent/settings.json — has hooks and the xtmux package installed.
  if [ ! -f "$PI_SETTINGS" ]; then
    fail "$PI_SETTINGS missing (xtmux install did not write it)"
  else
    local pi_pkg_hits
    pi_pkg_hits="$(jq_count '[.packages // [] | .[]
                             | select(test("xtmux"; "i"))] | length' "$PI_SETTINGS")"
    expect_ge "pi settings: xtmux package registered" "$pi_pkg_hits" 1
    local pi_hook_events
    pi_hook_events="$(jq_count '.hooks // {} | keys | length' "$PI_SETTINGS")"
    expect_ge "pi settings: hook events wired" "$pi_hook_events" 1
  fi

  # 4. Specialist definitions on disk. `sp list` runs later — this asserts the
  # underlying .specialist.json files (which sp reads) are present.
  local sp_dir; sp_dir="$(specialists_config_dir)"
  local sp_count
  sp_count="$(find "$sp_dir" -maxdepth 1 -name '*.specialist.json' 2>/dev/null | wc -l | tr -d ' ')"
  expect_ge "specialist definitions in $sp_dir" "$sp_count" 5
  # Per-name check: the core specialists the CLAUDE.md workflow depends on.
  # A count-only check would not notice one of them going missing.
  for name in executor explorer reviewer planner debugger; do
    [ -f "$sp_dir/$name.specialist.json" ] \
      && ok "specialist $name.specialist.json present" \
      || fail "specialist $name.specialist.json missing"
  done
}

# snapshot <label> <repo dir> — records the state stage 5 compares.
snapshot() {
  # Separate statements: `local a=$1 b=$a` trips `set -u` in bash.
  local label="$1" dir="$2"
  local out="$WORK/snap-$label.txt"
  {
    printf 'xt_version=%s\n'         "$(xt --version 2>/dev/null | tail -1)"
    printf 'sp_version=%s\n'         "$(sp --version 2>/dev/null | tail -1)"
    # xtmux's bin has no --version; read the installed manifest instead.
    printf 'xtmux_version=%s\n'      "$(jq -r '.version' "$(xtmux_root)/package.json" 2>/dev/null)"
    printf 'registry_assets=%s\n'    "$(jq '.assets | length' "$dir/.xtrm/registry.json" 2>/dev/null || echo 0)"
    printf 'registry_parity=%s\n'    "$(registry_parity "$dir")"
    printf 'hook_commands=%s\n'      "$(jq '[.. | .command? | select(.)] | length' "$dir/.xtrm/config/hooks.json" 2>/dev/null || echo 0)"
    printf 'hook_files=%s\n'         "$(find "$dir/.xtrm/hooks" -type f 2>/dev/null | wc -l | tr -d ' ')"
    printf 'skill_roots_repo=%s\n'   "$(find "$dir/.xtrm/skills" -maxdepth 3 -name SKILL.md 2>/dev/null | wc -l | tr -d ' ')"
    printf 'skill_roots_global=%s\n' "$(find "$HOME/.xtrm/skills/default" -maxdepth 2 -name SKILL.md 2>/dev/null | wc -l | tr -d ' ')"
    printf 'symlinks=%s\n'           "$(find "$dir/.xtrm" -type l 2>/dev/null | wc -l | tr -d ' ')"
  } > "$out"
  printf '  snapshot %-22s %s\n' "$label" "$(paste -sd' ' "$out")"
}

printf 'xtrm trio smoke test — %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf 'dist-tag: %s   branch(all): %s   live checks: %s   fault: %s\n' \
  "$TAG" "${BRANCH_ALL:-<none>}" "$([ "$SKIP_LIVE" -eq 1 ] && echo skipped || echo on)" \
  "${FAULT:-<none>}"

# ===========================================================================
stage "1-install"
# ===========================================================================
run "npm i -g xtrm-tools@$TAG" npm i -g "xtrm-tools@$TAG"
run "npm i -g @jaggerxtrm/specialists@$TAG" npm i -g "@jaggerxtrm/specialists@$TAG"
install_xtmux "@jaggerxtrm/xtmux@$TAG"

for bin in xt sp xtmux xtmux-obs xtmux-events bd bun; do
  if command -v "$bin" >/dev/null 2>&1; then ok "$bin resolves ($(command -v "$bin"))"
  else fail "$bin is not on PATH"; fi
done
run "bun on PATH executes (musl build wins over npm's bun link)" bun --version
printf '  versions: xt=%s sp=%s xtmux=%s bd=%s\n' \
  "$(xt --version 2>/dev/null | tail -1)" "$(sp --version 2>/dev/null | tail -1)" \
  "$(jq -r '.version' "$(xtmux_root)/package.json" 2>/dev/null)" "$(bd version 2>/dev/null | head -1)"

[ "$FAILED" -eq 0 ] || { printf '\nRESULT: FAIL (%s)\n' "$FIRST_FAIL"; exit 1; }

# ===========================================================================
stage "2-update-mechanisms"
# ===========================================================================
# Re-install at the same dist-tag under test. Hardcoding @latest here would
# silently replace a `--tag next` candidate, so stages 2-5 would exercise
# latest and could report PASS on a broken candidate.
run "npm i -g xtrm-tools@$TAG (update)" npm i -g "xtrm-tools@$TAG"
run "npm i -g @jaggerxtrm/specialists@$TAG (update)" npm i -g "@jaggerxtrm/specialists@$TAG"
install_xtmux "@jaggerxtrm/xtmux@$TAG"

SCRATCH="$WORK/scratch"
mkdir -p "$SCRATCH"
run "git init scratch project" git init -q "$SCRATCH"
run_in "$SCRATCH" "xt init -y" xt init -y || true
run_in "$SCRATCH" "xt update --apply" xt update --apply --repo .
[ -f "$SCRATCH/.xtrm/registry.json" ] \
  && ok "scratch project has .xtrm/registry.json" \
  || fail "xt init/update produced no .xtrm/registry.json in a fresh project"

# ===========================================================================
stage "3-clone-and-init"
# ===========================================================================
for entry in "${REPOS[@]}"; do
  IFS='|' read -r name url _pkg <<<"$entry"
  dir="$WORK/repos/$name"
  mkdir -p "$(dirname "$dir")"
  run "clone $name" git clone --quiet --depth 1 "$url" "$dir" || continue
  run_in "$dir" "xt init -y ($name)" xt init -y || true
  snapshot "$name-pre" "$dir"
done

# ===========================================================================
stage "4-apply-edits-and-update"
# ===========================================================================
# Two edit modes. With --branch: check the ref out and install that package from
# source, i.e. test an unreleased branch. Without: induce hook/registry drift so
# stage 5 proves `xt update --apply` repairs it.
for entry in "${REPOS[@]}"; do
  IFS='|' read -r name url pkg <<<"$entry"
  dir="$WORK/repos/$name"
  [ -d "$dir" ] || continue
  ref="${BRANCH_FOR[$name]:-$BRANCH_ALL}"

  if [ -n "$ref" ]; then
    # --force is required, not sloppiness. Stage 3 ran `xt init` in this clone,
    # which rewrites the TRACKED generated file .xtrm/registry.json. The clone
    # and this fetch read origin at two different moments, so when a PR lands
    # in between, FETCH_HEAD carries a different registry.json and a plain
    # checkout aborts with "local changes would be overwritten". That made the
    # release gate fail for whoever was merging at the time — precisely when
    # the gate gets run. The generated scaffolding is not signal here: we want
    # the branch's source, and stage 4 regenerates it via `xt update --apply`
    # immediately after injecting drift.
    if git -C "$dir" ls-remote --exit-code --heads origin "$ref" >/dev/null 2>&1; then
      run "fetch $name@$ref" git -C "$dir" fetch --quiet --depth 1 origin "$ref" \
        && run "checkout $name@$ref" git -C "$dir" checkout --quiet --force FETCH_HEAD \
        && install_from_source "$name" "$dir" "$pkg"
    else
      skip "$name has no branch '$ref' on origin"
    fi
  fi

  # Drift: drop a hook payload and blank the registry, then let xt repair it.
  victim="$(find "$dir/.xtrm/hooks" -type f 2>/dev/null | head -1)"
  if [ -n "$victim" ]; then
    printf 'drift_victim=%s\n' "$victim" >> "$WORK/snap-$name-pre.txt"
    rm -f "$victim"
    ok "$name: removed hook payload $(basename "$victim") to simulate drift"
  else
    skip "$name: no .xtrm/hooks payload to drift"
  fi

  run_in "$dir" "xt update --apply ($name)" xt update --apply --repo .
  snapshot "$name-post" "$dir"
done

# ===========================================================================
stage "4b-global-drift"
# ===========================================================================
# Reconcile the pi hook wiring at least once. reconcileGlobalPiHooks() is only
# called by xt update when XTRM_GLOBAL_HOOKS=1, and no other stage flips that
# flag — without this call, ~/.pi/agent/settings.json.hooks is empty and the
# pi-hooks assertion in stage 5 would fail on any run.
run_in "$SCRATCH" "xt update --apply (global hook reconcile)" \
  env XTRM_GLOBAL_HOOKS=1 xt update --apply --repo .

# Same drift+repair pattern as stage 4, but on the global install surface —
# the surface bead xtrm-wiy5n.4.32 called out. Skipped when a specific fault is
# under test; that path needs the break to survive into stage 5.
if [ -z "$FAULT" ]; then
  global_drift_and_repair
else
  skip "global drift+repair (XTRM_SMOKE_FAULT=$FAULT — leaving fault target intact)"
fi

# ===========================================================================
stage "5-verify"
# ===========================================================================
# If a fault is under test, inject it right before assertions so no downstream
# code can restore it. FAILED must go up by at least one below.
if [ -n "$FAULT" ]; then
  apply_fault "$FAULT" || true
fi

check_global_surface

for entry in "${REPOS[@]}"; do
  IFS='|' read -r name _url _pkg <<<"$entry"
  pre="$WORK/snap-$name-pre.txt"; post="$WORK/snap-$name-post.txt"
  [ -f "$post" ] || { fail "$name: no post snapshot (earlier stage did not complete)"; continue; }
  printf '  --- %s\n' "$name"

  expect_ge "$name hook_commands"  "$(field hook_commands "$post")"  1
  expect_ge "$name hook_files"     "$(field hook_files "$post")"     "$(field hook_files "$pre")"
  expect_ge "$name registry_assets" "$(field registry_assets "$post")" 1
  expect_ge "$name skill_roots_global" "$(field skill_roots_global "$post")" 1
  expect_eq "$name symlinks under .xtrm" "$(field symlinks "$post")" 0

  # registry parity: total/missing/mismatch
  parity="$(field registry_parity "$post")"
  expect_ge "$name registry files declared" "${parity%%/*}" 1
  expect_eq "$name registry files missing on disk" "$(printf '%s' "$parity" | cut -d/ -f2)" 0
  mismatch="$(printf '%s' "$parity" | cut -d/ -f3)"
  [ "$mismatch" = "0" ] \
    && ok "$name registry hashes all match" \
    || warn "$name has $mismatch registry hash mismatch(es) — clone is ahead of the released registry"

  victim="$(field drift_victim "$pre")"
  if [ -n "$victim" ]; then
    [ -f "$victim" ] \
      && ok "$name: xt update --apply restored $(basename "$victim")" \
      || fail "$name: xt update --apply did NOT restore removed hook $(basename "$victim")"
  fi
done

# The release contract: specialists-owned skills must land in the global mirror.
for s in using-specialists; do
  [ -f "$HOME/.xtrm/skills/default/$s/SKILL.md" ] \
    && ok "global skill mirror has $s" \
    || fail "global skill mirror is missing $s/SKILL.md"
done

# Skill roots within budget: run core's own budget script against its clone, so
# the numbers stay in one place instead of being duplicated here. The clone's
# .xtrm/skills/default holds whatever the *installed* package shipped, so a
# pre-release run legitimately reports overruns that the release being gated is
# about to fix — hence WARN with the numbers, not a gate failure.
budget_script="$WORK/repos/core/scripts/check-skill-root-budget.mjs"
if [ -f "$budget_script" ]; then
  budget_out="$(cd "$WORK/repos/core" && node "$budget_script" 2>&1)"
  printf '\n$ check-skill-root-budget.mjs\n%s\n' "$budget_out" >>"$LOG"
  if printf '%s' "$budget_out" | grep -q '^FAIL'; then
    warn "installed skill roots exceed documented budget: $(printf '%s' "$budget_out" | awk '/^FAIL/{printf "%s %s ", $2, $3$4$5}')"
  else
    ok "skill roots within documented budget"
  fi
else
  skip "skill-root budget script not present in the core clone"
fi

# Global npm bins must not shadow system commands. Released
# @jaggerxtrm/specialists declares bin "install", which shadows install(1) for
# any shell with the npm global bin dir ahead of /usr/bin — it silently hijacks
# build scripts. WARN not FAIL: it is a known released defect, and a hard fail
# would keep this gate red for something the release under test cannot repair.
shadowing=""
for p in "$(npm prefix -g)"/bin/*; do
  [ -e "$p" ] || continue
  b="$(basename "$p")"
  { [ -e "/bin/$b" ] || [ -e "/usr/bin/$b" ]; } && shadowing="$shadowing $b"
done
if [ -n "$shadowing" ]; then
  warn "global npm bins shadow system commands:$shadowing"
else
  ok "no global npm bin shadows a system command"
fi

# The fresh-machine regression this gate exists to catch.
if grep -q "Source and destination must not be the same" "$LOG"; then
  fail "'Source and destination must not be the same' appeared in install/update output"
else
  ok "no 'Source and destination must not be the same' regression"
fi

# --- live scenario ---------------------------------------------------------
if [ "$SKIP_LIVE" -eq 1 ]; then
  skip "live xtmux/sp scenario (--skip-live)"
else
  run "xtmux-obs migrate (observability db schema)" xtmux-obs migrate
  if xtmux-obs health 2>/dev/null | jq -e '.ok == true' >/dev/null 2>&1; then
    ok "xtmux-obs health reports ok"
  else
    fail "xtmux-obs health is not ok"
    xtmux-obs health 2>&1 | head -3 | sed 's/^/         /'
  fi

  if tmux new-session -d -s xtrm-smoke "sleep 600" >>"$LOG" 2>&1; then
    ok "tmux session xtrm-smoke started"
    sid="$(tmux display-message -p -t xtrm-smoke '#{session_id}' 2>/dev/null)"
    follow="$WORK/follow.json"; events="$WORK/events.json"
    # Both followers are bounded by timeout, so `wait` ends the scenario.
    timeout 15 xtmux log follow --after-id 0 --json >"$follow" 2>&1 &
    timeout 15 xtmux-events --json >"$events" 2>&1 &
    sleep 4
    key="$(xtmux message-send --to "$sid" --bead xtrm-smoke --expects-reply=false \
             --text 'smoke-container live ping' --json 2>>"$LOG" | jq -r '.messageKey // empty')"
    [ -n "$key" ] && ok "xtmux message-send accepted ($key)" || fail "xtmux message-send failed"
    wait

    # Live delivery: the journal must carry the event to a running follower.
    if [ -n "$key" ] && grep -q "$key" "$follow" 2>/dev/null; then
      ok "xtmux log follow delivered messages.sent live"
    else
      fail "xtmux log follow did not deliver the messages.sent event (see $follow)"
      head -5 "$follow" 2>/dev/null | sed 's/^/         /'
    fi

    # The events dashboard on top of it.
    if grep -q 'following .* open xtmux sessions' "$events" 2>/dev/null; then
      ok "xtmux-events started and is following the live session"
    else
      fail "xtmux-events did not start (see $events)"
      head -5 "$events" 2>/dev/null | sed 's/^/         /'
    fi
    if [ -n "$key" ] && ! grep -q "$key" "$events" 2>/dev/null; then
      # WARN not FAIL: xtmux-events joins the journal's session_id ("$0") against
      # `xtmux dashboard`'s composite sessionId ("$0_name_%0_path_ts"), so the join
      # drops the event. Upstream in xtmux, not something a release can repair here.
      warn "xtmux-events did not render the event it followed (dashboard sessionId vs journal session_id join)"
    else
      [ -n "$key" ] && ok "xtmux-events rendered the live message event"
    fi
    tmux kill-session -t xtrm-smoke >>"$LOG" 2>&1
  else
    fail "tmux could not start a session"
  fi

  run "sp list" sp list
  if [ -n "${ANTHROPIC_API_KEY:-}${OPENAI_API_KEY:-}" ]; then
    run_in "$SCRATCH" "sp run (smoke prompt)" \
      timeout 300 sp run explorer --prompt 'Reply with the single word OK.'
  else
    skip "sp run needs model credentials (pass -e ANTHROPIC_API_KEY=... to docker run)"
  fi
  # SCOPE also asked for "terminal notification lands". Not assertable here —
  # a headless container has no terminal to receive one.
  skip "terminal notification delivery (no terminal in a headless container)"
fi

# ===========================================================================
printf '\n=== SUMMARY ===\n'
printf '  failures: %d   warnings: %d   skipped: %d\n' "$FAILED" "$WARNED" "$SKIPPED"
if [ "$FAILED" -eq 0 ]; then
  printf 'RESULT: PASS\n'
  exit 0
fi
printf 'RESULT: FAIL — first failure in %s\n' "$FIRST_FAIL"
printf 'full command log: %s (re-run with --keep to retain it)\n' "$LOG"
exit 1
