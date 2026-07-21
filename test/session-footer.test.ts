import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
import {
	discoverRelatedSessionFiles,
	discoverRunDirectories,
	sessionTokensFromFile,
} from "../extensions/tokens.ts";

type LifecycleHandler = (event: unknown, context: ExtensionContext) => unknown;
type BusHandler = (payload: unknown) => void;

class FakePi {
	readonly lifecycle = new Map<string, LifecycleHandler[]>();
	readonly bus = new Map<string, BusHandler[]>();
	readonly entries: unknown[] = [];
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
	appendEntry(customType: string, data?: unknown): void {
		this.entries.push({ type: "custom", customType, data });
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

function makeContext(
	ui: FakeUI,
	branchEntries: unknown[] = [],
	sessionFile = "footer-test-session",
): ExtensionContext {
	return {
		cwd: "/tmp/project/emoji-🧪",
		model: { id: "gpt-5.6-sol" },
		isProjectTrusted: () => true,
		getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
		sessionManager: {
			getBranch: () => branchEntries,
			getSessionFile: () => sessionFile,
			getSessionId: () => sessionFile,
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
		canonicalPath: async (path) => path,
		readRelatedSessionFiles: async (sessionFile) => [sessionFile],
		readSessionTokens: async () => undefined,
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
	assert.match(footer?.summary ?? "", /agents 0 \(\+1 queued\).*20$/);
	assert.doesNotMatch(footer?.summary ?? "", /\btok\b/);
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

test("pure layout applies product-selected status omissions and fits Unicode text", () => {
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
	assert.match(themed[0], /<success>trusted<\/success>/);
	assert.match(
		themed[1],
		/<dim>off<\/dim>.*<muted>—<\/muted>.*<text>↑0 ↓0<\/text>/,
	);
	assert.match(themed[1], /<dim>.*\x1b\[31mA styled\x1b\[0m.*Z status<\/dim>/);
	assert.doesNotMatch(themed.join("\n"), /\b(?:project|effort|tok|ctx)\b/);
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

test("token updates accept Pi's fresh context wrappers for the current session only", async () => {
	const pi = new FakePi();
	const controller = new FooterController(pi.api(), fakeDependencies().dependencies);
	controller.register();
	const ui: FakeUI = { statusWrites: [], widgetWrites: [] };
	const branch: unknown[] = [];
	const startContext = makeContext(ui, branch);
	const start = pi.lifecycle.get("session_start")?.[0];
	const turnEnd = pi.lifecycle.get("turn_end")?.[0];
	assert.ok(start);
	assert.ok(turnEnd);
	await start({}, startContext);
	const footer = createFooter(ui, () => {});

	const foreignBranch = [
		{
			type: "message",
			message: { role: "assistant", usage: { input: 999, output: 999 } },
		},
	];
	await turnEnd({}, makeContext(ui, foreignBranch, "foreign-session"));
	assert.match(footer.render(200).join("\n"), /↑0 ↓0/);

	branch.push({
		type: "message",
		message: { role: "assistant", usage: { input: 12, output: 18 } },
	});
	const nextContext = {
		...startContext,
	} as ExtensionContext;
	assert.notEqual(nextContext, startContext);
	assert.equal(nextContext.sessionManager, startContext.sessionManager);
	await turnEnd({}, nextContext);
	assert.match(footer.render(200).join("\n"), /↑12 ↓18/);
	controller.stop();
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
	assert.match(output, /↑12 ↓18/);
	assert.match(output, /agents 1/);
	assert.doesNotMatch(output, /agents 2/);
	controller.stop();
});

test("completed async token totals survive reload without temporary status artifacts", async () => {
	const firstPi = new FakePi();
	const firstFake = fakeDependencies({
		readStatus: async () => ({
			state: "complete",
			totalTokens: { input: 10, output: 15 },
		}),
	});
	const first = new FooterController(firstPi.api(), firstFake.dependencies);
	first.register();
	const firstUi: FakeUI = { statusWrites: [], widgetWrites: [] };
	first.start(makeContext(firstUi, firstPi.entries));
	firstPi.events.emit("subagent:async-started", {
		id: "run",
		asyncDir: "/tmp/run",
	});
	firstPi.events.emit("subagent:async-complete", {
		runId: "run",
		sessionId: "footer-test-session",
		sessionFile: "/tmp/footer-test-session/run/session.jsonl",
		totalTokens: { input: 10, output: 15, total: 25 },
	});
	await new Promise((resolve) => setImmediate(resolve));
	first.stop();

	const secondPi = new FakePi();
	secondPi.entries.push(...firstPi.entries);
	const secondFake = fakeDependencies({
		readRunDirectories: async () => ["/tmp/run"],
		readStatus: async () => ({
			sessionId: "footer-test-session",
			state: "complete",
			totalTokens: { input: 10, output: 15, total: 25 },
		}),
	});
	const second = new FooterController(secondPi.api(), secondFake.dependencies);
	second.register();
	const secondUi: FakeUI = { statusWrites: [], widgetWrites: [] };
	const start = secondPi.lifecycle.get("session_start")?.[0];
	assert.ok(start);
	await start({}, makeContext(secondUi, secondPi.entries));
	const footer = createFooter(secondUi, () => {});
	assert.match(footer.render(200).join("\n"), /↑10 ↓15/);
	second.stop();
});

test("completion events remain authoritative over stale in-flight status reads", async () => {
	const pi = new FakePi();
	const pending = deferred<unknown>();
	const fake = fakeDependencies({ readStatus: () => pending.promise });
	const controller = new FooterController(pi.api(), fake.dependencies);
	controller.register();
	const ui: FakeUI = { statusWrites: [], widgetWrites: [] };
	controller.start(makeContext(ui, pi.entries));
	pi.events.emit("subagent:async-started", {
		id: "run",
		asyncDir: "/tmp/run",
	});
	await new Promise((resolve) => setImmediate(resolve));
	pi.events.emit("subagent:async-complete", {
		runId: "run",
		sessionId: "footer-test-session",
		sessionFile: "/tmp/footer-test-session/run/session.jsonl",
		totalTokens: { input: 100, output: 20, total: 120 },
	});
	pending.resolve({
		state: "complete",
		totalTokens: { input: 10, output: 2, total: 12 },
	});
	await new Promise((resolve) => setImmediate(resolve));
	const footer = createFooter(ui, () => {});
	assert.match(footer.render(200).join("\n"), /↑100 ↓20/);
	controller.stop();
});

test("multi-run refresh discards snapshots completed during a later status read", async () => {
	const pi = new FakePi();
	const firstStatus = deferred<unknown>();
	const secondStatus = deferred<unknown>();
	const fake = fakeDependencies({
		readStatus: (asyncDir) =>
			asyncDir.endsWith("run-a") ? firstStatus.promise : secondStatus.promise,
	});
	const controller = new FooterController(pi.api(), fake.dependencies);
	controller.register();
	const ui: FakeUI = { statusWrites: [], widgetWrites: [] };
	controller.start(makeContext(ui, pi.entries));
	pi.events.emit("subagent:async-started", {
		id: "run-a",
		asyncDir: "/tmp/run-a",
	});
	pi.events.emit("subagent:async-started", {
		id: "run-b",
		asyncDir: "/tmp/run-b",
	});
	firstStatus.resolve({
		state: "running",
		steps: [{ agent: "worker", status: "running" }],
	});
	await new Promise((resolve) => setImmediate(resolve));
	pi.events.emit("subagent:async-complete", {
		runId: "run-a",
		sessionId: "footer-test-session",
		sessionFile: "/tmp/footer-test-session/run-a/session.jsonl",
		totalTokens: { input: 100, output: 20, total: 120 },
	});
	secondStatus.resolve({ state: "complete" });
	await new Promise((resolve) => setImmediate(resolve));
	const footer = createFooter(ui, () => {});
	assert.doesNotMatch(footer.render(200).join("\n"), /agents 1/);
	controller.stop();
});

test("completion events from another parent session are ignored", () => {
	const pi = new FakePi();
	const fake = fakeDependencies();
	const controller = new FooterController(pi.api(), fake.dependencies);
	controller.register();
	const ui: FakeUI = { statusWrites: [], widgetWrites: [] };
	controller.start(makeContext(ui, pi.entries));
	pi.events.emit("subagent:async-complete", {
		runId: "foreign-run",
		sessionId: "another-session",
		totalTokens: { input: 100, output: 20, total: 120 },
	});
	const footer = createFooter(ui, () => {});
	assert.match(footer.render(200).join("\n"), /↑0 ↓0/);
	assert.equal(pi.entries.length, 0);
	controller.stop();
});

test("legacy migration reconciles overlapping durable run snapshots", async () => {
	const pi = new FakePi();
	const childSession = "/tmp/footer-test-session/run/session.jsonl";
	pi.entries.push(
		{
			type: "custom_message",
			customType: "subagent-notify",
			content: `Session file: ${childSession}`,
		},
		{
			type: "custom",
			customType: "pi-session-footer:async-tokens",
			data: {
				version: 1,
				id: "run:run",
				totalTokens: { input: 100, output: 20, total: 120 },
				completedAt: 900,
				sessionFiles: [childSession],
			},
		},
	);
	const fake = fakeDependencies({
		readSessionTokens: async () => ({ input: 100, output: 20, total: 120 }),
	});
	const controller = new FooterController(pi.api(), fake.dependencies);
	controller.register();
	const ui: FakeUI = { statusWrites: [], widgetWrites: [] };
	const start = pi.lifecycle.get("session_start")?.[0];
	assert.ok(start);
	await start(
		{},
		makeContext(ui, pi.entries, "/tmp/footer-test-session.jsonl"),
	);
	const footer = createFooter(ui, () => {});
	assert.match(footer.render(200).join("\n"), /↑100 ↓20/);
	controller.stop();
});

test("legacy migration persists nothing until every child can be read", async () => {
	const pi = new FakePi();
	const first = "/tmp/footer-test-session/first/session.jsonl";
	const second = "/tmp/footer-test-session/second/session.jsonl";
	for (const sessionFile of [first, second]) {
		pi.entries.push({
			type: "custom_message",
			customType: "subagent-notify",
			content: `Session file: ${sessionFile}`,
		});
	}
	const fake = fakeDependencies({
		readSessionTokens: async (sessionFile) =>
			sessionFile === first
				? { input: 10, output: 2, total: 12 }
				: undefined,
	});
	const controller = new FooterController(pi.api(), fake.dependencies);
	controller.register();
	const ui: FakeUI = { statusWrites: [], widgetWrites: [] };
	const start = pi.lifecycle.get("session_start")?.[0];
	assert.ok(start);
	await start(
		{},
		makeContext(ui, pi.entries, "/tmp/footer-test-session.jsonl"),
	);
	const footer = createFooter(ui, () => {});
	assert.match(footer.render(200).join("\n"), /↑0 ↓0/);
	assert.equal(
		pi.entries.some(
			(entry) =>
				typeof entry === "object" &&
				entry !== null &&
				"customType" in entry &&
				entry.customType === "pi-session-footer:async-tokens",
		),
		false,
	);
	controller.stop();

	const retryPi = new FakePi();
	retryPi.entries.push(...pi.entries);
	const retryFake = fakeDependencies({
		readSessionTokens: async (sessionFile) =>
			sessionFile === first
				? { input: 10, output: 2, total: 12 }
				: { input: 20, output: 3, total: 23 },
	});
	const retry = new FooterController(retryPi.api(), retryFake.dependencies);
	retry.register();
	const retryUi: FakeUI = { statusWrites: [], widgetWrites: [] };
	const retryStart = retryPi.lifecycle.get("session_start")?.[0];
	assert.ok(retryStart);
	await retryStart(
		{},
		makeContext(
			retryUi,
			retryPi.entries,
			"/tmp/footer-test-session.jsonl",
		),
	);
	const retryFooter = createFooter(retryUi, () => {});
	assert.match(retryFooter.render(200).join("\n"), /↑30 ↓5/);
	retry.stop();
});

test("legacy migration rejects a contained symlink that resolves outside", async () => {
	const pi = new FakePi();
	const childSession = "/tmp/footer-test-session/run/session.jsonl";
	pi.entries.push({
		type: "custom_message",
		customType: "subagent-notify",
		content: `Session file: ${childSession}`,
	});
	let tokenReads = 0;
	const fake = fakeDependencies({
		canonicalPath: async (candidate) =>
			candidate === "/tmp/footer-test-session"
				? candidate
				: "/tmp/outside/session.jsonl",
		readSessionTokens: async () => {
			tokenReads++;
			return { input: 100, output: 20, total: 120 };
		},
	});
	const controller = new FooterController(pi.api(), fake.dependencies);
	controller.register();
	const ui: FakeUI = { statusWrites: [], widgetWrites: [] };
	const start = pi.lifecycle.get("session_start")?.[0];
	assert.ok(start);
	await start(
		{},
		makeContext(ui, pi.entries, "/tmp/footer-test-session.jsonl"),
	);
	assert.equal(tokenReads, 0);
	controller.stop();
});

test("legacy migration retries when any discovered sibling is unavailable", async () => {
	const pi = new FakePi();
	const childSession = "/tmp/footer-test-session/run-0/session.jsonl";
	const missingSibling = "/tmp/footer-test-session/run-1/session.jsonl";
	pi.entries.push({
		type: "custom_message",
		customType: "subagent-notify",
		content: `Session file: ${childSession}`,
	});
	let tokenReads = 0;
	const fake = fakeDependencies({
		readRelatedSessionFiles: async () => [childSession, missingSibling],
		canonicalPath: async (candidate) =>
			candidate === missingSibling ? undefined : candidate,
		readSessionTokens: async () => {
			tokenReads++;
			return { input: 100, output: 20, total: 120 };
		},
	});
	const controller = new FooterController(pi.api(), fake.dependencies);
	controller.register();
	const ui: FakeUI = { statusWrites: [], widgetWrites: [] };
	const start = pi.lifecycle.get("session_start")?.[0];
	assert.ok(start);
	await start(
		{},
		makeContext(ui, pi.entries, "/tmp/footer-test-session.jsonl"),
	);
	assert.equal(tokenReads, 0);
	assert.equal(
		pi.entries.some(
			(entry) =>
				typeof entry === "object" &&
				entry !== null &&
				"customType" in entry &&
				entry.customType === "pi-session-footer:async-tokens",
		),
		false,
	);
	controller.stop();
});

test("legacy migration reads the canonical path it validated", async () => {
	const pi = new FakePi();
	const lexicalRoot = "/tmp/footer-test-session";
	const lexicalSession = `${lexicalRoot}/run/session.jsonl`;
	const canonicalRoot = "/private/tmp/footer-test-session";
	const canonicalSession = `${canonicalRoot}/run/session.jsonl`;
	pi.entries.push({
		type: "custom_message",
		customType: "subagent-notify",
		content: `Session file: ${lexicalSession}`,
	});
	let readPath: string | undefined;
	const fake = fakeDependencies({
		canonicalPath: async (candidate) =>
			candidate === lexicalRoot ? canonicalRoot : canonicalSession,
		readSessionTokens: async (sessionFile) => {
			readPath = sessionFile;
			return { input: 100, output: 20, total: 120 };
		},
	});
	const controller = new FooterController(pi.api(), fake.dependencies);
	controller.register();
	const ui: FakeUI = { statusWrites: [], widgetWrites: [] };
	const start = pi.lifecycle.get("session_start")?.[0];
	assert.ok(start);
	await start(
		{},
		makeContext(ui, pi.entries, "/tmp/footer-test-session.jsonl"),
	);
	assert.equal(readPath, canonicalSession);
	controller.stop();
});

test("legacy migration streams every sibling child session on its active branch", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-footer-migration-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const parentSession = path.join(root, "parent.jsonl");
	const runRoot = path.join(root, "parent", "async-run");
	const first = path.join(runRoot, "run-0", "session.jsonl");
	const second = path.join(runRoot, "run-1", "session.jsonl");
	await mkdir(path.dirname(first), { recursive: true });
	await mkdir(path.dirname(second), { recursive: true });
	await writeFile(
		first,
		`${JSON.stringify({ id: "a", type: "message", message: { role: "assistant", usage: { input: 3, output: 2 } } })}\n`,
	);
	await writeFile(
		second,
		[
			{ id: "a", type: "message", message: { role: "assistant", usage: { input: 5, output: 1 } } },
			{ id: "b", parentId: "a", type: "message", message: { role: "assistant", usage: { input: 7, output: 2 } } },
			{ id: "c", parentId: "a", type: "message", message: { role: "assistant", usage: { input: 100, output: 10 } } },
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n") + "\n",
	);

	const pi = new FakePi();
	pi.entries.push({
		type: "custom_message",
		customType: "subagent-notify",
		content: `Session file: ${second}`,
	});
	const controller = new FooterController(pi.api(), {
		readRunDirectories: async () => [],
	});
	controller.register();
	const ui: FakeUI = { statusWrites: [], widgetWrites: [] };
	const start = pi.lifecycle.get("session_start")?.[0];
	assert.ok(start);
	await start({}, makeContext(ui, pi.entries, parentSession));
	const footer = createFooter(ui, () => {});
	assert.match(footer.render(200).join("\n"), /↑108 ↓13/);
	controller.stop();
});

test("session token reader rejects bounded byte, line, and line-count overflow", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-footer-limits-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sessionFile = path.join(root, "session.jsonl");
	const limits = {
		maxBytes: 64,
		maxLineBytes: 16,
		maxLines: 10,
		maxEntries: 10,
	};

	await writeFile(sessionFile, `${"x".repeat(17)}\n`);
	assert.equal(await sessionTokensFromFile(sessionFile, limits), undefined);

	await writeFile(sessionFile, `${"x".repeat(65)}\n`);
	assert.equal(await sessionTokensFromFile(sessionFile, limits), undefined);

	await writeFile(sessionFile, "\n".repeat(11));
	assert.equal(await sessionTokensFromFile(sessionFile, limits), undefined);

	const entryLimits = {
		...limits,
		maxBytes: 4_096,
		maxLineBytes: 256,
		maxLines: 100,
	};
	await writeFile(
		sessionFile,
		Array.from({ length: 11 }, () => JSON.stringify({ id: "duplicate" })).join(
			"\n",
		),
	);
	assert.equal(
		await sessionTokensFromFile(sessionFile, entryLimits),
		undefined,
	);

	await writeFile(sessionFile, `${"{}\n".repeat(11)}`);
	assert.equal(
		await sessionTokensFromFile(sessionFile, entryLimits),
		undefined,
	);
});

test("directory discovery rejects scan and sibling-count overflow", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-footer-directories-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const name of ["run-0", "run-1", "run-2"]) {
		await mkdir(path.join(root, name));
	}
	const sessionFile = path.join(root, "run-0", "session.jsonl");

	assert.equal(
		await discoverRelatedSessionFiles(sessionFile, {
			maxDirectoryEntries: 10,
			maxSessions: 2,
		}),
		undefined,
	);
	assert.equal(
		await discoverRelatedSessionFiles(sessionFile, {
			maxDirectoryEntries: 2,
			maxSessions: 3,
		}),
		undefined,
	);
	assert.equal((await discoverRunDirectories(root, 2)) ?? null, null);

	const related = await discoverRelatedSessionFiles(sessionFile, {
		maxDirectoryEntries: 3,
		maxSessions: 3,
	});
	assert.equal(related?.length, 3);
	assert.equal((await discoverRunDirectories(root, 3))?.length, 3);
});

test("legacy async notifications rebuild tokens once when temporary artifacts are gone", async () => {
	const pi = new FakePi();
	const childSession = "/tmp/footer-test-session/run/session.jsonl";
	pi.entries.push({
		type: "custom_message",
		customType: "subagent-notify",
		content: `Background task completed\n\nSession file: ${childSession}`,
	});
	let reads = 0;
	const staleStatus = {
		sessionId: "/tmp/footer-test-session.jsonl",
		state: "complete",
		endedAt: 900,
		steps: [{ sessionFile: childSession, status: "complete" }],
		totalTokens: { input: 10, output: 2, total: 12 },
	};
	const fake = fakeDependencies({
		readRunDirectories: async () => ["/tmp/stale-run"],
		readStatus: async () => staleStatus,
		readSessionTokens: async (sessionFile: string) => {
			reads++;
			assert.equal(sessionFile, childSession);
			return { input: 100, output: 20, total: 120 };
		},
	});
	const controller = new FooterController(pi.api(), fake.dependencies);
	controller.register();
	const ui: FakeUI = { statusWrites: [], widgetWrites: [] };
	const start = pi.lifecycle.get("session_start")?.[0];
	assert.ok(start);
	await start(
		{},
		makeContext(ui, pi.entries, "/tmp/footer-test-session.jsonl"),
	);
	const footer = createFooter(ui, () => {});
	assert.match(footer.render(200).join("\n"), /↑100 ↓20/);
	assert.equal(reads, 1);
	assert.equal(
		pi.entries.filter(
			(entry) =>
				typeof entry === "object" &&
				entry !== null &&
				"customType" in entry &&
				entry.customType === "pi-session-footer:async-tokens",
		).length,
		1,
	);
	controller.stop();

	const reloadedPi = new FakePi();
	reloadedPi.entries.push(...pi.entries);
	const reloadedFake = fakeDependencies({
		readRunDirectories: async () => ["/tmp/stale-run"],
		readStatus: async () => staleStatus,
		readSessionTokens: async () => {
			reads++;
			return undefined;
		},
	});
	const reloaded = new FooterController(
		reloadedPi.api(),
		reloadedFake.dependencies,
	);
	reloaded.register();
	const reloadedUi: FakeUI = { statusWrites: [], widgetWrites: [] };
	const reloadStart = reloadedPi.lifecycle.get("session_start")?.[0];
	assert.ok(reloadStart);
	await reloadStart(
		{},
		makeContext(
			reloadedUi,
			reloadedPi.entries,
			"/tmp/footer-test-session.jsonl",
		),
	);
	const reloadedFooter = createFooter(reloadedUi, () => {});
	assert.match(reloadedFooter.render(200).join("\n"), /↑100 ↓20/);
	assert.equal(reads, 1);
	reloaded.stop();
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
