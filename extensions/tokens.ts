import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createReadStream } from "node:fs";
import { opendir } from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import {
	ASYNC_TOKEN_ENTRY_TYPE,
	parseAsyncTokenSnapshot,
	parseTokenUsage,
	type AsyncRunStatus,
	type AsyncTokenSnapshot,
	type TokenUsage,
} from "./domain.ts";

export const LEGACY_ASYNC_SNAPSHOT_ID = "legacy-async-v1";
export const MAX_LEGACY_ASYNC_SESSIONS = 256;
export const MAX_DISCOVERED_DIRECTORIES = 1_024;

export interface SessionTokenReadLimits {
	maxBytes: number;
	maxLineBytes: number;
	maxLines: number;
	maxEntries: number;
}

export interface RelatedSessionDiscoveryLimits {
	maxDirectoryEntries: number;
	maxSessions: number;
}

const DEFAULT_RELATED_SESSION_LIMITS: RelatedSessionDiscoveryLimits = {
	maxDirectoryEntries: MAX_DISCOVERED_DIRECTORIES,
	maxSessions: MAX_LEGACY_ASYNC_SESSIONS,
};

const DEFAULT_SESSION_TOKEN_LIMITS: SessionTokenReadLimits = {
	maxBytes: 64 * 1024 * 1024,
	maxLineBytes: 8 * 1024 * 1024,
	maxLines: 200_000,
	maxEntries: 100_000,
};

export interface LegacyTokenCoverage {
	root: string;
	recordedAt: number;
	sessions: Set<string>;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function zeroTokens(): TokenUsage {
	return { input: 0, output: 0, total: 0 };
}

export function addTokens(target: TokenUsage, usage: TokenUsage): void {
	target.input += usage.input;
	target.output += usage.output;
	target.total = target.input + target.output;
}

function assistantTokens(entries: readonly unknown[]): TokenUsage {
	const result = zeroTokens();
	for (const value of entries) {
		const entry = record(value);
		const message = record(entry?.message);
		if (entry?.type !== "message" || message?.role !== "assistant") continue;
		const usage = parseTokenUsage(message.usage);
		if (usage) addTokens(result, usage);
	}
	return result;
}

interface SessionTokenNode {
	parentId?: string;
	usage?: TokenUsage;
}

export async function sessionTokensFromFile(
	sessionFile: string,
	limits: SessionTokenReadLimits = DEFAULT_SESSION_TOKEN_LIMITS,
): Promise<TokenUsage | undefined> {
	const byId = new Map<string, SessionTokenNode>();
	let leafId: string | undefined;
	let totalBytes = 0;
	let lineCount = 0;
	let entryCount = 0;
	let pending = "";
	const input = createReadStream(sessionFile, {
		encoding: "utf8",
		highWaterMark: 64 * 1024,
	});
	const consumeLine = (rawLine: string): boolean => {
		lineCount++;
		if (
			lineCount > limits.maxLines ||
			Buffer.byteLength(rawLine, "utf8") > limits.maxLineBytes
		)
			return false;
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (!line.trim()) return true;
		const parsed = JSON.parse(line) as unknown;
		entryCount++;
		if (entryCount > limits.maxEntries) return false;
		const entry = record(parsed);
		if (!entry || typeof entry.id !== "string") return true;
		const message = record(entry.message);
		byId.set(entry.id, {
			parentId:
				typeof entry.parentId === "string" ? entry.parentId : undefined,
			usage:
				entry.type === "message" && message?.role === "assistant"
					? parseTokenUsage(message.usage)
					: undefined,
		});
		leafId = entry.id;
		return true;
	};
	try {
		for await (const chunk of input) {
			totalBytes += Buffer.byteLength(chunk, "utf8");
			if (totalBytes > limits.maxBytes) return undefined;
			pending += chunk;
			let newline = pending.indexOf("\n");
			while (newline >= 0) {
				if (!consumeLine(pending.slice(0, newline))) return undefined;
				pending = pending.slice(newline + 1);
				newline = pending.indexOf("\n");
			}
			if (Buffer.byteLength(pending, "utf8") > limits.maxLineBytes)
				return undefined;
		}
		if (pending && !consumeLine(pending)) return undefined;
	} catch {
		return undefined;
	} finally {
		input.destroy();
	}
	const result = zeroTokens();
	const seen = new Set<string>();
	while (leafId && !seen.has(leafId)) {
		seen.add(leafId);
		const node = byId.get(leafId);
		if (!node) break;
		if (node.usage) addTokens(result, node.usage);
		leafId = node.parentId;
	}
	return result;
}

export async function discoverRunDirectories(
	root: string,
	maxEntries = MAX_DISCOVERED_DIRECTORIES,
): Promise<string[] | undefined> {
	try {
		const directory = await opendir(root);
		const directories: string[] = [];
		let scanned = 0;
		for await (const entry of directory) {
			scanned++;
			if (scanned > maxEntries) return undefined;
			if (entry.isDirectory()) directories.push(join(root, entry.name));
		}
		return directories;
	} catch {
		return undefined;
	}
}

export async function discoverRelatedSessionFiles(
	sessionFile: string,
	limits: RelatedSessionDiscoveryLimits = DEFAULT_RELATED_SESSION_LIMITS,
): Promise<string[] | undefined> {
	const stepDirectory = dirname(sessionFile);
	if (!/^run-\d+$/.test(basename(stepDirectory))) return [sessionFile];
	try {
		const runDirectory = dirname(stepDirectory);
		const directory = await opendir(runDirectory);
		const related: string[] = [];
		let scanned = 0;
		for await (const entry of directory) {
			scanned++;
			if (scanned > limits.maxDirectoryEntries) return undefined;
			if (!entry.isDirectory() || !/^run-\d+$/.test(entry.name)) continue;
			if (related.length >= limits.maxSessions) return undefined;
			related.push(join(runDirectory, entry.name, "session.jsonl"));
		}
		related.sort((left, right) => left.localeCompare(right));
		return related.length > 0 ? related : [sessionFile];
	} catch {
		return undefined;
	}
}

export function sessionTokens(ctx: ExtensionContext): TokenUsage {
	return assistantTokens(ctx.sessionManager.getBranch());
}

export function sessionTreeRoot(ctx: ExtensionContext): string | undefined {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile || !sessionFile.endsWith(".jsonl")) return undefined;
	return resolve(sessionFile.slice(0, -".jsonl".length));
}

export function containedRelativePath(
	root: string,
	candidate: string,
): string | undefined {
	const target = resolve(candidate);
	const rel = relative(root, target);
	if (
		rel === "" ||
		rel === ".." ||
		rel.startsWith(`..${sep}`) ||
		isAbsolute(rel)
	)
		return undefined;
	return rel;
}

function sessionFilesCovered(
	sessionFiles: string[] | undefined,
	coverage: LegacyTokenCoverage | undefined,
): boolean {
	return Boolean(
		coverage &&
			sessionFiles?.length &&
			sessionFiles.every((sessionFile) => {
				const rel = containedRelativePath(coverage.root, sessionFile);
				return rel !== undefined && coverage.sessions.has(rel);
			}),
	);
}

export function snapshotCoveredByLegacy(
	snapshot: AsyncTokenSnapshot,
	coverage: LegacyTokenCoverage | undefined,
): boolean {
	return Boolean(
		coverage &&
			sessionFilesCovered(snapshot.sessionFiles, coverage) &&
			(snapshot.completedAt === undefined ||
				snapshot.completedAt <= coverage.recordedAt),
	);
}

export function tokenSnapshots(ctx: ExtensionContext): {
	tokens: Map<string, TokenUsage>;
	snapshots: Map<string, AsyncTokenSnapshot>;
	legacyCoverage?: LegacyTokenCoverage;
} {
	const snapshots = new Map<string, AsyncTokenSnapshot>();
	for (const value of ctx.sessionManager.getBranch()) {
		const entry = record(value);
		if (entry?.type !== "custom" || entry.customType !== ASYNC_TOKEN_ENTRY_TYPE)
			continue;
		const snapshot = parseAsyncTokenSnapshot(entry.data);
		if (snapshot) snapshots.set(snapshot.id, snapshot);
	}
	const root = sessionTreeRoot(ctx);
	const legacy = snapshots.get(LEGACY_ASYNC_SNAPSHOT_ID);
	const legacyCoverage =
		root && legacy?.completedAt !== undefined
			? {
					root,
					recordedAt: legacy.completedAt,
					sessions: new Set(legacy.coveredSessions ?? []),
				}
			: undefined;
	const tokens = new Map<string, TokenUsage>();
	for (const snapshot of snapshots.values()) {
		if (snapshotCoveredByLegacy(snapshot, legacyCoverage)) continue;
		tokens.set(snapshot.id, snapshot.totalTokens);
	}
	return { tokens, snapshots, legacyCoverage };
}

export function legacyAsyncSessionCandidates(
	ctx: ExtensionContext,
): string[] | undefined {
	const root = sessionTreeRoot(ctx);
	if (!root) return [];
	const candidates = new Map<string, string>();
	for (const value of ctx.sessionManager.getBranch()) {
		const entry = record(value);
		if (
			entry?.type !== "custom_message" ||
			entry.customType !== "subagent-notify" ||
			typeof entry.content !== "string"
		)
			continue;
		for (const match of entry.content.matchAll(
			/Session(?: file)?:[ \t]*([^\r\n]+?\.jsonl)\s*$/gm,
		)) {
			const absolute = resolve(match[1].trim());
			const rel = containedRelativePath(root, absolute);
			if (!rel || candidates.has(rel)) continue;
			if (candidates.size >= MAX_LEGACY_ASYNC_SESSIONS) return undefined;
			candidates.set(rel, absolute);
		}
	}
	return [...candidates.values()];
}

export function statusCoveredByLegacy(
	status: AsyncRunStatus,
	coverage: LegacyTokenCoverage | undefined,
): boolean {
	if (!coverage || !sessionFilesCovered(status.sessionFiles, coverage))
		return false;
	const statusTime = status.endedAt ?? status.startedAt;
	return statusTime === undefined || statusTime <= coverage.recordedAt;
}
