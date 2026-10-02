#!/usr/bin/env node
// specialists-agent-guard — Claude Code PreToolUse hook
// Blocks raw Agent tool usage only when a specialists workflow skill is active.
// Fail-open unless the active transcript/system prompt clearly contains using-specialists.

import { readFileSync, realpathSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logEvent } from './xtrm-logger.mjs';

// CORE-2339: decision logic exported for dispatch.mjs; CLI entry preserved.
/**
 * Decide the Agent-tool guard for a PreToolUse payload.
 * Returns { block: true, reason } when the raw Agent tool must be blocked,
 * or { block: false } otherwise. Fail-open unless the specialists marker is
 * clearly present (same semantics as the standalone hook).
 */
export function agentGuardDecision(input) {
  const toolName = input.tool_name ?? input.toolName ?? '';
  if (toolName !== 'Agent') return { block: false };
  if (!isSpecialistsWorkflowActive(input)) return { block: false };

  const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const sessionId = input.session_id ?? input.sessionId ?? null;
  const reason = 'Use specialists CLI instead of Agent tool. Route via: specialists run <name> --bead <id>';

  try {
    logEvent({
      cwd: resolve(cwd),
      runtime: 'claude',
      sessionId,
      layer: 'gate',
      kind: 'gate.specialists_agent.block',
      outcome: 'block',
      toolName: 'Agent',
      message: reason,
    });
  } catch { /* fail closed for the Agent tool, but ignore logging failures */ }

  return { block: true, reason };
}

function readJsonStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

function tailText(filePath, maxBytes = 256 * 1024) {
  try {
    if (!filePath || !existsSync(filePath)) return '';
    const stat = statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const raw = readFileSync(filePath);
    return raw.subarray(start).toString('utf8');
  } catch {
    return '';
  }
}

function hasSpecialistsSkillMarker(text) {
  return /<skill\s+name=["']using-specialists(?:-v2)?["']/i.test(text)
    || /name:\s*using-specialists(?:-v2)?\b/i.test(text)
    || /#\s*Specialists V2\b/i.test(text)
    || /#\s*Specialists Usage\b/i.test(text);
}

function isSpecialistsWorkflowActive(input) {
  const directText = [
    input?.system_prompt,
    input?.systemPrompt,
    input?.prompt,
    input?.message,
  ].filter(Boolean).join('\n');

  if (hasSpecialistsSkillMarker(directText)) return true;

  const transcriptPath = input?.transcript_path ?? input?.transcriptPath;
  return hasSpecialistsSkillMarker(tailText(transcriptPath));
}

function main() {
  const input = readJsonStdin();
  if (!input) process.exit(0);

  const decision = agentGuardDecision(input);
  if (!decision.block) process.exit(0);

  process.stdout.write(JSON.stringify({ decision: 'block', reason: decision.reason }) + '\n');
  process.exit(0);
}

// Symlink-safe CLI entry: repo-root `hooks/` is a symlink to .xtrm/hooks, and
// node resolves module identity through the real path while argv[1] keeps the
// symlink path — compare realpaths or the standalone entry never fires.
function isCliMain() {
  try {
    return Boolean(process.argv[1])
      && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isCliMain()) main();
