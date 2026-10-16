import type { ExtensionAPI, ToolCallEvent } from "@mariozechner/pi-coding-agent";
import { PI_MUTATING_FILE_TOOLS } from "./guard-rules";

export class EventAdapter {
	/**
	 * Checks if the tool event is a mutating file operation (write, edit, etc).
	 */
	static isMutatingFileTool(event: ToolCallEvent<any, any>): boolean {
		return PI_MUTATING_FILE_TOOLS.includes(event.toolName);
	}

	/**
	 * Extracts the target path from a tool input, resolving against the current working directory.
	 */
	static extractPathFromToolInput(event: ToolCallEvent<any, any>, cwd: string): string | null {
		const input = event.input;
		if (!input) return null;

		const pathRaw = input.path || input.file || input.filePath;
		if (typeof pathRaw === "string") {
			return pathRaw; // Usually Pi passes absolute paths anyway or paths relative to root
		}

		return null;
	}

	/**
	 * Safely formats a block reason string to ensure UI readiness.
	 */
	static formatBlockReason(prefix: string, details: string): string {
		return `${prefix}: ${details}`;
	}
}
