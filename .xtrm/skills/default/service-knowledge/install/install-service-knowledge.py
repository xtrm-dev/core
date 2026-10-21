#!/usr/bin/env python3
"""
Standalone service-knowledge git-hook + migration installer (runtime-agnostic fallback).

> NORMAL PATH: ``service-knowledge install`` (the package CLI) vendors the machinery and
> calls this script with ``--hooks-only`` to wire the non-blocking git reminders. You only
> need to run this file directly when the ``service-knowledge`` CLI cannot be installed.

Run from inside your target project directory. Idempotent. It only:
  - installs the non-blocking git pre-commit/pre-push doc + staleness reminders
    and the touches-gated marker-only post-merge/post-checkout/post-rewrite drift hooks
  - (full mode) migrates the pack layout, upgrades per-service SKILL.md, regenerates the
    per-repo ``<repo>-service-knowledge`` umbrella

Hook coverage is per-worktree by default (``git rev-parse --git-path hooks`` in
this worktree). Pass ``--all-worktrees`` (with ``--hooks-only`` or full mode)
to chain every linked worktree from ``git worktree list --porcelain``.

The Claude SessionStart/PreToolUse/PostToolUse hooks are wired by the CLI into
``.claude/settings.json`` (project-local machinery under ``.xtrm/skills/default/service-knowledge``).
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()            # .../service-knowledge/install/
GIT_HOOKS  = SCRIPT_DIR / "git-hooks"                   # install/git-hooks/
SCRIPTS    = SCRIPT_DIR.parent / "scripts"             # .../service-knowledge/scripts/ (location-independent)

GREEN  = "\033[0;32m"
YELLOW = "\033[1;33m"
NC     = "\033[0m"

MARKER_DOC        = "# [jaggers] doc-reminder"
MARKER_STALENESS  = "# [jaggers] skill-staleness"
MARKER_DRIFT_SWEEP = "# [jaggers] drift-sweep"
MARKER_CHAIN      = "# [jaggers] chain-githooks"

NEW_UMBRELLA = "service-knowledge"
LEGACY_UMBRELLA = "service-skills"

# B0 hotfix: canonical hook names owned by this installer. Self-check gates on
# the three drift hooks (post-merge/post-checkout/post-rewrite, the
# touches-gated marker reconciliation points); pre-commit/pre-push warn
# but do not fail the install.
_HOOK_NAMES = ("pre-commit", "pre-push", "post-merge", "post-checkout", "post-rewrite")

# Drift hooks: .githooks name -> vendored sweep body (B2 touches-gated,
# marker-only; B3 adds checkout + rewrite with the same gate).
_DRIFT_HOOK_BODIES = {
    "post-merge": "post_merge_drift_sweep.py",
    "post-checkout": "post_checkout_drift_sweep.py",
    "post-rewrite": "post_rewrite_drift_sweep.py",
}

# Pure `VAR=value` assignment line (legacy-block span absorption target).
_ASSIGN_LINE_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)=\S.*$")

# Markers for files that already fire something (sweep bodies, reminders).
# A marker-less rewrite must never touch these (XTRM-654 follow-up).
_BODY_MARKERS = (MARKER_DRIFT_SWEEP, MARKER_DOC, MARKER_STALENESS)

# All sweep bodies this installer has ever wired: stale invocations of any of
# these are replaced span-aware (enclosing ``if...fi``) so re-run repairs
# them. NEVER delete by bare line-substring: variant-B markerless two-line
# ``SK_ROOT`` + ``if`` forms orphaned ``SK_ROOT``/``fi`` lines that way
# (XTRM-654: syntax-invalid hooks, pre-push guard down repo-wide).
_STALE_BODY_NAMES = (
    "post_merge_drift_sweep.py",
    "post_checkout_drift_sweep.py",
    "post_rewrite_drift_sweep.py",
    "doc_reminder.py",
    "skill_staleness.py",
)


def _replace_legacy_body_span(content: str, desired_block: str) -> tuple[str, bool]:
    """Replace one stale body invocation span with ``desired_block``.

    Finds lines referencing a stale body name, expands to the enclosing
    shell ``if...fi`` span (backward to the nearest preceding line starting
    with ``if ``, forward to the next line that is exactly ``fi``; a
    single-line ``if ...; fi`` opener counts as its own span), and swaps
    the whole span. Returns ``(content, False)`` when no stale reference
    exists OR no well-formed span is found — the caller must leave the
    file untouched so the self-check fails loudly instead of mangling it.
    """
    stale = [i for i, ln in enumerate(content.splitlines())
             if any(name in ln for name in _STALE_BODY_NAMES)]
    if not stale:
        return content, False
    lines = content.splitlines(keepends=True)
    first, last = stale[0], stale[-1]
    # Backward: nearest preceding `if ` opener within 3 lines (legacy
    # invocations keep opener adjacent to the body ref; the bound stops
    # the span from swallowing an enclosing FOREIGN block — failure
    # degrades to loud self-check instead of silent mangling).
    opener = None
    for i in range(first, max(first - 3, -1), -1):
        if lines[i].lstrip().startswith("if "):
            opener = i
            break
    if opener is None:
        return content, False
    # Absorb immediately-preceding env assignments feeding the block
    # (legacy ``SK_ROOT="..."`` two-line form): contiguous `VAR=value`
    # lines, at most 3 up, whose variable is referenced in the following
    # ~10 lines. Without this the assignment survives as an orphan.
    for _ in range(3):
        if opener == 0:
            break
        prev = lines[opener - 1]
        assign = _ASSIGN_LINE_RE.match(prev)
        if assign is None:
            break
        var = assign.group(1)
        window = "".join(lines[opener:opener + 10])
        if ("$" + var) not in window and ("${" + var) not in window:
            break
        opener -= 1
    # Single-line `if ...; fi` form: the opener line is the whole span.
    if lines[opener].strip().endswith("fi"):
        span_end = opener + 1
    else:
        # Forward: nearest bare `fi` within 6 lines (legacy bodies are
        # ~4 lines; same anti-swallow bound as above).
        closer = None
        for i in range(last, min(last + 6, len(lines))):
            if lines[i].strip() == "fi":
                closer = i
                break
        if closer is None:
            return content, False
        span_end = closer + 1
    if span_end <= opener:
        return content, False
    return "".join(lines[:opener]) + desired_block + "".join(lines[span_end:]), True


def get_project_root() -> Path:
    try:
        r = subprocess.run(["git", "rev-parse", "--show-toplevel"],
                           capture_output=True, text=True, check=True, timeout=5)
        return Path(r.stdout.strip())
    except subprocess.CalledProcessError:
        print("Error: not inside a git repository.")
        sys.exit(1)


def _resolve_active_hooks_dir(project_root: Path) -> Path:
    """Resolve the active hooks dir exactly as git would.

    Single source of truth: ``git rev-parse --git-path hooks`` respects
    ``core.hooksPath`` (including absolute overrides) and linked-worktree
    ``.git/worktrees/<n>/hooks`` layouts. Never read ``core.hooksPath``
    directly — that bypasses git's own resolution and drifts from what
    actually fires.
    """
    try:
        resolved = subprocess.check_output(
            ["git", "-C", str(project_root), "rev-parse", "--git-path", "hooks"],
            text=True, timeout=5,
        ).strip()
        if resolved:
            p = Path(resolved)
            return p if p.is_absolute() else project_root / resolved
    except Exception:
        pass
    return project_root / ".git" / "hooks"


def _normalize_legacy_hook_text(content: str) -> tuple[str, bool]:
    """Rewrite ``service-skills`` path segments to ``service-knowledge``.

    Covers the umbrella rename: consumer ``.githooks/*`` files (and old
    chain blocks) that bake the absolute legacy body path become valid
    again. Idempotent — no-op when the legacy name is absent.
    """
    if LEGACY_UMBRELLA not in content:
        return content, False
    return content.replace(LEGACY_UMBRELLA, NEW_UMBRELLA), True


def _ensure_block(content: str, marker: str, desired: str) -> tuple[str, bool]:
    """Ensure exactly one canonical ``marker`` block equals ``desired``.

    Rewrite (never duplicate): a stale block under the same marker is
    replaced in place; duplicate markers collapse to one. Returns
    (new_content, changed).
    """
    desired_block = desired.lstrip("\n")
    if marker not in content:
        # A sweep/reminder body is already here under a different marker:
        # never rewrite around it from a marker-less call. The chain step
        # hits this path on body-carrying files and previously ate the
        # fresh body as a "legacy" span (XTRM-654 follow-up). Leave
        # untouched; the self-check validates what's there.
        if any(bm in content for bm in _BODY_MARKERS):
            return content, False
        # Legacy invocation without our marker (pre-rename absolute bake,
        # markerless SK_ROOT two-line form). Replace the enclosing span so
        # re-run repairs instead of stacking a second invocation — and NEVER
        # blind-delete lines: partial deletion orphans multi-line
        # constructs (XTRM-654). Unparseable: leave untouched; the
        # self-check flags the missing body ref loudly.
        new_content, replaced = _replace_legacy_body_span(content, desired_block)
        if replaced:
            return new_content, True
        if any(name in content for name in _STALE_BODY_NAMES):
            return content, False
        base = content if content.endswith("\n") or content == "" else content + "\n"
        return base + desired_block, True
    if desired in content:
        # Collapse accidental duplicates (re-run must not append chains).
        parts = content.split(desired)
        if len(parts) == 2:
            return content, False
        return parts[0] + desired + parts[-1].lstrip("\n"), True
    start = content.index(marker)
    # End our block at the next comment line (any `#...`), not just the next
    # jaggers marker: sibling conventions (`.bd-sync`, beads/dolt custom
    # blocks) must survive a rewrite. Our blocks never contain a `#`-led
    # line, so the next `#` line always starts foreign content.
    end = content.find("\n#", start + len(marker))
    if end < 0:
        # No following comment: end our block at its `fi` terminator and
        # preserve everything after verbatim. Every installer-written block
        # (reminder/staleness/drift invocations, chains) terminates with a
        # top-level `fi`; anything past it is foreign (e.g. a consumer's
        # `exit "$_gate_rc"` RC propagation) and must never be truncated.
        # No recognizable terminator: leave the file untouched (fail-safe).
        fi_end = content.find("\nfi", start + len(marker))
        if fi_end < 0:
            return content, False
        term = fi_end + len("\nfi")
        if term < len(content) and content[term] == "\n":
            term += 1
        return content[:start] + desired_block + content[term:], True
    tail = content[end:]
    # desired_block ends with "\n" and tail starts with "\n#": join without
    # doubling the blank line separator.
    if desired_block.endswith("\n") and tail.startswith("\n"):
        tail = tail[1:]
    return content[:start] + desired_block + tail, True


def _desired_chain_snippet(hook_name: str) -> str:
    """Runtime-relative chain: resolve the toplevel at fire time.

    Never bakes the install-time absolute ``source_hook`` path — absolute
    chains outlive moves, ephemeral worktrees, and linked-worktree gitdirs.
    """
    return (
        f"\n{MARKER_CHAIN}\n"
        'root="$(git rev-parse --show-toplevel 2>/dev/null)"\n'
        f'if [ -n "$root" ] && [ -x "$root/.githooks/{hook_name}" ]; then\n'
        f'    "$root/.githooks/{hook_name}" "$@"\n'
        "fi\n"
    )


def _detect_hooks_path_override(project_root: Path) -> str:
    """Report the effective ``core.hooksPath`` (empty when unset/default).

    Detection only — resolution always goes through ``git rev-parse --git-path
    hooks`` (see _resolve_active_hooks_dir), never by joining this value by
    hand. Reported so the install log shows which convention is active.
    """
    try:
        r = subprocess.run(
            ["git", "-C", str(project_root), "config", "--get", "core.hooksPath"],
            capture_output=True, text=True, timeout=5, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    if r.returncode != 0:
        return ""
    return r.stdout.strip()


def _list_worktrees(project_root: Path) -> list[Path]:
    """Worktree roots from ``git worktree list --porcelain`` (main first).

    Empty on any failure — the caller falls back to the single-worktree path
    rather than failing the install.
    """
    try:
        r = subprocess.run(
            ["git", "-C", str(project_root), "worktree", "list", "--porcelain"],
            capture_output=True, text=True, timeout=10, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if r.returncode != 0:
        return []
    roots: list[Path] = []
    for line in r.stdout.splitlines():
        if line.startswith("worktree "):
            p = Path(line[len("worktree "):].strip())
            if p.is_dir() and p not in roots:
                roots.append(p)
    if project_root not in roots:
        roots.insert(0, project_root)
    return roots


def _check_drift_source(project_root: Path, hook_name: str, problems: list[str]) -> None:
    """Self-check one ``.githooks/<hook>`` drift source (gating)."""
    body_name = _DRIFT_HOOK_BODIES[hook_name]
    src = project_root / ".githooks" / hook_name
    if not src.is_file():
        problems.append(f".githooks/{hook_name} missing: {src}")
        return
    try:
        src_text = src.read_text(encoding="utf-8")
    except OSError as exc:
        problems.append(f".githooks/{hook_name} unreadable: {exc}")
        return
    if MARKER_DRIFT_SWEEP not in src_text:
        problems.append(f".githooks/{hook_name} missing drift-sweep marker")
    if LEGACY_UMBRELLA in src_text:
        problems.append(f".githooks/{hook_name} still references service-skills")
    if f"service-knowledge/install/git-hooks/{body_name}" not in src_text:
        problems.append(f".githooks/{hook_name} missing renamed sweep body ref ({body_name})")
    if "git rev-parse --show-toplevel" not in src_text:
        problems.append(f".githooks/{hook_name} missing relative runtime resolution")
    r = subprocess.run(["bash", "-n", str(src)],
                       capture_output=True, text=True, timeout=5)
    if r.returncode != 0:
        problems.append(f".githooks/{hook_name} bash -n failed: {r.stderr.strip()[:200]}")


def _resolves_to_self(active_hooks_dir: Path, hook_name: str, target: Path) -> bool:
    """True when the chain's runtime target is the chain file itself.

    The chain dispatches to ``$root/.githooks/<name>`` where ``$root`` is the
    firing checkout. When the active dir IS a checkout's own ``.githooks``,
    that resolves to this file — infinite recursion unless the file also
    carries the sweep body (XTRM-654).
    """
    try:
        owner = _owning_checkout(active_hooks_dir)
        return owner is not None and (owner / ".githooks" / hook_name).resolve() == target.resolve()
    except OSError:
        return False


def _check_drift_chain(
    active_hooks_dir: Path, hook_name: str, source_hook: Path, problems: list[str], details: list[str]
) -> None:
    """Self-check one active-dir chain (gating) — unless it IS the source dir
    (core.hooksPath=.githooks convention: no chain needed, same file fires)."""
    target = active_hooks_dir / hook_name
    if not target.is_file():
        problems.append(f"active {hook_name} missing: {target}")
        return
    try:
        text = target.read_text(encoding="utf-8")
    except OSError as exc:
        problems.append(f"active {hook_name} unreadable: {exc}")
        return
    try:
        same = source_hook.resolve() == target.resolve()
    except OSError:
        same = False
    has_body = MARKER_DRIFT_SWEEP in text
    has_chain = MARKER_CHAIN in text
    if has_body:
        # Target fires the sweep itself (source checkout or owning
        # checkout): chain requirements don't apply, and a chain here
        # would be self-recursive (XTRM-654).
        if has_chain and _resolves_to_self(active_hooks_dir, hook_name, target):
            problems.append(
                f"active {hook_name} is self-recursive: chain dispatches to "
                f"itself alongside the sweep body in {target}"
            )
        if LEGACY_UMBRELLA in text:
            problems.append(f"active {hook_name} still references service-skills")
        r = subprocess.run(["bash", "-n", str(target)],
                           capture_output=True, text=True, timeout=5)
        if r.returncode != 0:
            problems.append(f"active {hook_name} bash -n failed: {r.stderr.strip()[:200]}")
        return
    if same:
        # Same file fires but carries no sweep body: a chain here would
        # dispatch to itself, and nothing fires the sweep (XTRM-654).
        if has_chain:
            problems.append(
                f"active {hook_name} is self-recursive: chain dispatches to "
                f"itself with no sweep body in {target}"
            )
        else:
            problems.append(f"active {hook_name} has no sweep body to fire ({target})")
        r = subprocess.run(["bash", "-n", str(target)],
                           capture_output=True, text=True, timeout=5)
        if r.returncode != 0:
            problems.append(f"active {hook_name} bash -n failed: {r.stderr.strip()[:200]}")
        return
    if MARKER_CHAIN not in text:
        problems.append(f"active {hook_name} missing chain marker ({target})")
    if LEGACY_UMBRELLA in text:
        problems.append(f"active {hook_name} still references service-skills")
    # Stale absolute chain bakes the install-time source path.
    if f'.githooks/{hook_name}"' in text and 'if [ -x "/' in text:
        problems.append(f"active {hook_name} chain still bakes an absolute path")
    if f".githooks/{hook_name}" not in text:
        problems.append(f"active {hook_name} chain does not resolve .githooks/{hook_name}")
    # .bd-sync sibling convention: never clobber the beads chain.
    bd_sync = active_hooks_dir / f"{hook_name}.bd-sync"
    if bd_sync.is_file() and f"{hook_name}.bd-sync" not in text:
        problems.append(f"active {hook_name} lost its .bd-sync sibling chaining")
    # Dangling-chain guard (XTRM-654): a bare chain whose runtime target is
    # itself (owning checkout's file, no body anywhere) passes `bash -n`
    # and recurses forever at runtime. The installer writes owner sources,
    # so reaching here means hand-created or pre-fix damage.
    if _resolves_to_self(active_hooks_dir, hook_name, target):
        problems.append(
            f"active {hook_name} is self-recursive: chain dispatches to "
            f"itself with no sweep body in {target}"
        )
    r = subprocess.run(["bash", "-n", str(target)],
                       capture_output=True, text=True, timeout=5)
    if r.returncode != 0:
        problems.append(f"active {hook_name} bash -n failed: {r.stderr.strip()[:200]}")


def _check_drift_body(project_root: Path, hook_name: str, problems: list[str], details: list[str]) -> None:
    """Self-check one vendored sweep body: checksum + compile (gating)."""
    body_name = _DRIFT_HOOK_BODIES[hook_name]
    body = (project_root / ".xtrm/skills/default/service-knowledge"
            / f"install/git-hooks/{body_name}")
    if not body.is_file():
        # Standalone fallback (CLI not vendored yet): package copy must exist.
        if not (GIT_HOOKS / body_name).is_file():
            problems.append(f"sweep body missing: {body}")
        else:
            details.append(f"{hook_name} body not yet vendored; package copy present")
        return
    try:
        import hashlib
        digest = hashlib.sha256(body.read_bytes()).hexdigest()[:12]
        details.append(f"{hook_name} body sha256:{digest} {body.relative_to(project_root)}")
    except OSError as exc:
        problems.append(f"{hook_name} sweep body unreadable: {exc}")
        return
    r = subprocess.run(["python3", "-m", "py_compile", str(body)],
                       capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        problems.append(f"{hook_name} sweep body py_compile failed: {r.stderr.strip()[:200]}")


def _self_check_worktree(worktree_root: Path, active_hooks_dir: Path) -> tuple[bool, list[str]]:
    """Post-install self-check for one worktree: resolve as git would, verify
    all three drift sources + chains + bodies.

    Fails (ok=False) when no hook can fire: missing source, missing chain
    in the git-resolved active dir, stale ``service-skills`` survivors, or a
    missing/uncompilable sweep body. Never claims success on failure — the
    caller must not print ``activated`` when ok is False.
    """
    problems: list[str] = []
    details: list[str] = []
    # Active dir, exactly as git resolves it (per-worktree: honors
    # core.hooksPath and .git/worktrees/<n>/hooks layouts).
    try:
        git_resolved = subprocess.check_output(
            ["git", "-C", str(worktree_root), "rev-parse", "--git-path", "hooks"],
            text=True, timeout=5,
        ).strip()
        details.append(f"git-path hooks: {git_resolved}")
    except Exception as exc:
        problems.append(f"git rev-parse --git-path hooks failed: {exc}")
    for hook_name in _DRIFT_HOOK_BODIES:
        _check_drift_source(worktree_root, hook_name, problems)
    for hook_name in _DRIFT_HOOK_BODIES:
        _check_drift_chain(active_hooks_dir, hook_name, worktree_root / ".githooks" / hook_name, problems, details)
    for hook_name in _DRIFT_HOOK_BODIES:
        _check_drift_body(worktree_root, hook_name, problems, details)
    return (len(problems) == 0, problems + details)


def _self_check(project_root: Path, active_hooks_dir: Path) -> tuple[bool, list[str]]:
    """Single-worktree self-check (delegates to _self_check_worktree)."""
    return _self_check_worktree(project_root, active_hooks_dir)


def _drift_body_rel(hook_name: str) -> str:
    """Vendored body path (relative to the consumer root) for a drift hook."""
    return (
        ".xtrm/skills/default/service-knowledge/install/git-hooks/"
        f"{_DRIFT_HOOK_BODIES[hook_name]}"
    )


def _write_githooks_sources(worktree_root: Path) -> None:
    """Ensure the five ``.githooks/*`` sources (idempotent, repair-in-place)."""
    doc_rel = ".xtrm/skills/default/service-knowledge/install/git-hooks/doc_reminder.py"
    staleness_rel = ".xtrm/skills/default/service-knowledge/install/git-hooks/skill_staleness.py"

    def make_snippet(marker: str, rel: str, extra_args: str = "") -> str:
        # Resolve the checkout at hook runtime. The installer may run from an
        # ephemeral worktree, so absolute install-time paths would outlive
        # their source tree. Post-checkout/post-rewrite SHAs arrive via
        # argv+stdin ("$@" chains them); bodies never read a baked path.
        return (
            f"\n{marker}\n"
            "if command -v python3 &>/dev/null; then\n"
            '    root="$(git rev-parse --show-toplevel 2>/dev/null)"\n'
            f'    if [ -n "$root" ] && [ -f "$root/{rel}" ]; then\n'
            f'        python3 "$root/{rel}"{extra_args} || true\n'
            "    fi\n"
            "fi\n"
        )

    sources = [
        ("pre-commit", MARKER_DOC, make_snippet(MARKER_DOC, doc_rel)),
        ("pre-push", MARKER_STALENESS, make_snippet(MARKER_STALENESS, staleness_rel)),
    ]
    for hook_name in _DRIFT_HOOK_BODIES:
        # Chain "$@": post-checkout needs argv (prev/new/flag), post-rewrite
        # needs argv + stdin passthrough; harmless for post-merge (no args).
        sources.append(
            (hook_name, MARKER_DRIFT_SWEEP,
             make_snippet(MARKER_DRIFT_SWEEP, _drift_body_rel(hook_name), ' "$@"'))
        )

    for name, marker, snippet in sources:
        hook_path = worktree_root / ".githooks" / name
        if not hook_path.exists():
            hook_path.parent.mkdir(parents=True, exist_ok=True)
            hook_path.write_text("#!/usr/bin/env bash\n", encoding="utf-8")
            hook_path.chmod(0o755)
        raw = hook_path.read_text(encoding="utf-8")
        content, legacy_fixed = _normalize_legacy_hook_text(raw)
        new_content, _block_changed = _ensure_block(content, marker, snippet)
        if new_content != raw:
            hook_path.write_text(new_content, encoding="utf-8")
            hook_path.chmod(0o755)
            action = "repaired" if (legacy_fixed or marker in raw) else "installed"
            try:
                shown = hook_path.relative_to(worktree_root)
            except ValueError:
                shown = hook_path
            print(f"{GREEN}  ✓{NC} {action}: {shown}")
        else:
            print(f"{YELLOW}  ○{NC} already installed: {name}")


def _chain_active_hooks_dir(worktree_root: Path, active_hooks_dir: Path) -> None:
    """Chain all five hooks into the git-resolved active dir (idempotent)."""
    try:
        active_hooks_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        print(f"{YELLOW}!!{NC} cannot create active hooks dir {active_hooks_dir}: {exc}")
        return
    for name in _HOOK_NAMES:
        source_hook = worktree_root / ".githooks" / name
        target_hook = active_hooks_dir / name
        if not target_hook.exists():
            try:
                target_hook.write_text("#!/usr/bin/env bash\n", encoding="utf-8")
            except OSError as exc:
                print(f"{YELLOW}!!{NC} cannot write chain {target_hook}: {exc}")
                continue
        try:
            target_hook.chmod(0o755)
        except OSError:
            pass
        try:
            if target_hook.resolve() == source_hook.resolve():
                continue
        except OSError:
            pass
        desired = _desired_chain_snippet(name)
        try:
            raw_target = target_hook.read_text(encoding="utf-8")
        except OSError as exc:
            print(f"{YELLOW}!!{NC} cannot read chain {target_hook}: {exc}")
            continue
        norm_target, _ = _normalize_legacy_hook_text(raw_target)
        if MARKER_DRIFT_SWEEP in norm_target:
            # Target already fires the sweep itself (owner sources written
            # this run or a previous one). Chaining it would dispatch to
            # itself — definitionally self-recursive (XTRM-654). Skip.
            continue
        new_target, _chain_changed = _ensure_block(norm_target, MARKER_CHAIN, desired)
        if new_target != raw_target:
            try:
                target_hook.write_text(new_target, encoding="utf-8")
                target_hook.chmod(0o755)
            except OSError as exc:
                print(f"{YELLOW}!!{NC} cannot write chain {target_hook}: {exc}")


def _owning_checkout(active_hooks_dir: Path) -> Path | None:
    """Checkout owning an active hooks dir, when detectable (XTRM-654).

    ``<toplevel>/.githooks`` convention: the checkout owns its sources, so a
    chain installed there must dispatch to bodies that exist in THAT
    checkout — otherwise the chain calls itself (runtime self-recursion).
    Returns None for non-checkout dirs (stock ``.git/hooks``, custom paths
    like ``.beads/hooks``): those dispatch runtime-relative to the firing
    checkout, which the per-worktree source writes already cover.
    """
    if active_hooks_dir.name != ".githooks":
        return None
    owner = active_hooks_dir.parent
    try:
        r = subprocess.run(
            ["git", "-C", str(owner), "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        if r.returncode == 0 and Path(r.stdout.strip()).resolve() == owner.resolve():
            return owner
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def _source_roots(project_root: Path, worktrees: list[Path]) -> list[Path]:
    """Checkouts needing sweep-body sources: invoking worktrees plus the
    checkout owning each worktree's active hooks dir (XTRM-654).

    Without the owner, a foreign active dir gets a bare chain whose runtime
    target (``$root/.githooks/<name>``) is itself — valid ``bash -n``,
    infinite recursion at runtime.
    """
    roots = list(worktrees)
    for wt in worktrees:
        owner = _owning_checkout(_resolve_active_hooks_dir(wt))
        if owner is not None and owner not in roots:
            roots.append(owner)
    return roots


def install_git_hooks(project_root: Path, all_worktrees: bool = False) -> bool:
    """Install + self-check git hooks. Returns True only when a hook can fire.

    Per-worktree default: chains into ``git rev-parse --git-path hooks`` for
    this worktree only. ``all_worktrees=True`` (``--all-worktrees``) repeats
    the chain + self-check for every linked worktree from ``git worktree
    list --porcelain``. A detected ``core.hooksPath`` override is installed
    into (it IS the git-resolved active dir) and reported loudly — never
    silently skipped. Sweep-body sources are additionally written into the
    checkout owning a foreign active dir, so no chain dispatches to itself
    (XTRM-654).
    """
    print("\n── Git hooks ───────────────────────────")
    override = _detect_hooks_path_override(project_root)
    if override:
        print(f"{YELLOW}!!{NC} core.hooksPath override detected: {override}")
        print(f"   chains install into the git-resolved active dir (see self-check below).")
    if all_worktrees:
        worktrees = _list_worktrees(project_root)
        print(f"   --all-worktrees: covering {len(worktrees)} worktree(s).")
    else:
        worktrees = [project_root]
    roots = _source_roots(project_root, worktrees)
    foreign = [str(r) for r in roots if r not in worktrees]
    if foreign:
        print(f"   foreign active-dir owner(s) also get sources: {', '.join(foreign)}")

    # Sources first for every root, chains second: chain decisions depend
    # on final source content (a body-present target must never be chained
    # — XTRM-654), so the outcome cannot depend on worktree order.
    for wt in roots:
        try:
            label = wt.relative_to(project_root)
            shown_wt = f". ({wt})" if str(label) != "." else f" ({wt})"
        except ValueError:
            shown_wt = f" ({wt})"
        print(f"   worktree:{shown_wt}")
        _write_githooks_sources(wt)
    for wt in roots:
        _chain_active_hooks_dir(wt, _resolve_active_hooks_dir(wt))

    overall_ok = True
    for wt in roots:
        active = _resolve_active_hooks_dir(wt)
        ok, report = _self_check_worktree(wt, active)
        if ok:
            print(f"{GREEN}  ✓{NC} [{wt}] activated in {active} ({len(_DRIFT_HOOK_BODIES)}/{len(_DRIFT_HOOK_BODIES)} drift hooks; {'; '.join(report)})")
        else:
            overall_ok = False
            print(f"\033[1;31m  xx hooks self-check FAILED [{wt}] (active: {active}):{NC}", file=sys.stderr)
            for line in report:
                print(f"     - {line}", file=sys.stderr)
    if not overall_ok:
        print("     No hook can be trusted to fire; not claiming activation.", file=sys.stderr)
        return False
    return True


RESERVED_PACK_NAMES = {"default", "optional", "user", "active", "local-legacy"}


def _pack_roots(project_root: Path) -> list[Path]:
    skills_root = project_root / ".xtrm" / "skills"
    return [skills_root, skills_root / "user" / "packs"]


def _packs_with_registry(project_root: Path) -> list[Path]:
    """Packs that carry a service registry; new umbrella name wins over legacy/v1 shim."""
    out: list[Path] = []
    seen: set[Path] = set()
    for packs_root in _pack_roots(project_root):
        if not packs_root.exists():
            continue
        for pack in sorted(p for p in packs_root.iterdir() if p.is_dir() and p.name not in RESERVED_PACK_NAMES):
            resolved = pack.resolve()
            if resolved in seen:
                continue
            has_registry = (
                (pack / NEW_UMBRELLA / "service-registry.json").exists()
                or (pack / LEGACY_UMBRELLA / "service-registry.json").exists()
                or (pack / "service-registry.json").exists()
            )
            if has_registry:
                seen.add(resolved)
                out.append(pack)
    return out


def _pack_registry(pack: Path) -> Path | None:
    for name in (NEW_UMBRELLA, LEGACY_UMBRELLA):
        candidate = pack / name / "service-registry.json"
        if candidate.exists():
            return candidate
    old = pack / "service-registry.json"
    return old if old.exists() else None


def migrate_existing_skills(project_root: Path) -> None:
    """Upgrade already-installed per-service SKILL.md files to the current canonical
    section set (idempotent, SEMANTIC-preserving)."""
    print("\n── Migrate existing skills ─────────────")
    migrator = SCRIPTS / "skill_migrator.py"
    packs = _packs_with_registry(project_root)
    if not migrator.exists() or not packs:
        print(f"{YELLOW}  ○{NC} nothing to migrate (no registry or migrator)")
        return
    changed = 0
    for pack in packs:
        registry = _pack_registry(pack)
        if registry is None:
            continue
        try:
            services = json.loads(registry.read_text(encoding="utf-8")).get("services", {})
        except json.JSONDecodeError:
            print(f"{YELLOW}  ○{NC} registry malformed in pack '{pack.name}'; skipping")
            continue
        for service_id, info in services.items():
            skill_rel = info.get("skill_path")
            if not skill_rel:
                continue
            skill_md = project_root / skill_rel
            if not skill_md.exists():
                continue
            r = subprocess.run(["python3", str(migrator), str(skill_md)],
                               capture_output=True, text=True, check=False)
            if r.returncode == 0 and r.stdout.strip().startswith("migrated:"):
                changed += 1
                print(f"{GREEN}  ✓{NC} upgraded {service_id} → devops sections")
    if changed == 0:
        print(f"{GREEN}  ✓{NC} all service skills already current")


def generate_umbrellas(project_root: Path) -> None:
    """Generate/refresh the per-repo umbrella SKILL.md (``<repo>-service-knowledge``)."""
    print("\n── Umbrella ────────────────────────────")
    generator = SCRIPTS / "umbrella_generator.py"
    packs = _packs_with_registry(project_root)
    if not generator.exists() or not packs:
        print(f"{YELLOW}  ○{NC} nothing to generate (no generator or packs)")
        return
    repo_name = project_root.name
    wrote = 0
    for pack in packs:
        env = {**os.environ, "XTRM_PACK": pack.name}
        r = subprocess.run(["python3", str(generator), repo_name],
                           cwd=str(project_root), env=env, capture_output=True, text=True, check=False)
        if r.returncode == 0 and r.stdout.strip().startswith("generated:"):
            wrote += 1
            print(f"{GREEN}  ✓{NC} umbrella refreshed for pack '{pack.name}' → {repo_name}-service-knowledge")
    if wrote == 0:
        print(f"{GREEN}  ✓{NC} all umbrellas already current")


def main() -> None:
    project_root = get_project_root()
    all_worktrees = "--all-worktrees" in sys.argv[1:]

    if "--hooks-only" in sys.argv[1:]:
        ok = install_git_hooks(project_root, all_worktrees=all_worktrees)
        if not ok:
            sys.exit(1)
        return

    print(f"Installing into: {project_root}")
    hooks_ok = install_git_hooks(project_root, all_worktrees=all_worktrees)
    migrate_existing_skills(project_root)
    generate_umbrellas(project_root)
    if not hooks_ok:
        sys.exit(1)
    print(f"\n{GREEN}Done.{NC}")
    print("  Migration applied. For the full, foolproof path use the package CLI:")
    print("      service-knowledge install")


if __name__ == "__main__":
    main()
