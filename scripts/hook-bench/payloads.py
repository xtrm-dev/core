"""Sample hook payloads for the CORE-2339 measurement harness.

Realistic shapes captured from Claude Code hook inputs. Each event returns a
list of samples; the harness cycles through them up to N. The same payloads
MUST be used for the before and after runs — comparability depends on it.

The Edit samples mix real files that exist in the target repo (cli/src TS, a
hook .py, README.md, package.json) plus one path outside the worktree so the
boundary guard's block path is exercised. The post-edit mix is what drives
the quality-check skip/run decision, so keep at least one of each class.
"""

from __future__ import annotations

import os


def _base(cwd: str, session_id: str, event: str, tool: str) -> dict:
    return {
        "session_id": session_id,
        "transcript_path": "/tmp/hook-bench-transcript.jsonl",
        "cwd": cwd,
        "hook_event_name": event,
        "tool_name": tool,
    }


def pre_bash(cwd: str, session_id: str) -> list[dict]:
    cmds = [
        "ls -la",
        "git status --short",
        "git log --oneline -5",
        "cat package.json",
        "rg hookEvent cli/src | head -20",
    ]
    return [{**_base(cwd, session_id, "PreToolUse", "Bash"), "tool_input": {"command": c}} for c in cmds]


def post_bash(cwd: str, session_id: str) -> list[dict]:
    out = [
        "total 64\ndrwxr-xr-x  8 dawid dawid 4096 Oct  2 13:00 .",
        " M cli/src/core/settings-audit.ts",
        "7210fe11 compat(runtime): widen specialists range\n2f5c3991 fix(CORE-2320): eval phrasing",
        '{"name": "xtrm-tools", "version": "0.13.0"}',
        "cli/src/core/claude-runtime-sync.ts:353:export async function readGlobalHooksConfig",
    ]
    cmds = ["ls -la", "git status --short", "git log --oneline -5", "cat package.json", "rg hookEvent cli/src | head -20"]
    samples = []
    for c, o in zip(cmds, out):
        samples.append({
            **_base(cwd, session_id, "PostToolUse", "Bash"),
            "tool_input": {"command": c},
            "tool_response": {"stdout": o},
        })
    return samples


def _edit_paths(cwd: str) -> list[str]:
    return [
        os.path.join(cwd, "cli/src/core/settings-audit.ts"),
        os.path.join(cwd, ".xtrm/hooks/quality-check.py"),
        os.path.join(cwd, "README.md"),
        os.path.join(cwd, "package.json"),
        "/tmp/hook-bench-outside-worktree.md",  # boundary block path
    ]


def pre_edit(cwd: str, session_id: str) -> list[dict]:
    return [{
        **_base(cwd, session_id, "PreToolUse", "Edit"),
        "tool_input": {"file_path": p},
    } for p in _edit_paths(cwd)]


def post_edit(cwd: str, session_id: str) -> list[dict]:
    return [{
        **_base(cwd, session_id, "PostToolUse", "Edit"),
        "tool_input": {"file_path": p},
        "tool_response": {"success": True},
    } for p in _edit_paths(cwd)]


def session(cwd: str, session_id: str) -> list[dict]:
    return [{
        "session_id": session_id,
        "transcript_path": "/tmp/hook-bench-transcript.jsonl",
        "cwd": cwd,
        "hook_event_name": "SessionStart",
        "source": "startup",
    }]


PAYLOADS = {
    "pre-bash": pre_bash,
    "post-bash": post_bash,
    "pre-edit": pre_edit,
    "post-edit": post_edit,
    "session": session,
}
