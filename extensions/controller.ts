import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { readFile, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	ASYNC_TOKEN_ENTRY_TYPE,
	ASYNC_TOKEN_ENTRY_VERSION,
	formatSubagentFooter,
	isFinishedState,
	parseAsyncRunCompletion,
	parseAsyncRunStart,
	parseAsyncRunStatus,
	type AsyncRunStart,
	type AsyncRunStatus,
	type AsyncTokenSnapshot,
	type SubagentFooterState,
	type TokenUsage,
} from "./domain.ts";
import { renderFooter, type ThemeLike } from "./layout.ts";
import {
	addTokens,
	containedRelativePath,
	discoverRelatedSessionFiles,
	discoverRunDirectories,
	legacyAsyncSessionCandidates,
	LEGACY_ASYNC_SNAPSHOT_ID,
	type LegacyTokenCoverage,
	MAX_LEGACY_ASYNC_SESSIONS,
	sessionTokens,
	sessionTokensFromFile,
	sessionTreeRoot,
	snapshotCoveredByLegacy,
	statusCoveredByLegacy,
	tokenSnapshots,
} from "./tokens.ts";

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
	canonicalPath(path: string): Promise<string | undefined>;
	readRelatedSessionFiles(sessionFile: string): Promise<string[] | undefined>;
	readSessionTokens(sessionFile: string): Promise<TokenUsage | undefined>;
}

export const SESSION_FOOTER_MOUNTED_EVENT = "pi-session-footer:mounted";
export const SESSION_FOOTER_ROWS = 2;

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
			const root = join(
				tmpdir(),
				`pi-subagents-uid-${uid}`,
				"async-subagent-runs",
			);
			return (await discoverRunDirectories(root)) ?? [];
		},
		async canonicalPath(path) {
			try {
				return await realpath(path);
			} catch {
				return undefined;
			}
		},
		async readRelatedSessionFiles(sessionFile) {
			return discoverRelatedSessionFiles(sessionFile);
		},
		async readSessionTokens(sessionFile) {
			return sessionTokensFromFile(sessionFile);
		},
	};
}

interface SessionRuntime {
	generation: number;
	ctx: ExtensionContext;
	sessionManager: ExtensionContext["sessionManager"];
	modelId?: string;
	runs: Map<string, AsyncRunStart>;
	tokens: Map<string, TokenUsage>;
	snapshots: Map<string, AsyncTokenSnapshot>;
	completedRuns: Set<string>;
	mainTokens: TokenUsage;
	legacyCoverage?: LegacyTokenCoverage;
	subagents?: SubagentFooterState;
	refreshing: boolean;
}

function zeroTokens(): TokenUsage {
	return { input: 0, output: 0, total: 0 };
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
			this.pi.events.on("subagent:async-complete", (payload) =>
				this.onSubagentCompleted(payload),
			),
		);
		this.pi.on("session_start", async (_event, ctx) => {
			this.start(ctx);
			await this.restore(ctx);
		});
		this.pi.on("session_shutdown", () => this.stop());
		this.pi.on("model_select", (event, ctx) => {
			const current = this.currentSessionFor(ctx);
			if (!current) return;
			current.modelId = event.model.id;
			this.repaint();
		});
		this.pi.on("thinking_level_select", (_event, ctx) => this.repaintFor(ctx));
		this.pi.on("turn_end", (_event, ctx) => this.updateMainTokens(ctx));
		this.pi.on("message_end", (_event, ctx) => this.updateMainTokens(ctx));
	}

	start(ctx: ExtensionContext): void {
		this.resetSession();
		const restored = tokenSnapshots(ctx);
		const runtime: SessionRuntime = {
			generation: ++this.nextGeneration,
			ctx,
			sessionManager: ctx.sessionManager,
			modelId: ctx.model?.id,
			runs: new Map(),
			tokens: restored.tokens,
			snapshots: restored.snapshots,
			completedRuns: new Set(
				[...restored.snapshots.keys()]
					.filter((id) => id.startsWith("run:"))
					.map((id) => id.slice("run:".length)),
			),
			mainTokens: sessionTokens(ctx),
			legacyCoverage: restored.legacyCoverage,
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
		this.pi.events.emit(SESSION_FOOTER_MOUNTED_EVENT, {
			rows: SESSION_FOOTER_ROWS,
		});
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

	private onSubagentCompleted(payload: unknown): void {
		const current = this.session;
		const parsed = parseAsyncRunCompletion(payload);
		if (!current || !parsed || this.disposed) return;
		const runId = parsed.id.slice("run:".length);
		const currentSessionIds = new Set([
			current.ctx.sessionManager.getSessionFile(),
			current.ctx.sessionManager.getSessionId(),
		]);
		const belongsToCurrentSession = parsed.sessionId
			? currentSessionIds.has(parsed.sessionId)
			: current.runs.has(runId);
		if (!belongsToCurrentSession) return;
		const snapshot: AsyncTokenSnapshot = {
			...parsed,
			completedAt: parsed.completedAt ?? this.dependencies.now(),
		};
		current.tokens.set(snapshot.id, snapshot.totalTokens);
		current.snapshots.set(snapshot.id, snapshot);
		current.completedRuns.add(runId);
		current.runs.delete(runId);
		try {
			this.pi.appendEntry(ASYNC_TOKEN_ENTRY_TYPE, snapshot);
		} catch (error) {
			console.error("Failed to persist async token snapshot:", error);
		}
		this.updateTimers();
		this.repaint();
		void this.refresh();
	}

	private async migrateLegacyAsyncTokens(
		current: SessionRuntime,
		generation: number,
	): Promise<void> {
		if (current.legacyCoverage) return;
		const durableRunSnapshots = [...current.snapshots.values()].filter((entry) =>
			entry.id.startsWith("run:"),
		);
		// A snapshot without child-session identity cannot be safely reconciled
		// with transcript totals, so prefer a low count over double-counting.
		if (durableRunSnapshots.some((entry) => !entry.sessionFiles?.length)) return;
		const root = sessionTreeRoot(current.ctx);
		const candidates = legacyAsyncSessionCandidates(current.ctx);
		if (!root || !candidates?.length) return;
		const canonicalRoot = await this.dependencies.canonicalPath(root);
		if (!this.isCurrent(generation) || !canonicalRoot) return;

		const relatedSessions = new Map<
			string,
			{ absolute: string; relative: string }
		>();
		for (const candidate of candidates) {
			const files =
				await this.dependencies.readRelatedSessionFiles(candidate);
			if (!this.isCurrent(generation) || !files) return;
			for (const file of files) {
				const absolute = resolve(file);
				const lexicalRelative = containedRelativePath(root, absolute);
				if (!lexicalRelative) return;
				const canonical = await this.dependencies.canonicalPath(absolute);
				if (!this.isCurrent(generation)) return;
				if (!canonical) return;
				if (!containedRelativePath(canonicalRoot, canonical)) return;
				if (
					!relatedSessions.has(canonical) &&
					relatedSessions.size >= MAX_LEGACY_ASYNC_SESSIONS
				)
					return;
				relatedSessions.set(canonical, {
					absolute: canonical,
					relative: lexicalRelative,
				});
			}
		}
		if (relatedSessions.size === 0) return;

		const totalTokens = zeroTokens();
		for (const session of relatedSessions.values()) {
			const usage = await this.dependencies.readSessionTokens(session.absolute);
			if (!this.isCurrent(generation)) return;
			// Migration is all-or-retry: never persist a permanently partial total.
			if (!usage) return;
			addTokens(totalTokens, usage);
		}
		const coveredSessions = [...relatedSessions.values()].map(
			(session) => session.relative,
		);
		const recordedAt = this.dependencies.now();
		const snapshot: AsyncTokenSnapshot = {
			version: ASYNC_TOKEN_ENTRY_VERSION,
			id: LEGACY_ASYNC_SNAPSHOT_ID,
			totalTokens,
			completedAt: recordedAt,
			coveredSessions,
		};
		const coverage: LegacyTokenCoverage = {
			root,
			recordedAt,
			sessions: new Set(coveredSessions),
		};
		for (const durable of durableRunSnapshots) {
			if (snapshotCoveredByLegacy(durable, coverage))
				current.tokens.delete(durable.id);
		}
		current.tokens.set(snapshot.id, snapshot.totalTokens);
		current.snapshots.set(snapshot.id, snapshot);
		current.legacyCoverage = coverage;
		try {
			this.pi.appendEntry(ASYNC_TOKEN_ENTRY_TYPE, snapshot);
		} catch (error) {
			console.error("Failed to persist legacy async token snapshot:", error);
		}
	}

	private async restore(ctx: ExtensionContext): Promise<void> {
		const current = this.currentSessionFor(ctx);
		if (!current) return;
		const generation = current.generation;
		const sessionIds = new Set([
			ctx.sessionManager.getSessionFile(),
			ctx.sessionManager.getSessionId(),
		]);
		await this.migrateLegacyAsyncTokens(current, generation);
		if (!this.isCurrent(generation)) return;
		const directories = await this.dependencies.readRunDirectories();
		if (!this.isCurrent(generation)) return;
		for (const asyncDir of directories) {
			const raw = await this.dependencies.readStatus(asyncDir);
			if (!this.isCurrent(generation)) return;
			const status = parseAsyncRunStatus(raw);
			if (!status?.sessionId || !sessionIds.has(status.sessionId)) continue;
			const id = asyncDir.split(/[\\/]/).at(-1);
			if (!id || current.completedRuns.has(id)) continue;
			// Finished runs still contribute to the session token total, but must
			// never be restored into the active run map. Legacy migration already
			// includes records completed before its durable snapshot.
			if (
				status.totalTokens &&
				!statusCoveredByLegacy(status, current.legacyCoverage)
			)
				current.tokens.set(`run:${id}`, status.totalTokens);
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
				if (current.completedRuns.has(id)) continue;
				if (
					status?.totalTokens &&
					!statusCoveredByLegacy(status, current.legacyCoverage)
				)
					current.tokens.set(`run:${id}`, status.totalTokens);
				if (isFinishedState(status?.state)) {
					current.runs.delete(id);
					continue;
				}
				snapshots.push({ start, status });
			}
			if (!this.isCurrent(generation)) return;
			const activeSnapshots = snapshots.filter(
				({ start }) =>
					current.runs.has(start.id) &&
					!current.completedRuns.has(start.id),
			);
			current.subagents = formatSubagentFooter(activeSnapshots);
			this.updateTimers();
			this.repaint();
		} finally {
			if (this.isCurrent(generation)) current.refreshing = false;
		}
	}

	private updateMainTokens(ctx: ExtensionContext): void {
		const current = this.currentSessionFor(ctx);
		if (!current) return;
		current.mainTokens = sessionTokens(ctx);
		this.repaint();
	}

	private repaintFor(ctx: ExtensionContext): void {
		if (this.currentSessionFor(ctx)) this.repaint();
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
		const needsPulse = Boolean(current?.subagents?.activeCount);
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

	private currentSessionFor(ctx: ExtensionContext): SessionRuntime | undefined {
		const current = this.session;
		return current?.sessionManager === ctx.sessionManager ? current : undefined;
	}

	private isCurrent(generation: number): boolean {
		return !this.disposed && this.session?.generation === generation;
	}
}
