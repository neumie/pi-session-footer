import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	FooterController,
	type FooterRuntimeDependencies,
} from "../extensions/controller.ts";
import {
	aggregateSubagents,
	formatModel,
	formatSubagentFooter,
	parseAsyncRunStart,
	parseAsyncRunStatus,
	parseBackgroundJobs,
} from "../extensions/domain.ts";
import { renderFooter, type ThemeLike } from "../extensions/layout.ts";
import extension from "../extensions/session-footer.ts";

type LifecycleHandler = (event: unknown, context: ExtensionContext) => unknown;
type BusHandler = (payload: unknown) => void;

class FakePi {
	readonly lifecycle = new Map<string, LifecycleHandler[]>();
	readonly bus = new Map<string, BusHandler[]>();
	readonly events = {
		on: (name: string, handler: BusHandler) => {
			this.bus.set(name, [...(this.bus.get(name) ?? []), handler]);
			return () =>
				this.bus.set(
					name,
					(this.bus.get(name) ?? []).filter((item) => item !== handler),
				);
		},
		emit: (name: string, payload: unknown) => {
			for (const handler of this.bus.get(name) ?? []) handler(payload);
		},
	};
	on(name: string, handler: LifecycleHandler): void {
		this.lifecycle.set(name, [...(this.lifecycle.get(name) ?? []), handler]);
	}
	getThinkingLevel(): "high" {
		return "high";
	}
	api(): ExtensionAPI {
		return this as unknown as ExtensionAPI;
	}
}

interface FakeUI {
	footerFactory?: (
		tui: TUI,
		theme: ThemeLike,
		footerData: { getExtensionStatuses(): ReadonlyMap<string, string> },
	) => { render(width: number): string[]; dispose?(): void };
	statusWrites: Array<{ key: string; value: string | undefined }>;
	widgetWrites: string[];
}

function makeContext(ui: FakeUI): ExtensionContext {
	return {
		cwd: "/tmp/project/emoji-🧪",
		model: { id: "gpt-5.6-sol" },
		isProjectTrusted: () => true,
		getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
		sessionManager: {
			getBranch: () => [],
			getSessionFile: () => "footer-test-session",
			getSessionId: () => "footer-test-session",
		},
		ui: {
			setStatus(key: string, value: string | undefined) {
				ui.statusWrites.push({ key, value });
			},
			setWidget(key: string) {
				ui.widgetWrites.push(key);
			},
			setFooter(factory: unknown) {
				ui.footerFactory = factory as FakeUI["footerFactory"];
			},
		},
	} as unknown as ExtensionContext;
}

function theme(): ThemeLike {
	return { fg: (_name, text) => text, bold: (text) => text };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	return {
		promise: new Promise<T>((done) => {
			resolve = done;
		}),
		resolve,
	};
}

function fakeDependencies(overrides: Partial<FooterRuntimeDependencies> = {}) {
	let now = 20_000;
	let nextTimer = 0;
	const timers = new Map<number, { callback(): void; milliseconds: number }>();
	const dependencies: FooterRuntimeDependencies = {
		now: () => now,
		setInterval(callback, milliseconds) {
			const id = ++nextTimer;
			timers.set(id, { callback, milliseconds });
			return id as unknown as ReturnType<typeof setInterval>;
		},
		clearInterval(timer) {
			timers.delete(timer as unknown as number);
		},
		readStatus: async () => undefined,
		readRunDirectories: async () => [],
		...overrides,
	};
	return {
		dependencies,
		timers,
		setNow: (value: number) => {
			now = value;
		},
	};
}

function createFooter(
	ui: FakeUI,
	requestRender: () => void,
	statuses = new Map<string, string>(),
) {
	assert.ok(ui.footerFactory);
	return ui.footerFactory!({ requestRender } as unknown as TUI, theme(), {
		getExtensionStatuses: () => statuses,
	});
}

test("domain sanitizes malformed optional payloads and keeps queued work distinct", () => {
	assert.equal(parseAsyncRunStart(null), undefined);
	assert.equal(parseAsyncRunStart({ id: 1, asyncDir: [] }), undefined);
	assert.equal(
		parseBackgroundJobs({ runningCount: "bad", primary: { command: 3 } })
			?.runningCount,
		0,
	);
	const status = parseAsyncRunStatus({
		state: "queued",
		steps: [null, { status: "queued", model: 4 }],
		totalTokens: { input: 12, output: 8 },
	});
	assert.deepEqual(status?.totalTokens, { input: 12, output: 8, total: 20 });
	const start = parseAsyncRunStart({
		id: "run",
		asyncDir: "/tmp/run",
		goal: "x\u001b[31m goal",
	});
	assert.ok(start);
	const aggregate = aggregateSubagents([{ start, status }]);
	assert.equal(aggregate.active.length, 0);
	assert.equal(aggregate.queued, 1);
	assert.equal(aggregate.tokens, 20);
	const footer = formatSubagentFooter([{ start, status }]);
	assert.match(footer?.summary ?? "", /agents 0 \(\+1 queued\).*20 tok/);
	assert.equal(footer?.activeCount, 0);
});

test("model formatting is shared and aggregates duplicate models", () => {
	assert.equal(formatModel("anthropic/claude-opus-4-8:high"), "opus-4-8");
	assert.equal(formatModel("openai/gpt-5.6-sol"), "GPT-5.6 Sol");
	const state = formatSubagentFooter([
		{
			start: { id: "run", asyncDir: "/tmp/run" },
			status: {
				state: "running",
				steps: [
					{ status: "running", model: "gpt-5.6-sol" },
					{ status: "running", model: "gpt-5.6-sol" },
				],
			},
		},
	]);
	assert.match(state?.summary ?? "", /GPT-5\.6 Sol ×2/);
});

test("pure layout preserves useful statuses, hides MCP/LSP noise, and fits Unicode text", () => {
	const lines = renderFooter(
		{
			cwd: "~/proj/🧪/e\u0301/very-long-leaf",
			trusted: true,
			modelId: "gpt-5.6-sol",
			thinkingLevel: "high",
			inputTokens: 1234,
			outputTokens: 99,
			contextUsage: { contextWindow: 200000, percent: 75 },
			statuses: new Map([
				["zeta", "Z status"],
				["alpha", "A status"],
			]),
			now: 20_000,
		},
		theme(),
		28,
	);
	assert.equal(lines.length, 2);
	assert.ok(lines.every((line) => visibleWidth(line) <= 28));
	const themed = renderFooter(
		{
			cwd: "~/x",
			trusted: true,
			modelId: "x",
			thinkingLevel: "off",
			inputTokens: 0,
			outputTokens: 0,
			statuses: new Map([
				["alpha", "\x1b[31mA styled\x1b[0m\n\x1b]unsafe\x07"],
				["mcp", "MCP: 0/4 servers"],
				["mcp-auth", "Authenticating calendar..."],
				["pi-lens-lsp", "LSP Active: typescript"],
				["zeta", "Z status"],
			]),
			now: 0,
		},
		{
			fg: (color, text) => `<${color}>${text}</${color}>`,
			bold: (text) => `<bold>${text}</bold>`,
		},
		500,
	);
	assert.match(themed[1], /<dim>.*\x1b\[31mA styled\x1b\[0m.*Z status<\/dim>/);
	assert.doesNotMatch(themed[1], /MCP:|Authenticating calendar|LSP Active:/);
	assert.doesNotMatch(themed[1], /\n|\x1b\]/);
});

test("controller uses direct TUI render, preserves status ownership, and shares one pulse timer", async () => {
	const pi = new FakePi();
	const status = {
		state: "running",
		steps: [{ status: "running", agent: "worker", model: "gpt-5.6-sol" }],
		totalTokens: { input: 2, output: 3 },
	};
	const fake = fakeDependencies({ readStatus: async () => status });
	const controller = new FooterController(pi.api(), fake.dependencies);
	controller.register();
	const ui: FakeUI = { statusWrites: [], widgetWrites: [] };
	const ctx = makeContext(ui);
	controller.start(ctx);
	let renderRequests = 0;
	const footer = createFooter(
		ui,
		() => {
			renderRequests++;
		},
		new Map([["other-extension", "kept"]]),
	);
	pi.events.emit("subagent:async-started", {
		id: "run",
		asyncDir: "/tmp/run",
		agent: "worker",
	});
	pi.events.emit("background-jobs:changed", {
		runningCount: 1,
		primary: { id: "job", command: "npm test", startedAt: 10_000 },
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(renderRequests > 0);
	assert.equal(
		[...fake.timers.values()].filter((timer) => timer.milliseconds === 60)
			.length,
		1,
	);
	assert.equal(
		[...fake.timers.values()].filter((timer) => timer.milliseconds === 500)
			.length,
		1,
	);
	assert.deepEqual(ui.statusWrites, []);
	assert.deepEqual(ui.widgetWrites, []);
	assert.match(footer.render(120).join("\n"), /kept/);
	footer.dispose?.();
	const before = renderRequests;
	pi.events.emit("background-jobs:changed", {
		runningCount: 1,
		primary: { id: "job", command: "npm test" },
	});
	assert.equal(renderRequests, before);
	controller.stop();
	assert.equal(fake.timers.size, 0);
	assert.equal([...pi.bus.values()].flat().length, 0);
});

test("restore keeps completed tokens while only restoring active runs", async () => {
	const pi = new FakePi();
	const statuses = new Map<string, unknown>([
		[
			"/tmp/completed",
			{
				sessionId: "footer-test-session",
				state: "complete",
				totalTokens: { input: 10, output: 15 },
			},
		],
		[
			"/tmp/active",
			{
				sessionId: "footer-test-session",
				state: "running",
				steps: [{ status: "running", agent: "worker" }],
				totalTokens: { input: 2, output: 3 },
			},
		],
	]);
	const fake = fakeDependencies({
		readRunDirectories: async () => [...statuses.keys()],
		readStatus: async (directory) => statuses.get(directory),
	});
	const controller = new FooterController(pi.api(), fake.dependencies);
	controller.register();
	const ui: FakeUI = { statusWrites: [], widgetWrites: [] };
	const ctx = makeContext(ui);
	const start = pi.lifecycle.get("session_start")?.[0];
	assert.ok(start);
	await start({}, ctx);
	const footer = createFooter(ui, () => {});
	const output = footer.render(200).join("\n");
	assert.match(output, /tok ↑12 ↓18/);
	assert.match(output, /agents 1/);
	assert.doesNotMatch(output, /agents 2/);
	controller.stop();
});

test("late async status completion cannot mutate a stopped generation", async () => {
	const pi = new FakePi();
	const pending = deferred<unknown>();
	const fake = fakeDependencies({ readStatus: () => pending.promise });
	const controller = new FooterController(pi.api(), fake.dependencies);
	controller.register();
	const ui: FakeUI = { statusWrites: [], widgetWrites: [] };
	controller.start(makeContext(ui));
	let renderRequests = 0;
	createFooter(ui, () => {
		renderRequests++;
	});
	pi.events.emit("subagent:async-started", { id: "run", asyncDir: "/tmp/run" });
	await new Promise((resolve) => setImmediate(resolve));
	controller.stop();
	pending.resolve({ state: "running", steps: [{ status: "running" }] });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(renderRequests, 0);
	assert.equal(fake.timers.size, 0);
	assert.equal([...pi.bus.values()].flat().length, 0);
});

test("default export registers the stable extension entry point", () => {
	const pi = new FakePi();
	extension(pi.api());
	assert.equal(pi.lifecycle.get("session_start")?.length, 1);
	assert.equal(pi.bus.get("subagent:async-started")?.length, 1);
});
