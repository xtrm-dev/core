#!/usr/bin/env bash
# Run semgrep against the diff between HEAD and origin/main.
# Used by pre-push hook so pre-existing debt doesn't block unrelated pushes.
# CI's full scan remains the source of truth for absolute findings.

set -euo pipefail

if ! command -v semgrep >/dev/null; then
    echo "semgrep not installed — skipping (CI covers it)"
    exit 0
fi

# Derive base ref dynamically: prefer the branch's tracked upstream, fall back
# to common default branches, finally to HEAD~N where N covers the whole push.
upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
if [ -n "$upstream" ]; then
    BASE_REF="$upstream"
else
    BASE_REF=""
    for cand in origin/main origin/master main master; do
        git rev-parse --verify "$cand" >/dev/null 2>&1 && BASE_REF="$cand" && break
    done
fi

[ -n "$BASE_REF" ] && git fetch "${BASE_REF%%/*}" "${BASE_REF#*/}" --quiet 2>/dev/null || true

if [ -n "$BASE_REF" ]; then
    BASE=$(git merge-base HEAD "$BASE_REF" 2>/dev/null || true)
fi
# Final fallback: walk back enough to cover the push. On a single-commit
# history rev-list returns HEAD itself — using HEAD as baseline produces an
# empty diff and silently misses everything. Refuse that case and run a
# full scan instead so first-push coverage stays honest.
if [ -z "${BASE:-}" ]; then
    BASE=$(git rev-list HEAD --max-count=50 | tail -1)
fi
HEAD_SHA=$(git rev-parse HEAD)
SEMGREP_BASELINE_ARGS=()
if [ -n "${BASE:-}" ] && [ "$BASE" != "$HEAD_SHA" ]; then
    SEMGREP_BASELINE_ARGS=(--baseline-commit="$BASE")
else
    echo "[semgrep-diff] no usable baseline (single-commit branch?) — running full scan"
fi

exec semgrep scan \
    --config=p/default \
    --config=p/security-audit \
    --config=p/secrets \
    --config=p/python \
    --config=p/dockerfile \
    --config=p/github-actions \
    "${SEMGREP_BASELINE_ARGS[@]}" \
    --error \
    --quiet \
    --skip-unknown-extensions
