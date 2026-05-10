import { vi } from "vitest";

export interface MockUI {
	notify: any;
	confirm: any;
	select: any;
	setStatus: any;
	theme: {
		fg: any;
	};
}

export interface MockSessionManager {
	sessionId: string;
	getEntries: any;
	getLeafEntry: any;
	getBranch: any;
}

export interface MockContext {
	cwd: string;
	hasUI: boolean;
	ui: MockUI;
	sessionManager: MockSessionManager;
	getSystemPrompt: any;
}

export class ExtensionHarness {
	public handlers: Record<string, Function[]> = {};
	public commands: Record<string, any> = {};
	public tools: Record<string, any> = {};
	public ctx: MockContext;
	public pi: any;

	constructor(cwd: string = "/mock/project") {
		this.ctx = {
			cwd,
			hasUI: true,
			ui: {
				notify: vi.fn(),
				confirm: vi.fn().mockResolvedValue(true),
				select: vi.fn().mockResolvedValue(""),
				setStatus: vi.fn(),
				theme: {
					fg: vi.fn((_color: string, text: string) => text),
				},
			},
			sessionManager: {
				sessionId: "mock-session-123",
				getSessionId: vi.fn().mockReturnValue("mock-session-123"),
				getEntries: vi.fn().mockReturnValue([]),
				getLeafEntry: vi.fn().mockReturnValue({ id: "last-entry" }),
				getBranch: vi.fn().mockReturnValue([]),
			},
			getSystemPrompt: vi.fn().mockReturnValue("Default system prompt"),
		};

		this.pi = {
			on: (event: string, handler: Function) => {
				if (!this.handlers[event]) this.handlers[event] = [];
				this.handlers[event].push(handler);
			},
			exec: vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" }),
			registerCommand: (cmd: any) => {
				this.commands[cmd.name] = cmd;
			},
			registerTool: (tool: any) => {
				this.tools[tool.name] = tool;
			},
		};
	}

	async emit(event: string, data: any) {
		if (this.handlers[event]) {
			let lastResult: any = undefined;
			for (const handler of this.handlers[event]) {
				const res = await handler(data, this.ctx);
				if (res !== undefined) {
					lastResult = res;
				}
			}
			return lastResult;
		}
		return undefined;
	}
}
