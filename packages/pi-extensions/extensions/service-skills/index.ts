import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SubprocessRunner } from "../../src/core";
import * as path from "node:path";
import * as fs from "node:fs";

// service-skills v2: the canonical machinery skill is `service-skills`; per-service
// skills + the registry live under the per-repo umbrella in .xtrm packs.
const MACHINERY_SKILL = "service-skills";

const GLOBAL_SKILL_ROOTS = [
	path.join(process.env.HOME || "", ".agents", "skills"),
	path.join(process.env.HOME || "", ".claude", "skills"),
];

function listPackDirs(cwd: string): string[] {
	const packsRoot = path.join(cwd, ".xtrm", "skills", "user", "packs");
	try {
		return fs
			.readdirSync(packsRoot, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => path.join(packsRoot, e.name))
			.sort();
	} catch {
		return [];
	}
}

export default function (pi: ExtensionAPI) {
	const getCwd = (ctx: any) => ctx.cwd || process.cwd();

	// Precedence mirrors bootstrap.get_registry_path: canonical .xtrm umbrella wins,
	// then flat pack-root, then legacy repo-root / .claude (never let stale shadow).
	const resolveRegistryPath = (cwd: string): string | null => {
		const packDirs = listPackDirs(cwd);
		for (const pack of packDirs) {
			const umbrella = path.join(pack, "service-skills", "service-registry.json");
			if (fs.existsSync(umbrella)) return umbrella;
		}
		for (const pack of packDirs) {
			const flat = path.join(pack, "service-registry.json");
			if (fs.existsSync(flat)) return flat;
		}
		for (const rel of ["service-registry.json", path.join(".claude", "skills", "service-registry.json")]) {
			const candidate = path.join(cwd, rel);
			if (fs.existsSync(candidate)) return candidate;
		}
		return null;
	};

	const resolveSkillScript = (cwd: string, scriptName: string): string | null => {
		const candidates = [
			path.join(cwd, ".claude", "skills", MACHINERY_SKILL, "scripts", scriptName),
			path.join(cwd, ".xtrm", "skills", "default", MACHINERY_SKILL, "scripts", scriptName),
		];
		for (const candidate of candidates) {
			if (fs.existsSync(candidate)) return candidate;
		}
		for (const root of GLOBAL_SKILL_ROOTS) {
			if (!root) continue;
			const candidate = path.join(root, MACHINERY_SKILL, "scripts", scriptName);
			if (fs.existsSync(candidate)) return candidate;
		}
		return null;
	};

	// 1. Catalog Injection
	pi.on("before_agent_start", async (event, ctx) => {
		const cwd = getCwd(ctx);
		const registryPath = resolveRegistryPath(cwd);
		if (!registryPath) return undefined;

		const catalogerPath = resolveSkillScript(cwd, "cataloger.py");
		if (!catalogerPath) return undefined;

		const result = await SubprocessRunner.run("python3", [catalogerPath], {
			cwd,
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: cwd,
				SERVICE_REGISTRY_PATH: registryPath,
			},
		});

		if (result.code === 0 && result.stdout.trim()) {
			return { systemPrompt: event.systemPrompt + "\n\n" + result.stdout.trim() };
		}
		return undefined;
	});

	const toClaudeToolName = (toolName: string): string => {
		if (toolName === "bash") return "Bash";
		if (toolName === "read_file") return "Read";
		if (toolName === "write" || toolName === "create_text_file") return "Write";
		if (toolName === "edit" || toolName === "replace_content" || toolName === "replace_lines" || toolName === "insert_at_line" || toolName === "delete_lines") return "Edit";
		if (toolName === "search_for_pattern") return "Grep";
		if (toolName === "find_file" || toolName === "list_dir") return "Glob";
		return toolName;
	};

	// 2. Drift Detection (skill activation is before_agent_start only — not per-tool)
	pi.on("tool_result", async (event, ctx) => {
		const cwd = getCwd(ctx);
		const registryPath = resolveRegistryPath(cwd);
		if (!registryPath) return undefined;

		const driftDetectorPath = resolveSkillScript(cwd, "drift_detector.py");
		if (!driftDetectorPath) return undefined;

		const hookInput = JSON.stringify({
			tool_name: toClaudeToolName(event.toolName),
			tool_input: event.input,
			cwd,
		});

		const result = await SubprocessRunner.run("python3", [driftDetectorPath], {
			cwd,
			input: hookInput,
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: cwd,
				SERVICE_REGISTRY_PATH: registryPath,
			},
			timeoutMs: 10000,
		});

		if (result.code === 0 && result.stdout.trim()) {
			const newContent = [...event.content];
			newContent.push({ type: "text", text: "\n\n" + result.stdout.trim() });
			return { content: newContent };
		}

		return undefined;
	});
}
