/**
 * CORE-2616 probe: registers every xtrm model tool into a fake Pi and pushes
 * valid, coercible and invalid arguments through Pi's own validation
 * (`validateToolArguments` from @earendil-works/pi-ai, which validates with
 * @earendil-works/pi-schema since Pi 1.5.0).
 *
 * It runs in its own process on purpose. Sibling suites call
 * `mock.module("typebox", ...)` process-wide (see python-kernel.test.ts), and
 * this probe must see the real TypeBox schemas the extensions register.
 *
 * Output: one JSON report on stdout. Exit 1 when any check fails.
 */

import { validateToolArguments } from "@earendil-works/pi-ai";
import backgroundExtension from "../../extensions/background/index.ts";
import { registerListAgentsTool } from "../../extensions/intercom/roster.ts";
import { registerSendMessageTool } from "../../extensions/intercom/sendmessage.ts";
import pythonKernelExtension from "../../extensions/python-kernel/index.ts";

type ToolDefinition = { name: string; parameters: Record<string, unknown> };
type Report = {
  tools: string[];
  checks: Array<{ tool: string; case: string; ok: boolean; detail?: string }>;
  failures: string[];
};

/** A tool is valid when Pi's validation returns without throwing. */
function accepts(tool: ToolDefinition, args: unknown): { ok: boolean; detail?: string } {
  try {
    validateToolArguments(tool as never, { name: tool.name, arguments: args } as never);
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message.split("\n")[0] : String(error) };
  }
}

function rejects(tool: ToolDefinition, args: unknown): { ok: boolean; detail?: string } {
  const result = accepts(tool, args);
  return result.ok ? { ok: false, detail: "arguments Pi must reject were accepted" } : { ok: true };
}

const tools = new Map<string, ToolDefinition>();
const fakePi = new Proxy(
  {},
  {
    get(_target, property) {
      if (property === "registerTool") {
        return (definition: ToolDefinition) => tools.set(definition.name, definition);
      }
      if (property === "getSettings") return () => ({});
      return () => {};
    },
  },
);

backgroundExtension(fakePi as never);
registerSendMessageTool(fakePi as never);
registerListAgentsTool(fakePi as never);
pythonKernelExtension(fakePi as never, {});

/** One row per tool: arguments that must pass, and arguments Pi must reject. */
const CASES: Array<{
  tool: string;
  valid: unknown[];
  invalid: Array<{ args: unknown; why: string }>;
}> = [
  {
    tool: "BashBackground",
    valid: [{ command: "sleep 1" }, { command: "sleep 1", description: "wait", timeout: 60000 }],
    invalid: [
      { args: {}, why: "command is required" },
      { args: { command: "" }, why: "command has minLength 1" },
    ],
  },
  {
    tool: "Monitor",
    valid: [{ command: "tail -f /dev/null" }, { ws: { url: "ws://127.0.0.1:1", protocols: ["v1"] } }],
    invalid: [{ args: { command: "" }, why: "command has minLength 1" }],
  },
  {
    tool: "BackgroundStop",
    valid: [{ task_id: "bg_1" }],
    invalid: [
      { args: {}, why: "task_id is required" },
      { args: { task_id: "" }, why: "task_id has minLength 1" },
    ],
  },
  {
    tool: "SendMessage",
    valid: [
      { to: "peer", message: "hi" },
      { to: "peer", message: "hi", attachments: [{ type: "snippet", name: "note", content: "x" }] },
      { to: "peer", message: "hi", scope: "project" },
    ],
    invalid: [
      { args: { to: "peer", message: "hi", attachments: [{ type: "bogus", name: "x" }] }, why: "attachment type is an enum" },
      { args: { to: "peer", message: "hi", scope: "world" }, why: "scope is an enum" },
    ],
  },
  {
    tool: "ListAgents",
    valid: [{}],
    invalid: [{ args: "not-an-object", why: "arguments must be an object" }],
  },
  {
    tool: "python",
    valid: [{ code: "1 + 1" }, { code: "print(1)", reset: true }],
    invalid: [{ args: {}, why: "code is required" }],
  },
];

const report: Report = { tools: [...tools.keys()].sort(), checks: [], failures: [] };

for (const entry of CASES) {
  const tool = tools.get(entry.tool);
  if (!tool) {
    report.failures.push(`${entry.tool}: tool was not registered`);
    continue;
  }
  for (const args of entry.valid) {
    const result = accepts(tool, args);
    report.checks.push({ tool: entry.tool, case: `accepts ${JSON.stringify(args)}`, ...result });
    if (!result.ok) report.failures.push(`${entry.tool}: Pi rejected valid arguments ${JSON.stringify(args)} (${result.detail})`);
  }
  for (const { args, why } of entry.invalid) {
    const result = rejects(tool, args);
    report.checks.push({ tool: entry.tool, case: `rejects ${JSON.stringify(args)} (${why})`, ...result });
    if (!result.ok) report.failures.push(`${entry.tool}: Pi accepted invalid arguments ${JSON.stringify(args)} (${why})`);
  }
}

// Pi validates the JSON Schema, whatever built it. A schema that only works
// with its in-memory TypeBox metadata would behave differently after a JSON
// round trip, so every registered schema must survive one unchanged.
for (const tool of tools.values()) {
  const roundTripped = JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>;
  for (const args of [{}, { command: "sleep 1" }, { code: "1 + 1" }, { task_id: "bg_1" }, { to: "peer", message: "hi" }]) {
    const live = accepts(tool, args);
    const fromJson = accepts({ name: tool.name, parameters: roundTripped }, args);
    const same = live.ok === fromJson.ok;
    report.checks.push({ tool: tool.name, case: `JSON round trip agrees on ${JSON.stringify(args)}`, ok: same });
    if (!same) report.failures.push(`${tool.name}: schema depends on non-JSON metadata for ${JSON.stringify(args)}`);
  }
}

console.log(JSON.stringify(report, null, 2));
if (report.failures.length > 0) process.exit(1);
