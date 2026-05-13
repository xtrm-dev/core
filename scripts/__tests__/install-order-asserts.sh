#!/usr/bin/env bash
set -euo pipefail

assert_exit_zero() {
  local exit_code="$1"
  local label="$2"

  if [[ "$exit_code" -ne 0 ]]; then
    echo "${label}: expected exit 0, got ${exit_code}" >&2
    return 1
  fi
}

assert_exit_nonzero() {
  local exit_code="$1"
  local label="$2"

  if [[ "$exit_code" -eq 0 ]]; then
    echo "${label}: expected non-zero exit" >&2
    return 1
  fi
}

assert_stderr_contains() {
  local stderr_file="$1"
  local needle="$2"
  local label="$3"

  if ! grep -Eq "$needle" "$stderr_file"; then
    echo "${label}: stderr missing guidance" >&2
    echo "expected pattern: ${needle}" >&2
    cat "$stderr_file" >&2
    return 1
  fi
}

assert_no_symlinks_under_repo() {
  local repo_dir="$1"
  local label="$2"

  if find "$repo_dir" -type l -path '*/.xtrm/*' -print -quit | grep -q .; then
    echo "${label}: found cross-repo symlink under .xtrm" >&2
    find "$repo_dir" -type l -path '*/.xtrm/*' -print >&2
    return 1
  fi
}
