import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { readdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	formatSubagentFooter,
	isFinishedState,
	parseAsyncRunStart,
	parseAsyncRunStatus,
	parseBackgroundJobs,
	type AsyncRunStart,
	type AsyncRunStatus,
	type BackgroundJobsFooterState,
	type SubagentFooterState,
	type TokenUsage,
} from "./domain.ts";
import { renderFooter, type ThemeLike } from "./layout.ts";

interface FooterDataLike {
	getExtensionStatuses(): ReadonlyMap<string, string>;
}

type Timer = ReturnType<typeof setInterval>;

export interface FooterRuntimeDependencies {
	now(): number;
	setInterval(handler: () => void, milliseconds: number): Timer;
	clearInterval(timer: Timer): void;
	readStatus(asyncDir: string): Promise<unknown>;
	readRunDirectories(): Promise<string[]>;
}

const PULSE_FRAME_MS = 60;
const POLL_INTERVAL_MS = 500;

function defaultDependencies(): FooterRuntimeDependencies {
	return {
		now: () => Date.now(),
		setInterval(handler, milliseconds) {
			const timer = setInterval(handler, milliseconds);
			timer.unref?.();
			return timer;
		},
		clearInterval(timer) {
			clearInterval(timer);
		},
		async readStatus(asyncDir) {
			try {
				return JSON.parse(
					await readFile(join(asyncDir, "status.json"), "utf8"),
				) as unknown;
			} catch {
				return undefined;
			}
		},
		async readRunDirectories() {
			const uid =
				typeof process.getuid === "function" ? process.getuid() : undefined;
			if (uid === undefined) return [];
			try {
				const root = join(
					tmpdir(),
					`pi-subagents-uid-${uid}`,
					"async-subagent-runs",
				);
				const entries = await readdir(root, { withFileTypes: true });
				return entries
					.filter((entry) => entry.isDirectory())
					.map((entry) => join(root, entry.name));
			} catch {
				return [];
			}
		},
	};
}

interface SessionRuntime {
	generation: number;
	ctx: ExtensionContext;
	modelId?: string;
	runs: Map<string, AsyncRunStart>;
	tokens: Map<string, TokenUsage>;
	mainTokens: TokenUsage;
	subagents?: SubagentFooterState;
	backgroundJobs?: BackgroundJobsFooterState;
	refreshing: boolean;
}

function zeroTokens(): TokenUsage {
	return { input: 0, output: 0, total: 0 };
}

function sessionTokens(ctx: ExtensionContext): TokenUsage {
	const result = zeroTokens();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant")
			continue;
		const usage = (entry.message as AssistantMessage).usage;
		result.input += usage.input;
		result.output += usage.output;
	}
	result.total = result.input + result.output;
	return result;
}

function displayCwd(cwd: string): string {
	const home = homedir();
	if (!home) return cwd;
	const rel = relative(resolve(home), resolve(cwd));
	const insideHome =
		rel === "" ||
		(rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	return insideHome ? (rel ? `~${sep}${rel}` : "~") : cwd;
}

function thinkingLevel(pi: ExtensionAPI): string {
	try {
		return pi.getThinkingLevel();
	} catch {
		return "off";
	}
}

/**
 * One extension instance owns exactly one controller. Session data, timers,
 * direct TUI render callback, and optional-event subscriptions all live here.
 */
export class FooterController {
	private readonly dependencies: FooterRuntimeDependencies;
	private readonly eventDisposers: Array<() => void> = [];
	private session: SessionRuntime | undefined;
	private poller: Timer | undefined;
	private pulseTimer: Timer | undefined;
	private requestRender: (() => void) | undefined;
	private nextGeneration = 0;
	private disposed = false;

	constructor(
		private readonly pi: ExtensionAPI,
		dependencies: Partial<FooterRuntimeDependencies> = {},
	) {
		this.dependencies = { ...defaultDependencies(), ...dependencies };
	}

	register(): void {
		this.eventDisposers.push(
			this.pi.events.on("subagent:async-started", (payload) =>
				this.onSubagentStarted(payload),
			),
			this.pi.events.on("subagent:async-complete", () => void this.refresh()),
			this.pi.events.on("background-jobs:changed", (payload) =>
				this.onBackgroundJobs(payload),
			),
		);
		this.pi.on("session_start", async (_event, ctx) => {
			this.start(ctx);
			await this.restore(ctx);
		});
		this.pi.on("session_shutdown", () => this.stop());
		this.pi.on("model_select", (event, ctx) => {
			if (!this.session || this.session.ctx !== ctx) return;
			this.session.modelId = event.model.id;
			this.repaint();
		});
		this.pi.on("thinking_level_select", (_event, ctx) => this.repaintFor(ctx));
		this.pi.on("turn_end", (_event, ctx) => this.updateMainTokens(ctx));
		this.pi.on("message_end", (_event, ctx) => this.updateMainTokens(ctx));
	}

	start(ctx: ExtensionContext): void {
		this.resetSession();
		const runtime: SessionRuntime = {
			generation: ++this.nextGeneration,
			ctx,
			modelId: ctx.model?.id,
			runs: new Map(),
			tokens: new Map(),
			mainTokens: sessionTokens(ctx),
			refreshing: false,
		};
		this.session = runtime;
		ctx.ui.setFooter((tui, theme, footerData) =>
			this.createFooter(
				runtime.generation,
				tui,
				theme as ThemeLike,
				footerData as FooterDataLike,
			),
		);
		this.repaint();
	}

	stop(): void {
		this.resetSession();
		for (const dispose of this.eventDisposers.splice(0)) dispose();
		this.disposed = true;
	}

	private resetSession(): void {
		++this.nextGeneration;
		this.stopTimers();
		this.requestRender = undefined;
		this.session = undefined;
	}

	private createFooter(
		generation: number,
		tui: TUI,
		theme: ThemeLike,
		footerData: FooterDataLike,
	): Component & { dispose(): void } {
		const callback = () => tui.requestRender();
		if (this.isCurrent(generation)) this.requestRender = callback;
		return {
			render: (width: number) => {
				const current = this.session;
				if (!current || current.generation !== generation) return [];
				const extraTokens = [...current.tokens.values()].reduce(
					(total, usage) => ({
						input: total.input + usage.input,
						output: total.output + usage.output,
						total: total.total + usage.total,
					}),
					zeroTokens(),
				);
				return renderFooter(
					{
						cwd: displayCwd(current.ctx.cwd),
						trusted: current.ctx.isProjectTrusted(),
						modelId: current.modelId ?? current.ctx.model?.id ?? "no-model",
						thinkingLevel: thinkingLevel(this.pi),
						inputTokens: current.mainTokens.input + extraTokens.input,
						outputTokens: current.mainTokens.output + extraTokens.output,
						contextUsage: current.ctx.getContextUsage(),
						subagents: current.subagents,
						backgroundJobs: current.backgroundJobs,
						statuses: footerData.getExtensionStatuses(),
						now: this.dependencies.now(),
					},
					theme,
					width,
				);
			},
			invalidate() {},
			dispose: () => {
				if (this.requestRender === callback) this.requestRender = undefined;
			},
		};
	}

	private onSubagentStarted(payload: unknown): void {
		const run = parseAsyncRunStart(payload);
		const current = this.session;
		if (!run || !isAbsolute(run.asyncDir) || !current || this.disposed) return;
		current.runs.set(run.id, run);
		this.updateTimers();
		void this.refresh();
	}

	private onBackgroundJobs(payload: unknown): void {
		const current = this.session;
		const backgroundJobs = parseBackgroundJobs(payload);
		if (!current || !backgroundJobs || this.disposed) return;
		current.backgroundJobs = backgroundJobs;
		this.updateTimers();
		this.repaint();
	}

	private async restore(ctx: ExtensionContext): Promise<void> {
		const current = this.session;
		if (!current || current.ctx !== ctx) return;
		const generation = current.generation;
		const sessionIds = new Set([
			ctx.sessionManager.getSessionFile(),
			ctx.sessionManager.getSessionId(),
		]);
		const directories = await this.dependencies.readRunDirectories();
		if (!this.isCurrent(generation)) return;
		for (const asyncDir of directories) {
			const raw = await this.dependencies.readStatus(asyncDir);
			if (!this.isCurrent(generation)) return;
			const status = parseAsyncRunStatus(raw);
			if (!status?.sessionId || !sessionIds.has(status.sessionId)) continue;
			const id = asyncDir.split(/[\\/]/).at(-1);
			if (!id) continue;
			// Finished runs still contribute to the session token total, but must
			// never be restored into the active run map.
			if (status.totalTokens) current.tokens.set(id, status.totalTokens);
			if (isFinishedState(status.state)) continue;
			current.runs.set(id, {
				id,
				asyncDir,
				agent: status.steps?.[0]?.agent,
				agents: status.steps?.flatMap((step) =>
					step.agent ? [step.agent] : [],
				),
			});
		}
		this.updateTimers();
		await this.refresh();
	}

	private async refresh(): Promise<void> {
		const current = this.session;
		if (!current || current.refreshing || this.disposed) return;
		current.refreshing = true;
		const generation = current.generation;
		try {
			const snapshots: Array<{
				start: AsyncRunStart;
				status?: AsyncRunStatus;
			}> = [];
			for (const [id, start] of current.runs) {
				const status = parseAsyncRunStatus(
					await this.dependencies.readStatus(start.asyncDir),
				);
				if (!this.isCurrent(generation)) return;
				if (status?.totalTokens) current.tokens.set(id, status.totalTokens);
				if (isFinishedState(status?.state)) {
					current.runs.delete(id);
					continue;
				}
				snapshots.push({ start, status });
			}
			if (!this.isCurrent(generation)) return;
			current.subagents = formatSubagentFooter(snapshots);
			this.updateTimers();
			this.repaint();
		} finally {
			if (this.isCurrent(generation)) current.refreshing = false;
		}
	}

	private updateMainTokens(ctx: ExtensionContext): void {
		if (!this.session || this.session.ctx !== ctx) return;
		this.session.mainTokens = sessionTokens(ctx);
		this.repaint();
	}

	private repaintFor(ctx: ExtensionContext): void {
		if (this.session?.ctx === ctx) this.repaint();
	}

	private repaint(): void {
		this.requestRender?.();
	}

	private updateTimers(): void {
		const current = this.session;
		const needsPolling = Boolean(current?.runs.size);
		if (needsPolling && !this.poller)
			this.poller = this.dependencies.setInterval(
				() => void this.refresh(),
				POLL_INTERVAL_MS,
			);
		if (!needsPolling && this.poller) {
			this.dependencies.clearInterval(this.poller);
			this.poller = undefined;
		}
		const needsPulse = Boolean(
			current?.subagents?.activeCount || current?.backgroundJobs?.runningCount,
		);
		if (needsPulse && !this.pulseTimer)
			this.pulseTimer = this.dependencies.setInterval(
				() => this.repaint(),
				PULSE_FRAME_MS,
			);
		if (!needsPulse && this.pulseTimer) {
			this.dependencies.clearInterval(this.pulseTimer);
			this.pulseTimer = undefined;
		}
	}

	private stopTimers(): void {
		if (this.poller) this.dependencies.clearInterval(this.poller);
		if (this.pulseTimer) this.dependencies.clearInterval(this.pulseTimer);
		this.poller = undefined;
		this.pulseTimer = undefined;
	}

	private isCurrent(generation: number): boolean {
		return !this.disposed && this.session?.generation === generation;
	}
}
