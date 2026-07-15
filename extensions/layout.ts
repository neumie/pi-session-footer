import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	formatModel,
	formatTokens,
	sanitizeDisplayText,
	sanitizeStatusText,
	type BackgroundJobsFooterState,
	type SubagentFooterState,
} from "./domain.ts";

const OMITTED_EXTENSION_STATUS_KEYS = new Set([
	"mcp",
	"mcp-auth",
	"pi-lens-lsp",
]);

export interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
	getFgAnsi?(color: string): string;
}

export interface FooterViewModel {
	cwd: string;
	trusted: boolean;
	modelId: string;
	thinkingLevel: string;
	inputTokens: number;
	outputTokens: number;
	contextUsage?: { contextWindow: number; percent: number | null };
	subagents?: SubagentFooterState;
	backgroundJobs?: BackgroundJobsFooterState;
	statuses: ReadonlyMap<string, string>;
	now: number;
}

const PULSE_CYCLE_MS = 2800;
const PULSE_MIN_BRIGHTNESS = 0.7;

function effortColor(level: string): string {
	if (level === "off") return "dim";
	if (level === "minimal" || level === "low") return "muted";
	if (level === "medium") return "accent";
	if (level === "high" || level === "xhigh") return "warning";
	if (level === "max") return "error";
	return "text";
}

function alignSides(
	left: string,
	right: string,
	width: number,
	ellipsis: string,
): string {
	const leftFitted = truncateToWidth(left, width, ellipsis);
	if (!right) return leftFitted;
	const rightBudget = width - visibleWidth(leftFitted) - 2;
	if (rightBudget <= 0) return leftFitted;
	const rightFitted = truncateToWidth(right, rightBudget, ellipsis);
	const padding = " ".repeat(
		Math.max(2, width - visibleWidth(leftFitted) - visibleWidth(rightFitted)),
	);
	return truncateToWidth(
		`${leftFitted}${padding}${rightFitted}`,
		width,
		ellipsis,
	);
}

function pulse(theme: ThemeLike, text: string, now: number): string {
	const accentAnsi = theme.getFgAnsi?.("accent");
	const rgb = accentAnsi?.match(/38;2;(\d+);(\d+);(\d+)/);
	if (!rgb) return theme.fg("accent", text);
	const wave = (Math.sin((now / PULSE_CYCLE_MS) * Math.PI * 2) + 1) / 2;
	const brightness = PULSE_MIN_BRIGHTNESS + wave * (1 - PULSE_MIN_BRIGHTNESS);
	const shade = rgb
		.slice(1)
		.map((channel) => Math.min(255, Math.round(Number(channel) * brightness)));
	return `\x1b[38;2;${shade.join(";")}m${text}\x1b[39m`;
}

function elapsed(startedAt: number | undefined, now: number): string {
	if (!startedAt) return "";
	const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
	return seconds < 60
		? `${seconds}s`
		: `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function truncateLeft(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;
	const graphemes = [...text];
	while (graphemes.length && visibleWidth(`…${graphemes.join("")}`) > maxWidth)
		graphemes.shift();
	return `…${graphemes.join("")}`;
}

/** Unicode-safe path fitting which retains the leaf where possible. */
export function truncatePath(path: string, maxWidth: number): string {
	if (maxWidth <= 0 || !path) return "";
	if (visibleWidth(path) <= maxWidth) return path;
	const parts = path.split(/[/\\]/);
	if (parts.length <= 2) return truncateLeft(path, maxWidth);
	const separator = path.includes("\\") ? "\\" : "/";
	const head = parts[0];
	const base = `${head}${separator}…${separator}${parts.at(-1)}`;
	if (visibleWidth(base) > maxWidth) return truncateLeft(path, maxWidth);
	let best = base;
	for (let index = parts.length - 2; index >= 1; index--) {
		const candidate = `${head}${separator}…${separator}${parts.slice(index).join(separator)}`;
		if (visibleWidth(candidate) <= maxWidth) best = candidate;
		else break;
	}
	return best;
}

function context(
	theme: ThemeLike,
	usage: FooterViewModel["contextUsage"],
): string {
	if (!usage) return theme.fg("muted", "—");
	const window = formatTokens(usage.contextWindow);
	if (usage.percent === null) return theme.fg("muted", `?/${window}`);
	const color =
		usage.percent > 90 ? "error" : usage.percent > 70 ? "warning" : "text";
	return (
		theme.fg(color, `${usage.percent.toFixed(0)}%`) +
		theme.fg("dim", `/${window}`)
	);
}

/** Pure two-row footer renderer. */
export function renderFooter(
	view: FooterViewModel,
	theme: ThemeLike,
	width: number,
): string[] {
	const divider = theme.fg("dim", " · ");
	const ellipsis = theme.fg("dim", "…");
	const trust = `${divider}${theme.fg("dim", "project ")}${theme.fg(view.trusted ? "success" : "warning", view.trusted ? "trusted" : "untrusted")}`;
	const cwd = theme.fg(
		"muted",
		truncatePath(view.cwd, width - visibleWidth(trust)),
	);
	const subagent = view.subagents?.activeCount
		? pulse(theme, view.subagents.summary, view.now)
		: (view.subagents?.summary ?? "");
	const shell = view.backgroundJobs?.runningCount
		? pulse(
				theme,
				`${view.backgroundJobs.runningCount} shell${view.backgroundJobs.runningCount === 1 ? "" : "s"}`,
				view.now,
			)
		: "";
	const row1 = alignSides(
		`${cwd}${trust}`,
		[subagent, shell].filter(Boolean).join(divider),
		width,
		ellipsis,
	);

	const model = theme.fg("accent", theme.bold(formatModel(view.modelId)));
	const effort =
		theme.fg("dim", "effort ") +
		theme.fg(effortColor(view.thinkingLevel), view.thinkingLevel);
	const tokenText =
		theme.fg("dim", "tok ") +
		theme.fg(
			"text",
			`↑${formatTokens(view.inputTokens)} ↓${formatTokens(view.outputTokens)}`,
		);
	const ctx = theme.fg("dim", "ctx ") + context(theme, view.contextUsage);
	const background = view.backgroundJobs?.runningCount
		? [
				"Running",
				sanitizeDisplayText(
					view.backgroundJobs.primary?.label ??
						view.backgroundJobs.primary?.command ??
						"background job",
					40,
				),
				elapsed(view.backgroundJobs.primary?.startedAt, view.now),
			]
				.filter(Boolean)
				.join(" ")
		: "";
	// Product decision: omit only the explicitly selected extension statuses.
	const statuses = [...view.statuses.entries()]
		.filter(([key]) => !OMITTED_EXTENSION_STATUS_KEYS.has(key))
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([, value]) => sanitizeStatusText(value, 120))
		.filter(Boolean);
	const right = [view.subagents?.workflow, background, ...statuses]
		.filter(Boolean)
		.join(" · ");
	const row2 = alignSides(
		[model, effort, tokenText, ctx].join(divider),
		theme.fg("dim", right),
		width,
		ellipsis,
	);
	return [row1, row2];
}
