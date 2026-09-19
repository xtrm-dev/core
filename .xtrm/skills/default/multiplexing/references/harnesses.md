# Harness adapters

The semantic contract is stable; harness APIs are not. Inspect the current runtime and
extension/SDK help before using exact method names.

## Claude Code

Prefer Claude's native agent/subagent and communication facilities when the current
version exposes them. XTRM hooks/extensions may add lifecycle, inbox, or worktree
integration. Use terminal injection only as a compatibility fallback for a separately
hosted pane.

## Pi

Prefer Pi's extension/native agent communication and XTRM package integrations. Pi is a
first-class XTRM runtime; do not assume it must be driven through tmux keystrokes. The
installed extension set is the authority for available messaging, process, Python, MCP,
and lifecycle surfaces.

## Codex

Prefer the current Codex-native agent/session facilities exposed by the installed
runtime. When Codex is launched as a durable XTRM peer, keep the same Substrate Issue contract and
correlation/evidence rules even if its native transport differs from Pi or Claude.

## xt peers

`xt pi`, `xt claude`, and `xt codex` provide durable peer/session/worktree boundaries.
Use the active XTRM integration to discover identity and communicate. `xtmux` remains
useful for topology, terminal/session observability, and compatibility paths, but a tmux
pane is not the logical agent identity.

## Specialists

Specialists is a governed role/job execution backend. Load `/using-specialists`; do not
reimplement its lifecycle through generic multiplexing.