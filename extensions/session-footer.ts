// Replace the footer with a compact, multi-row status bar.
//
//   Row 1:  <cwd>  project <trusted|untrusted>    agents · models · tokens
//   Row 2:  model  ·  effort <level>  ·  tok ↑input ↓output  ·  ctx <pct>/<window>    agent tasks
//           Token totals include the parent session and every async subagent run it invoked.
//
// The spawn directory matters: project trust is keyed by absolute path in
// trust.json, so the same trusted/untrusted state only means something next to
// the path it applies to. cwd also drives context-file discovery and git.
//
// The built-in footer crams pwd, tokens, cost, model, effort, and context onto
// two dense lines. Here we drop the token/cost noise and put what matters on
// its own readable, color-coded row via setFooter(). The factory hands us the
// live `theme`, so we color with theme.fg() (respecting the active theme)
// instead of hardcoded ANSI.
//
// pi has no per-tool allow/deny system; its real gate is project trust
// (trust.json + the defaultProjectTrust policy), read via ctx.isProjectTrusted().
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// Minimal structural view of the Theme handed to the footer factory. Keeps us
// off the package's internal theme import path.
interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
  getFgAnsi?(color: string): string;
}

interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

interface FooterDataLike {
  getExtensionStatuses(): ReadonlyMap<string, string>;
}

interface AsyncRunStart {
  id: string;
  asyncDir: string;
  agent?: string;
  agents?: string[];
  goal?: string;
}

interface AsyncStepStatus {
  agent?: string;
  status?: string;
  model?: string;
}

interface WorkflowNode {
  id?: string;
  phase?: string;
  label?: string;
  children?: WorkflowNode[];
}

interface AsyncRunStatus {
  sessionId?: string;
  mode?: string;
  state?: string;
  currentStep?: number;
  chainStepCount?: number;
  workflowGraph?: {
    currentNodeId?: string;
    nodes?: WorkflowNode[];
  };
  steps?: AsyncStepStatus[];
  totalTokens?: {
    input?: number;
    output?: number;
    total?: number;
  };
}

interface TokenUsage {
  input: number;
  output: number;
}

interface SubagentFooterState {
  summary: string;
  workflow?: string;
}

// Live state read at render time. Updated by events; the component pulls from
// it whenever the TUI repaints.
const state: {
  ctx?: ExtensionContext;
  modelId?: string;
  subagents?: SubagentFooterState;
} = {};
const asyncRuns = new Map<string, AsyncRunStart>();
const subagentTokensByRun = new Map<string, TokenUsage>();
let subagentPoller: ReturnType<typeof setInterval> | undefined;
let subagentPulseTimer: ReturnType<typeof setInterval> | undefined;
let subagentRefreshInFlight = false;
let lastSubagentRenderKey: string | undefined;

const SUBAGENT_PULSE_FRAME_MS = 60;
const SUBAGENT_PULSE_CYCLE_MS = 2800;

/** Compact token formatting, matching the built-in footer's style. */
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/** Trim the noisy provider prefix so "claude-opus-4-8" reads as "opus-4-8". */
function prettyModel(id: string): string {
  return id.replace(/^claude-/, "");
}

function prettySubagentModel(id: string): string {
  const model = id.split("/").at(-1)?.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, "") ?? id;
  const tier = model.match(/^gpt-5\.6-(sol|terra|luna)$/i)?.[1];
  if (!tier) return prettyModel(model);
  return `${tier.charAt(0).toUpperCase()}${tier.slice(1).toLowerCase()}`;
}

function compactText(text: string, maxLength: number): string {
  const clean = text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

interface ActiveSubagent {
  agent: string;
  model?: string;
}

interface SubagentAggregate {
  active: ActiveSubagent[];
  queued: number;
  tokens: number;
}

function activeSubagentsForRun(start: AsyncRunStart, status?: AsyncRunStatus): ActiveSubagent[] {
  const running = status?.steps?.filter((step) => step.status === "running") ?? [];
  if (running.length > 0) {
    return running.map((step) => ({
      agent: step.agent ?? start.agent ?? "subagent",
      model: step.model,
    }));
  }
  if (status && status.state !== "running" && status.state !== "queued") return [];
  return [{ agent: start.agent ?? start.agents?.[0] ?? "subagent" }];
}

function aggregateSubagents(
  snapshots: Array<{ start: AsyncRunStart; status?: AsyncRunStatus }>,
): SubagentAggregate {
  const aggregate: SubagentAggregate = { active: [], queued: 0, tokens: 0 };
  for (const { start, status } of snapshots) {
    aggregate.active.push(...activeSubagentsForRun(start, status));
    aggregate.queued += status?.steps?.filter((step) => step.status === "queued").length ?? 0;
    aggregate.tokens += status?.totalTokens?.total ?? 0;
  }
  return aggregate;
}

function formatSubagentModels(active: ActiveSubagent[]): string | undefined {
  const counts = new Map<string, number>();
  for (const item of active) {
    if (!item.model) continue;
    const model = prettySubagentModel(item.model);
    counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  const models = [...counts].map(([model, count]) => {
    if (count > 1) return `${model}×${count}`;
    return model;
  });
  return models.length > 0 ? models.join(" ") : undefined;
}

function currentWorkflowPosition(status: AsyncRunStatus | undefined): { step: number; total: number; phase?: string } | undefined {
  const nodes = status?.workflowGraph?.nodes ?? [];
  const currentNodeId = status?.workflowGraph?.currentNodeId;
  if (nodes.length > 0 && currentNodeId) {
    for (const [index, node] of nodes.entries()) {
      const current = node.id === currentNodeId
        ? node
        : node.children?.find((child) => child.id === currentNodeId);
      if (current) {
        return {
          step: index + 1,
          total: nodes.length,
          phase: current.phase ?? node.phase,
        };
      }
    }
  }

  const total = status?.chainStepCount ?? 0;
  if (total <= 1 || status?.currentStep === undefined) return undefined;
  return {
    step: Math.min(status.currentStep + 1, total),
    total,
  };
}

function formatWorkflowGoal(
  snapshots: Array<{ start: AsyncRunStart; status?: AsyncRunStatus }>,
): string | undefined {
  const activeWorkflows = snapshots.filter(({ status }) => !isFinishedState(status?.state));
  const first = activeWorkflows.find(({ start }) => Boolean(start.goal));
  if (!first?.start.goal) return undefined;

  const parts = [compactText(first.start.goal, 56)];
  const position = currentWorkflowPosition(first.status);
  if (position) {
    parts.push(`${position.step}/${position.total}`);
    if (position.phase) parts.push(position.phase);
  }
  if (activeWorkflows.length > 1) parts.push(`+${activeWorkflows.length - 1} workflows`);
  return parts.join(" · ");
}

function formatSubagentFooter(
  snapshots: Array<{ start: AsyncRunStart; status?: AsyncRunStatus }>,
): SubagentFooterState | undefined {
  const { active, queued, tokens } = aggregateSubagents(snapshots);
  if (active.length === 0) return undefined;

  const summary = [`agents ${active.length}${queued > 0 ? ` (+${queued} queued)` : ""}`];
  const models = formatSubagentModels(active);
  if (models) summary.push(models);
  summary.push(`${formatTokens(tokens)} tok`);

  return {
    summary: summary.join(" · "),
    workflow: formatWorkflowGoal(snapshots),
  };
}

/** Home-collapsed cwd ("~/vault"), matching the built-in footer's style. */
function formatCwd(cwd: string): string {
  const home = homedir();
  if (!home) return cwd;
  const rel = relative(resolve(home), resolve(cwd));
  const insideHome = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (!insideHome) return cwd;
  return rel === "" ? "~" : `~${sep}${rel}`;
}

/**
 * Truncate a plain string to maxWidth by dropping characters from the LEFT,
 * prepending an ellipsis. Keeps the tail (the current folder's leaf) visible,
 * unlike truncateToWidth which clips the right end.
 */
function truncateLeft(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  const ell = "\u2026";
  let out = text;
  while (out.length > 0 && visibleWidth(ell + out) > maxWidth) {
    out = out.slice(1);
  }
  return ell + out;
}

/**
 * Truncate a path in the middle, keeping the leading segment (e.g. "~") and as
 * many trailing segments as fit: "~/…/deep/leaf". Falls back to left truncation
 * when even "head/…/leaf" won't fit.
 */
function truncatePathMiddle(path: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(path) <= maxWidth) return path;
  const parts = path.split(sep);
  // Need at least head + middle + leaf to do a meaningful "~/…/leaf".
  if (parts.length <= 2) return truncateLeft(path, maxWidth);
  const head = parts[0];
  const ell = "\u2026";
  const base = `${head}${sep}${ell}${sep}${parts[parts.length - 1]}`;
  if (visibleWidth(base) > maxWidth) return truncateLeft(path, maxWidth);
  // Grow from the leaf back toward the head, keeping as many trailing segments
  // as still fit within the budget.
  let best = base;
  for (let i = parts.length - 2; i >= 1; i--) {
    const grown = `${head}${sep}${ell}${sep}${parts.slice(i).join(sep)}`;
    if (visibleWidth(grown) <= maxWidth) best = grown;
    else break;
  }
  return best;
}

/** Read the current thinking level without throwing if called very early. */
function safeThinking(pi: ExtensionAPI): string {
  try {
    return pi.getThinkingLevel();
  } catch {
    return "off";
  }
}

/** Theme color for a thinking level: dim when off, hotter as effort rises. */
function effortColor(level: string): string {
  switch (level) {
    case "off":
      return "dim";
    case "minimal":
    case "low":
      return "muted";
    case "medium":
      return "accent";
    case "high":
    case "xhigh":
      return "warning";
    case "max":
      return "error";
    default:
      return "text";
  }
}

/** Colored "<pct>%/<window>" segment; grays out when usage is unknown. */
function formatSessionTokens(theme: ThemeLike, ctx: ExtensionContext | undefined): string {
  let input = 0;
  let output = 0;
  for (const entry of ctx?.sessionManager.getBranch() ?? []) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const usage = (entry.message as AssistantMessage).usage;
    input += usage.input;
    output += usage.output;
  }
  for (const usage of subagentTokensByRun.values()) {
    input += usage.input;
    output += usage.output;
  }
  return theme.fg("dim", "tok ") + theme.fg("text", `↑${formatTokens(input)} ↓${formatTokens(output)}`);
}

function formatContext(theme: ThemeLike, usage: ContextUsage | undefined): string {
  if (!usage) return theme.fg("muted", "—");
  const win = formatTokens(usage.contextWindow);
  if (usage.percent == null) return theme.fg("muted", `?/${win}`);
  const pct = usage.percent;
  const color = pct > 90 ? "error" : pct > 70 ? "warning" : "text";
  return theme.fg(color, `${pct.toFixed(0)}%`) + theme.fg("dim", `/${win}`);
}

function alignFooterSides(left: string, right: string, width: number, ellipsis: string): string {
  const leftFitted = truncateToWidth(left, width, ellipsis);
  if (!right) return leftFitted;
  const rightBudget = width - visibleWidth(leftFitted) - 2;
  if (rightBudget <= 0) return leftFitted;
  const rightFitted = truncateToWidth(right, rightBudget, ellipsis);
  const padding = " ".repeat(Math.max(2, width - visibleWidth(leftFitted) - visibleWidth(rightFitted)));
  return truncateToWidth(`${leftFitted}${padding}${rightFitted}`, width, ellipsis);
}

function pulsingAccent(theme: ThemeLike, text: string): string {
  const accentAnsi = theme.getFgAnsi?.("accent");
  const rgb = accentAnsi?.match(/38;2;(\d+);(\d+);(\d+)/);
  if (!rgb) return theme.fg("accent", text);

  const wave = (Math.sin((Date.now() / SUBAGENT_PULSE_CYCLE_MS) * Math.PI * 2) + 1) / 2;
  const brightness = 0.88 + wave * 0.12;
  const shade = rgb.slice(1).map((channel) => Math.min(255, Math.round(Number(channel) * brightness)));
  return `\x1b[38;2;${shade.join(";")}m${text}\x1b[39m`;
}

function makeFooter(pi: ExtensionAPI, theme: ThemeLike, footerData: FooterDataLike): Component {
  const sep = theme.fg("dim", " · ");
  const ellipsis = theme.fg("dim", "…");

  return {
    render(width: number): string[] {
      const ctx = state.ctx;

      // Row 1: cwd/trust on the left; active agent count/models/tokens on the right.
      const agentSummary = state.subagents?.summary
        ? pulsingAccent(theme, state.subagents.summary)
        : "";
      const trusted = ctx?.isProjectTrusted?.() ?? false;
      const trustColor = trusted ? "success" : "warning";
      const trustSuffix = `${sep}${theme.fg("dim", "project ")}${theme.fg(trustColor, trusted ? "trusted" : "untrusted")}`;
      const rawCwd = formatCwd(ctx?.cwd ?? process.cwd());
      const cwdStr = theme.fg("muted", truncatePathMiddle(rawCwd, width - visibleWidth(trustSuffix)));
      const row1 = alignFooterSides(`${cwdStr}${trustSuffix}`, agentSummary, width, ellipsis);

      // Row 2: session model/effort/tokens/context on the left; workflow goal/progress on the right.
      const modelId = state.modelId ?? ctx?.model?.id ?? "no-model";
      const modelStr = theme.fg("accent", theme.bold(prettyModel(modelId)));
      const level = safeThinking(pi);
      const effortStr = theme.fg("dim", "effort ") + theme.fg(effortColor(level), level);
      const tokenStr = formatSessionTokens(theme, ctx);
      const usage = ctx?.getContextUsage?.();
      const ctxStr = theme.fg("dim", "ctx ") + formatContext(theme, usage);
      const row2Left = [modelStr, effortStr, tokenStr, ctxStr].join(sep);

      const workflowActivity = [...footerData.getExtensionStatuses()].flatMap(([key, value]) => {
        if (key !== "workflows") return [];
        const normalized = value.replace(/[\r\n\t]+/g, " ").trim();
        return normalized ? [normalized] : [];
      });
      const row2RightParts = [state.subagents?.workflow, ...workflowActivity].filter(
        (value): value is string => Boolean(value),
      );
      const row2Right = theme.fg("dim", row2RightParts.join(" · "));
      const row2 = alignFooterSides(row2Left, row2Right, width, ellipsis);

      return [row1, row2];
    },
    invalidate() {},
  };
}

// Force a footer repaint. We render our own footer but read effort/context
// live at render time, so we need to nudge the TUI when those change.
// setExtensionStatus() always calls ui.requestRender() (even when clearing a
// key), so toggling an unused, never-displayed key is a clean repaint trigger.
const REPAINT_KEY = "__status_footer_repaint";
function requestRepaint(ctx: ExtensionContext | undefined): void {
  ctx?.ui.setStatus(REPAINT_KEY, undefined);
}

function isFinishedState(value: string | undefined): boolean {
  return value === "complete" || value === "failed" || value === "paused";
}

async function readAsyncStatus(asyncDir: string): Promise<AsyncRunStatus | undefined> {
  try {
    return JSON.parse(await readFile(join(asyncDir, "status.json"), "utf8")) as AsyncRunStatus;
  } catch {
    return undefined;
  }
}

function recordSubagentTokens(id: string, status: AsyncRunStatus | undefined): void {
  if (!status?.totalTokens) return;
  subagentTokensByRun.set(id, {
    input: status.totalTokens.input ?? 0,
    output: status.totalTokens.output ?? 0,
  });
}

async function refreshSubagentFooter(ctx = state.ctx): Promise<void> {
  if (!ctx || subagentRefreshInFlight) return;
  subagentRefreshInFlight = true;
  try {
    const snapshots: Array<{ start: AsyncRunStart; status?: AsyncRunStatus }> = [];
    for (const [id, start] of asyncRuns) {
      const status = await readAsyncStatus(start.asyncDir);
      recordSubagentTokens(id, status);
      if (isFinishedState(status?.state)) {
        asyncRuns.delete(id);
        continue;
      }
      snapshots.push({ start, status });
    }
    const next = formatSubagentFooter(snapshots);
    // pi-subagents uses this widget key for its above-editor async display.
    // Clear it because this footer is the chosen running-agent surface.
    ctx.ui.setWidget("subagent-async", undefined);
    const renderKey = JSON.stringify(next ?? null);
    if (renderKey !== lastSubagentRenderKey) {
      lastSubagentRenderKey = renderKey;
      state.subagents = next;
      ctx.ui.setStatus("subagents", undefined);
    }
    if (next) requestRepaint(ctx);
    else if (asyncRuns.size === 0) stopSubagentPoller();
  } finally {
    subagentRefreshInFlight = false;
  }
}

function ensureSubagentPoller(): void {
  if (asyncRuns.size === 0) return;
  if (!subagentPoller) {
    subagentPoller = setInterval(() => void refreshSubagentFooter(), 500);
    subagentPoller.unref?.();
  }
  if (!subagentPulseTimer) {
    subagentPulseTimer = setInterval(() => requestRepaint(state.ctx), SUBAGENT_PULSE_FRAME_MS);
    subagentPulseTimer.unref?.();
  }
}

function stopSubagentPoller(): void {
  if (subagentPoller) clearInterval(subagentPoller);
  if (subagentPulseTimer) clearInterval(subagentPulseTimer);
  subagentPoller = undefined;
  subagentPulseTimer = undefined;
}

async function restoreActiveSubagents(ctx: ExtensionContext): Promise<void> {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined) return;
  const root = join(tmpdir(), `pi-subagents-uid-${uid}`, "async-subagent-runs");
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const sessionIds = new Set([
    ctx.sessionManager.getSessionFile(),
    ctx.sessionManager.getSessionId(),
  ].filter((value): value is string => Boolean(value)));

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const asyncDir = join(root, entry.name);
    const status = await readAsyncStatus(asyncDir);
    if (!status || !status.sessionId || !sessionIds.has(status.sessionId)) continue;
    recordSubagentTokens(entry.name, status);
    if (isFinishedState(status.state)) continue;
    const agents = status.steps?.map((step) => step.agent).filter((agent): agent is string => Boolean(agent));
    asyncRuns.set(entry.name, {
      id: entry.name,
      asyncDir,
      agent: agents?.[0],
      agents,
    });
  }
  if (asyncRuns.size > 0) {
    ensureSubagentPoller();
    await refreshSubagentFooter(ctx);
  } else {
    requestRepaint(ctx);
  }
}

export default function (pi: ExtensionAPI) {
  // Capture the live ctx and (re)install the custom footer on startup, reload,
  // and every session switch. setFooter hands our factory the active theme.
  pi.on("session_start", async (_event, ctx) => {
    state.ctx = ctx;
    state.modelId = ctx.model?.id;
    state.subagents = undefined;
    asyncRuns.clear();
    subagentTokensByRun.clear();
    ctx.ui.setStatus("subagents", undefined);
    ctx.ui.setFooter((_tui, theme, footerData) =>
      makeFooter(pi, theme as ThemeLike, footerData as FooterDataLike),
    );
    await restoreActiveSubagents(ctx);
  });

  pi.events.on("subagent:async-started", (raw) => {
    const event = raw as Partial<AsyncRunStart> & { runId?: string; task?: string };
    const id = event.id ?? event.runId;
    if (!id || !event.asyncDir) return;
    asyncRuns.set(id, {
      id,
      asyncDir: event.asyncDir,
      agent: event.agent,
      agents: event.agents,
      goal: event.goal ?? event.task,
    });
    ensureSubagentPoller();
    void refreshSubagentFooter();
  });

  pi.events.on("subagent:async-complete", () => {
    // Keep the run until refresh reads its final status and token totals.
    void refreshSubagentFooter();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopSubagentPoller();
    asyncRuns.clear();
    subagentTokensByRun.clear();
    lastSubagentRenderKey = undefined;
    state.subagents = undefined;
    ctx.ui.setStatus("subagents", undefined);
    state.ctx = undefined;
  });

  // Keep the model name fresh when it changes mid-session (Ctrl+P, etc.),
  // then repaint so row 2 reflects it immediately.
  pi.on("model_select", (event, ctx) => {
    state.modelId = event.model.id;
    requestRepaint(ctx);
  });

  // Effort and context are read live at render time; these events just trigger
  // a repaint so the footer reflects the new value the moment it changes.
  pi.on("thinking_level_select", (_event, ctx) => requestRepaint(ctx));
  pi.on("turn_end", (_event, ctx) => requestRepaint(ctx));
  pi.on("message_end", (_event, ctx) => requestRepaint(ctx));
}
