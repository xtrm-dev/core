#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

function patchFile(filePath, transforms) {
  if (!fs.existsSync(filePath)) return;
  let text = fs.readFileSync(filePath, 'utf8');
  const original = text;
  for (const t of transforms) text = t(text);
  if (text !== original) fs.writeFileSync(filePath, text, 'utf8');
}

function injectOnce(text, marker, insert) {
  if (text.includes(insert)) return text;
  if (!text.includes(marker)) return text;
  return text.replace(marker, insert + marker);
}

function patchSerena(baseDir) {
  const indexPath = path.join(baseDir, 'pi-serena-tools', 'index.ts');
  const responsesPath = path.join(baseDir, 'pi-serena-tools', 'serenaResponses.ts');

  patchFile(indexPath, [
    (s) => s.includes('from "@mariozechner/pi-tui"') ? s : s.replace(
      'import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";\n',
      'import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";\nimport { Text } from "@mariozechner/pi-tui";\n',
    ),
    (s) => injectOnce(
      s,
      '  registerSerenaTools({',
      '  const originalRegisterTool = pi.registerTool.bind(pi);\n' +
      '  (pi).registerTool = (tool) => {\n' +
      '    originalRegisterTool({\n' +
      '      ...tool,\n' +
      '      renderShell: "self",\n' +
      '      renderCall: tool.renderCall ?? ((_args, _theme) => new Text("", 0, 0)),\n' +
      '      renderResult: tool.renderResult ?? ((result, state, theme) => {\n' +
      '        if (state?.isPartial) return new Text(theme.fg("muted", "…"), 0, 0);\n' +
      '        const first = (result?.content ?? []).find((c) => c?.type === "text")?.text ?? "";\n' +
      '        const line = String(first).split("\\n")[0] || "ok";\n' +
      '        return new Text(theme.fg("toolOutput", line), 0, 0);\n' +
      '      }),\n' +
      '    });\n' +
      '  };\n\n'
    ),
  ]);

  patchFile(responsesPath, [
    (s) => s.includes('import fs from "node:fs";') ? s : `import fs from "node:fs";\nimport path from "node:path";\n${s}`,
    (s) => injectOnce(
      s,
      'export const createWithCommonHandling = (deps: {',
      'function isExternalCompactEnabled() {\n' +
      '  try {\n' +
      '    const p = path.join(process.env.HOME ?? "", ".pi", "agent", "settings.json");\n' +
      '    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));\n' +
      '    return cfg?.xtrmExternalCompact !== false;\n' +
      '  } catch {\n' +
      '    return true;\n' +
      '  }\n' +
      '}\n\n'
    ),
    (s) => s.replace(
      '      const text = await deps.callSerena(toolName, args, timeoutMs);\n      return wrapResult(text);',
      '      const text = await deps.callSerena(toolName, args, timeoutMs);\n      if (!isExternalCompactEnabled()) return wrapResult(text);\n      const lines = text ? text.split("\\n").length : 0;\n      return { content: [{ type: "text", text: `• serena ${toolName} · ${lines} lines` }] };',
    ),
  ]);
}

function patchGitnexus(baseDir) {
  const indexPath = path.join(baseDir, 'pi-gitnexus', 'src', 'index.ts');

  patchFile(indexPath, [
    (s) => s.includes("from '@mariozechner/pi-tui'") ? s : s.replace(
      "import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';\n",
      "import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';\nimport { Text } from '@mariozechner/pi-tui';\nimport fs from 'node:fs';\nimport path from 'node:path';\n",
    ),
    (s) => injectOnce(
      s,
      "const SEARCH_TOOLS = new Set(['grep', 'find', 'bash', 'read', 'read_many']);",
      "\nfunction isExternalCompactEnabled() {\n" +
      "  try {\n" +
      "    const p = path.join(process.env.HOME ?? '', '.pi', 'agent', 'settings.json');\n" +
      "    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));\n" +
      "    return cfg?.xtrmExternalCompact !== false;\n" +
      "  } catch {\n" +
      "    return true;\n" +
      "  }\n" +
      "}\n"
    ),
    (s) => injectOnce(
      s,
      '  registerTools(pi);',
      '  const originalRegisterTool = pi.registerTool.bind(pi);\n' +
      '  (pi).registerTool = (tool) => {\n' +
      '    originalRegisterTool({\n' +
      '      ...tool,\n' +
      '      renderShell: "self",\n' +
      '      renderCall: tool.renderCall ?? ((_args, _theme) => new Text("", 0, 0)),\n' +
      '      renderResult: tool.renderResult ?? ((result, state, theme) => {\n' +
      '        if (state?.isPartial) return new Text(theme.fg("muted", "…"), 0, 0);\n' +
      '        const first = (result?.content ?? []).find((c) => c?.type === "text")?.text ?? "";\n' +
      '        const line = String(first).split("\\n")[0] || "ok";\n' +
      '        return new Text(theme.fg("toolOutput", line), 0, 0);\n' +
      '      }),\n' +
      '    });\n' +
      '  };\n\n'
    ),
    (s) => s.replace(
      "if (!event.isError && event.toolName.startsWith('gitnexus_')) {",
      "if (!event.isError && event.toolName.startsWith('gitnexus_') && isExternalCompactEnabled()) {",
    ),
  ]);
}

function collectNodeModuleRoots() {
  const roots = new Set();

  // NVM layout (current primary setup)
  const nvmBase = path.join(homedir(), '.nvm', 'versions', 'node');
  if (fs.existsSync(nvmBase)) {
    for (const v of fs.readdirSync(nvmBase).filter((x) => x.startsWith('v'))) {
      const modules = path.join(nvmBase, v, 'lib', 'node_modules');
      if (fs.existsSync(modules)) roots.add(modules);
    }
  }

  // Generic npm/pnpm global roots
  for (const cmd of [
    ['npm', ['root', '-g']],
    ['pnpm', ['root', '-g']],
  ]) {
    const [bin, args] = cmd;
    const out = spawnSync(bin, args, { encoding: 'utf8' });
    if (out.status === 0) {
      const root = (out.stdout || '').trim();
      if (root && fs.existsSync(root)) roots.add(root);
    }
  }

  return [...roots];
}

function main() {
  const roots = collectNodeModuleRoots();
  for (const modules of roots) {
    patchSerena(modules);
    patchGitnexus(modules);
  }
}

main();
