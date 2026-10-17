import { describe, expect, mock, test } from "bun:test";
// Complete mock: spread the real pi-tui so neighbouring suites sharing the
// module registry under full-suite runs keep working exports (matchesKey).
import * as realPiTui from "../../../../node_modules/@earendil-works/pi-tui/dist/index.js";

mock.module("@earendil-works/pi-tui", () => ({
	...(realPiTui as object),
	truncateToWidth: (value: string, width: number) => (value.length > width ? value.slice(0, width) : value),
}));

const { default: registerExtension, registerFooterSection } = await import("./index.ts");

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

function collectHandlers() {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (name: string, handler: Handler) => {
			handlers.set(name, handler);
		},
		getThinkingLevel: () => "off",
	} as never;
	registerExtension(pi);
	return handlers;
}

function makeCtx(setFooter: (factory: unknown) => void) {
	return {
		cwd: "/tmp",
		getContextUsage: () => null,
		model: { id: "test-model", contextWindow: 100_000 },
		ui: { setFooter },
	};
}

const tui = { requestRender: () => {} };
const theme = { fg: (_color: string, text: string) => text };
const footerData = {
	onBranchChange: () => () => {},
	getGitBranch: () => "main",
	getAvailableProviderCount: () => 1,
};

async function makeFooter() {
	const handlers = collectHandlers();
	let factory: ((tui: unknown, theme: unknown, footerData: unknown) => { render: (width: number) => string[] }) | null =
		null;
	await handlers.get("session_start")?.(
		{},
		makeCtx((captured: unknown) => {
			factory = captured as typeof factory;
		}),
	);
	if (!factory) throw new Error("setFooter was not called");
	const render = (width: number) => (factory as NonNullable<typeof factory>)(tui, theme, footerData).render(width);
	return { handlers, render };
}

describe("registerFooterSection seam", () => {
	test("statusline is a single line when no sections are registered", async () => {
		const { render } = await makeFooter();
		const lines = render(80);
		expect(lines).toHaveLength(1);
	});

	test("register + unregister leaves output byte-identical", async () => {
		const { render } = await makeFooter();
		const before = render(80);
		const unregister = registerFooterSection("fleet", () => ["fleet line"]);
		expect(render(80).join("\n")).not.toBe(before.join("\n"));
		unregister();
		expect(render(80)).toEqual(before);
	});

	test("sections append below the statusline in registration order", async () => {
		const { render } = await makeFooter();
		const base = render(80);
		const un1 = registerFooterSection("a", () => ["aaa"]);
		const un2 = registerFooterSection("b", () => ["bbb", "ccc"]);
		try {
			expect(render(80)).toEqual([...base, "aaa", "bbb", "ccc"]);
		} finally {
			un1();
			un2();
		}
	});

	test("section lines are width-truncated", async () => {
		const { render } = await makeFooter();
		const un = registerFooterSection("wide", () => ["x".repeat(200)]);
		try {
			const lines = render(40);
			expect(lines).toHaveLength(2);
			for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
		} finally {
			un();
		}
	});

	test("re-registering a key replaces the renderer", async () => {
		const { render } = await makeFooter();
		const base = render(80);
		const un1 = registerFooterSection("k", () => ["old"]);
		const un2 = registerFooterSection("k", () => ["new"]);
		try {
			expect(render(80)).toEqual([...base, "new"]);
		} finally {
			un1();
			un2();
		}
		expect(render(80)).toEqual(base);
	});

	test("a throwing section never breaks the statusline", async () => {
		const { render } = await makeFooter();
		const base = render(80);
		const un = registerFooterSection("boom", () => {
			throw new Error("section failure");
		});
		try {
			expect(render(80)).toEqual(base);
		} finally {
			un();
		}
	});

	test("footer-disabled path is a silent no-op", async () => {
		const { render, handlers } = await makeFooter();
		const base = render(80);
		// Footer absent: ctx without ui.setFooter disables the seam.
		await handlers.get("session_start")?.({}, { cwd: "/tmp" });
		const unregister = registerFooterSection("fleet", () => ["fleet line"]);
		try {
			expect(typeof unregister).toBe("function");
			unregister();
			expect(render(80)).toEqual(base);
		} finally {
			await handlers.get("session_shutdown")?.({}, {});
		}
	});
});

describe("globalThis hook publication (unitAI-plbug)", () => {
	test("importing the module publishes the hook", () => {
		collectHandlers(); // load publishes (idempotent)
		const g = globalThis as Record<string, unknown>;
		expect(g.__registerFooterSection).toBe(registerFooterSection);
	});

	test("section registered through the global hook renders", async () => {
		const { render } = await makeFooter();
		const g = globalThis as Record<string, unknown>;
		const hook = g.__registerFooterSection as typeof registerFooterSection;
		const base = render(80);
		const unregister = hook("via-global", () => ["global line"]);
		try {
			expect(render(80)).toEqual([...base, "global line"]);
		} finally {
			unregister();
		}
	});

	test("session_shutdown clears the hook", async () => {
		const { handlers } = await makeFooter();
		const g = globalThis as Record<string, unknown>;
		expect(g.__registerFooterSection).toBe(registerFooterSection);
		await handlers.get("session_shutdown")?.({}, {});
		expect(g.__registerFooterSection).toBeUndefined();
		// Restore for other tests / importers.
		collectHandlers();
	});

	test("double load is idempotent", () => {
		const g = globalThis as Record<string, unknown>;
		collectHandlers();
		collectHandlers();
		expect(g.__registerFooterSection).toBe(registerFooterSection);
	});

	test("shutdown does not clobber a foreign hook", async () => {
		const { handlers } = await makeFooter();
		const g = globalThis as Record<string, unknown>;
		const foreign = () => () => {};
		g.__registerFooterSection = foreign;
		try {
			await handlers.get("session_shutdown")?.({}, {});
			expect(g.__registerFooterSection).toBe(foreign);
		} finally {
			delete g.__registerFooterSection;
			collectHandlers();
		}
	});
});
