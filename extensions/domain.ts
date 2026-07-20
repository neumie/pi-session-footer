import { truncateToWidth } from "@earendil-works/pi-tui";

export interface AsyncRunStart {
	id: string;
	asyncDir: string;
	agent?: string;
	agents?: string[];
	goal?: string;
}

export interface AsyncStepStatus {
	agent?: string;
	status?: "queued" | "running" | "complete" | "failed" | "paused" | "stopped";
	model?: string;
	sessionFile?: string;
}

export interface AsyncRunStatus {
	sessionId?: string;
	sessionFiles?: string[];
	state?: "queued" | "running" | "complete" | "failed" | "paused" | "stopped";
	startedAt?: number;
	endedAt?: number;
	currentStep?: number;
	chainStepCount?: number;
	workflowGraph?: {
		currentNodeId?: string;
		nodes?: Array<{
			id?: string;
			phase?: string;
			children?: Array<{ id?: string; phase?: string }>;
		}>;
	};
	steps?: AsyncStepStatus[];
	totalTokens?: TokenUsage;
}

export interface TokenUsage {
	input: number;
	output: number;
	total: number;
}

export const ASYNC_TOKEN_ENTRY_TYPE = "pi-session-footer:async-tokens";
export const ASYNC_TOKEN_ENTRY_VERSION = 1;

export interface AsyncTokenSnapshot {
	version: typeof ASYNC_TOKEN_ENTRY_VERSION;
	id: string;
	totalTokens: TokenUsage;
	sessionId?: string;
	completedAt?: number;
	sessionFiles?: string[];
	coveredSessions?: string[];
}

export interface ActiveSubagent {
	agent: string;
	model?: string;
}

export interface SubagentAggregate {
	active: ActiveSubagent[];
	queued: number;
	tokens: number;
}

export interface SubagentFooterState {
	summary: string;
	workflow?: string;
	activeCount: number;
	queuedCount: number;
}

export interface BackgroundJobsFooterState {
	runningCount: number;
	primary?: { id: string; label?: string; command: string; startedAt?: number };
}

const CONTROL_OR_ANSI =
	/(?:\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B\[[0-?]*[ -/]*[@-~]|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F])/g;
const STATES = new Set([
	"queued",
	"running",
	"complete",
	"failed",
	"paused",
	"stopped",
]);

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function string(value: unknown, maxWidth = 160): string | undefined {
	if (typeof value !== "string") return undefined;
	const clean = value.replace(CONTROL_OR_ANSI, "").replace(/\s+/g, " ").trim();
	return clean ? truncateToWidth(clean, maxWidth, "…") : undefined;
}

function pathString(value: unknown, maxLength = 4096): string | undefined {
	if (typeof value !== "string") return undefined;
	const clean = value.replace(CONTROL_OR_ANSI, "").trim();
	return clean ? clean.slice(0, maxLength) : undefined;
}

function uniquePaths(values: unknown[], maxItems = 256): string[] | undefined {
	const paths = new Set<string>();
	for (const value of values) {
		const path = pathString(value);
		if (path) paths.add(path);
		if (paths.size >= maxItems) break;
	}
	return paths.size > 0 ? [...paths] : undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: undefined;
}

function state(value: unknown): AsyncRunStatus["state"] | undefined {
	return typeof value === "string" && STATES.has(value)
		? (value as AsyncRunStatus["state"])
		: undefined;
}

export function parseTokenUsage(value: unknown): TokenUsage | undefined {
	const raw = object(value);
	if (!raw) return undefined;
	const input = count(raw.input) ?? 0;
	const output = count(raw.output) ?? 0;
	const total = count(raw.total) ?? input + output;
	return { input, output, total };
}

export function parseAsyncTokenSnapshot(
	value: unknown,
): AsyncTokenSnapshot | undefined {
	const raw = object(value);
	if (!raw || raw.version !== ASYNC_TOKEN_ENTRY_VERSION) return undefined;
	const id = string(raw.id ?? raw.runId, 120);
	const totalTokens = parseTokenUsage(raw.totalTokens);
	if (!id || !totalTokens) return undefined;
	const coveredSessions = Array.isArray(raw.coveredSessions)
		? raw.coveredSessions
				.slice(0, 256)
				.map((entry) => pathString(entry, 1024))
				.filter((entry): entry is string => Boolean(entry))
		: undefined;
	return {
		version: ASYNC_TOKEN_ENTRY_VERSION,
		id,
		totalTokens,
		sessionId: pathString(raw.sessionId),
		completedAt: count(raw.completedAt ?? raw.endedAt ?? raw.timestamp),
		sessionFiles: uniquePaths([
			...(Array.isArray(raw.sessionFiles) ? raw.sessionFiles : []),
			raw.sessionFile,
		]),
		coveredSessions,
	};
}

export function parseAsyncRunCompletion(
	value: unknown,
): AsyncTokenSnapshot | undefined {
	const raw = object(value);
	if (!raw) return undefined;
	const runId = string(raw.runId ?? raw.id, 100);
	const totalTokens = parseTokenUsage(raw.totalTokens);
	if (!runId || !totalTokens) return undefined;
	const resultSessionFiles = Array.isArray(raw.results)
		? raw.results.flatMap((value) => {
				const result = object(value);
				return result ? [result.sessionFile, result.sessionPath] : [];
			})
		: [];
	return {
		version: ASYNC_TOKEN_ENTRY_VERSION,
		id: `run:${runId}`,
		totalTokens,
		sessionId: pathString(raw.sessionId),
		completedAt: count(raw.endedAt ?? raw.timestamp),
		sessionFiles: uniquePaths([raw.sessionFile, ...resultSessionFiles]),
	};
}

/** Runtime boundary for pi-subagents event payloads. */
export function parseAsyncRunStart(value: unknown): AsyncRunStart | undefined {
	const raw = object(value);
	if (!raw) return undefined;
	const id = string(raw.id ?? raw.runId, 100);
	const asyncDir =
		typeof raw.asyncDir === "string" && raw.asyncDir.length > 0
			? raw.asyncDir
			: undefined;
	if (!id || !asyncDir) return undefined;
	const agents = Array.isArray(raw.agents)
		? raw.agents
				.map((agent) => string(agent, 80))
				.filter((agent): agent is string => Boolean(agent))
		: undefined;
	return {
		id,
		asyncDir,
		agent: string(raw.agent, 80),
		agents,
		goal: string(raw.goal ?? raw.task, 160),
	};
}

/** Runtime boundary for optional status.json data. Invalid fields become absent. */
export function parseAsyncRunStatus(
	value: unknown,
): AsyncRunStatus | undefined {
	const raw = object(value);
	if (!raw) return undefined;
	const steps = Array.isArray(raw.steps)
		? raw.steps.flatMap((entry) => {
				const step = object(entry);
				if (!step) return [];
				return [
					{
						agent: string(step.agent, 80),
						model: string(step.model, 120),
						status: state(step.status),
						sessionFile: pathString(step.sessionFile),
					},
				];
			})
		: undefined;
	const graph = object(raw.workflowGraph);
	const nodes = Array.isArray(graph?.nodes)
		? graph.nodes.flatMap((entry) => {
				const node = object(entry);
				if (!node) return [];
				const children = Array.isArray(node.children)
					? node.children.flatMap((child) => {
							const childObject = object(child);
							return childObject
								? [
										{
											id: string(childObject.id, 100),
											phase: string(childObject.phase, 80),
										},
									]
								: [];
						})
					: undefined;
				return [
					{ id: string(node.id, 100), phase: string(node.phase, 80), children },
				];
			})
		: undefined;
	return {
		sessionId: pathString(raw.sessionId, 4096),
		sessionFiles: uniquePaths([
			raw.sessionFile,
			...(steps?.map((step) => step.sessionFile) ?? []),
		]),
		state: state(raw.state),
		startedAt: count(raw.startedAt),
		endedAt: count(raw.endedAt),
		currentStep: count(raw.currentStep),
		chainStepCount: count(raw.chainStepCount),
		workflowGraph: graph
			? { currentNodeId: string(graph.currentNodeId, 100), nodes }
			: undefined,
		steps,
		totalTokens: parseTokenUsage(raw.totalTokens),
	};
}

/** Runtime boundary for optional pi-background-jobs events. */
export function parseBackgroundJobs(
	value: unknown,
): BackgroundJobsFooterState | undefined {
	const raw = object(value);
	if (!raw) return undefined;
	const primary = object(raw.primary);
	const command = primary ? string(primary.command, 160) : undefined;
	return {
		runningCount: count(raw.runningCount) ?? 0,
		primary:
			primary && command
				? {
						id: string(primary.id, 100) ?? "",
						label: string(primary.label, 120),
						command,
						startedAt: count(primary.startedAt),
					}
				: undefined,
	};
}

export function isFinishedState(value: AsyncRunStatus["state"]): boolean {
	return (
		value === "complete" ||
		value === "failed" ||
		value === "paused" ||
		value === "stopped"
	);
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Shared parent/subagent model formatter. */
export function formatModel(id: string): string {
	const model =
		id
			.split("/")
			.at(-1)
			?.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, "") ?? id;
	const tier = model.match(/^gpt-5\.6-(sol|terra|luna)$/i)?.[1];
	if (tier)
		return `GPT-5.6 ${tier.charAt(0).toUpperCase()}${tier.slice(1).toLowerCase()}`;
	return model.replace(/^claude-/, "");
}

function activeForRun(
	start: AsyncRunStart,
	status?: AsyncRunStatus,
): ActiveSubagent[] {
	const running =
		status?.steps?.filter((step) => step.status === "running") ?? [];
	if (running.length > 0) {
		return running.map((step) => ({
			agent: step.agent ?? start.agent ?? "subagent",
			model: step.model,
		}));
	}
	// A missing status is the brief event-to-artifact interval. A queued run is
	// deliberately not synthesized as active.
	if (!status || status.state === "running")
		return [{ agent: start.agent ?? start.agents?.[0] ?? "subagent" }];
	return [];
}

export function aggregateSubagents(
	snapshots: Array<{ start: AsyncRunStart; status?: AsyncRunStatus }>,
): SubagentAggregate {
	const aggregate: SubagentAggregate = { active: [], queued: 0, tokens: 0 };
	for (const { start, status } of snapshots) {
		aggregate.active.push(...activeForRun(start, status));
		const queuedSteps =
			status?.steps?.filter((step) => step.status === "queued").length ?? 0;
		aggregate.queued += queuedSteps || (status?.state === "queued" ? 1 : 0);
		aggregate.tokens += status?.totalTokens?.total ?? 0;
	}
	return aggregate;
}

export function formatSubagentModels(
	active: ActiveSubagent[],
): string | undefined {
	const counts = new Map<string, number>();
	for (const item of active) {
		if (!item.model) continue;
		const model = formatModel(item.model);
		counts.set(model, (counts.get(model) ?? 0) + 1);
	}
	const models = [...counts].map(([model, amount]) =>
		amount > 1 ? `${model} ×${amount}` : model,
	);
	return models.length > 0 ? models.join(", ") : undefined;
}

function workflowGoal(
	snapshots: Array<{ start: AsyncRunStart; status?: AsyncRunStatus }>,
): string | undefined {
	const active = snapshots.filter(
		({ status }) => !isFinishedState(status?.state),
	);
	const first = active.find(({ start }) => Boolean(start.goal));
	if (!first?.start.goal) return undefined;
	const parts = [first.start.goal];
	const graph = first.status?.workflowGraph;
	const nodeIndex =
		graph?.nodes?.findIndex(
			(node) =>
				node.id === graph.currentNodeId ||
				node.children?.some((child) => child.id === graph.currentNodeId),
		) ?? -1;
	if (nodeIndex >= 0 && graph?.nodes) {
		const node = graph.nodes[nodeIndex];
		parts.push(`${nodeIndex + 1}/${graph.nodes.length}`);
		if (node.phase) parts.push(node.phase);
	} else if (
		(first.status?.chainStepCount ?? 0) > 1 &&
		first.status?.currentStep !== undefined
	) {
		parts.push(
			`${Math.min(first.status.currentStep + 1, first.status.chainStepCount!)}/${first.status.chainStepCount}`,
		);
	}
	if (active.length > 1) parts.push(`+${active.length - 1} workflows`);
	return parts.join(" · ");
}

export function formatSubagentFooter(
	snapshots: Array<{ start: AsyncRunStart; status?: AsyncRunStatus }>,
): SubagentFooterState | undefined {
	const { active, queued, tokens } = aggregateSubagents(snapshots);
	if (active.length === 0 && queued === 0) return undefined;
	const summary = [
		`agents ${active.length}${queued ? ` (+${queued} queued)` : ""}`,
	];
	const models = formatSubagentModels(active);
	if (models) summary.push(models);
	summary.push(`${formatTokens(tokens)} tok`);
	return {
		summary: summary.join(" · "),
		workflow: workflowGoal(snapshots),
		activeCount: active.length,
		queuedCount: queued,
	};
}

export function sanitizeDisplayText(value: string, maxWidth: number): string {
	return string(value, maxWidth) ?? "";
}

/**
 * Extension statuses are terminal-rendered values. Preserve safe SGR styling
 * from cooperative extensions, while removing OSC, cursor/control escapes,
 * line breaks, and other control characters before layout.
 */
export function sanitizeStatusText(value: string, maxWidth: number): string {
	const sgr: string[] = [];
	const protectedSgr = value.replace(/\x1b\[[0-9;]*m/g, (code) => {
		const index = sgr.push(code) - 1;
		return `\uE000${index}\uE001`;
	});
	const clean = protectedSgr
		.replace(CONTROL_OR_ANSI, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(
			/\uE000(\d+)\uE001/g,
			(_placeholder, index: string) => sgr[Number(index)] ?? "",
		);
	return clean ? truncateToWidth(clean, maxWidth, "…") : "";
}
