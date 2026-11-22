import { Buffer } from "node:buffer";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { TextContent, ToolCall } from "@earendil-works/pi-ai";
import type { CustomEntry } from "@earendil-works/pi-coding-agent";
import { displayLabel } from "../shared/display.ts";
import {
	ENTRY_TYPE,
	mergeTallies,
	type Outcome,
	parseEntry,
	type Tally,
} from "./outcomes.ts";
import {
	categoryFor,
	isRtkWrapped,
	MIN_BYTES,
	SHELL_PREFIX,
	SHELL_PREFIX_FLAGS_WITH_ARG,
	SHELL_SETUP,
} from "./policy.ts";

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
// Classify the largest commands first when spawning rtk rewrite.
const MAX_CLASSIFIED = 2_000;
const CONCURRENCY = 8;
const TOP_TOOLS = 15;
const TOP_PROGRAMS = 8;
const DAY_MS = 86_400_000;
// Pi stores subagent sessions under `<project>/<session>/<run-id>/run-0/session.jsonl`.
const MAX_SESSION_DEPTH = 4;
// Subagent transcript artifacts duplicate session tool results and are not Pi sessions.
const IGNORED_DIRS = new Set(["subagent-artifacts"]);

export type Scope = "project" | "all";

export interface CoverageOptions {
	days: number;
	scope: Scope;
}

export type ParsedArgs =
	| { ok: true; options: CoverageOptions }
	| { ok: false; message: string };

const USAGE = "Usage: /rtk-coverage [days 1-365] [project|all]";

export function parseCoverageArgs(args: string): ParsedArgs {
	let days: number | undefined;
	let scope: Scope | undefined;
	for (const token of args.trim().split(/\s+/).filter(Boolean)) {
		if ((token === "project" || token === "all") && scope === undefined) {
			scope = token;
		} else if (/^\d{1,3}$/.test(token) && days === undefined) {
			days = Number(token);
			if (days < 1 || days > MAX_DAYS)
				return { ok: false, message: `Days must be 1-${MAX_DAYS}. ${USAGE}` };
		} else {
			return {
				ok: false,
				message: `Unsupported argument "${token}". ${USAGE}`,
			};
		}
	}
	return {
		ok: true,
		options: { days: days ?? DEFAULT_DAYS, scope: scope ?? "project" },
	};
}

export interface Usage {
	results: number;
	bytes: number;
}

export interface Scan {
	files: number;
	unreadableLines: number;
	invalidEntries: number;
	tools: Map<string, Usage>;
	/** Delivered bash output keyed by the model-issued command ("" when unknown). */
	bashCommands: Map<string, Usage>;
	tallies: Map<string, Tally>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextBlock(value: unknown): value is TextContent {
	return (
		isRecord(value) && value.type === "text" && typeof value.text === "string"
	);
}

function isBashToolCall(value: unknown): value is Pick<
	ToolCall,
	"type" | "id" | "name"
> & {
	arguments: { command: string };
} {
	return (
		isRecord(value) &&
		value.type === "toolCall" &&
		value.name === "bash" &&
		typeof value.id === "string" &&
		isRecord(value.arguments) &&
		typeof value.arguments.command === "string"
	);
}

function isOutcomeCustomEntry(
	entry: Record<string, unknown>,
): entry is Record<string, unknown> & Pick<CustomEntry, "type" | "customType"> {
	return entry.type === "custom" && entry.customType === ENTRY_TYPE;
}

function isMissing(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function add(usage: Map<string, Usage>, key: string, bytes: number): void {
	const current = usage.get(key);
	if (current) {
		current.results++;
		current.bytes += bytes;
	} else usage.set(key, { results: 1, bytes });
}

/** Recursively collect Pi session `.jsonl` files under directory without following symlinks. */
async function jsonlFiles(directory: string, depth = 0): Promise<string[]> {
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		const found: string[] = [];
		const subdirs: string[] = [];
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				found.push(join(directory, entry.name));
			} else if (
				entry.isDirectory() &&
				depth < MAX_SESSION_DEPTH &&
				!IGNORED_DIRS.has(entry.name)
			) {
				subdirs.push(join(directory, entry.name));
			}
		}
		if (subdirs.length > 0) {
			const nested = await Promise.all(
				subdirs.map((subdir: string) => jsonlFiles(subdir, depth + 1)),
			);
			for (const list of nested) found.push(...list);
		}
		return found;
	} catch (error: unknown) {
		if (isMissing(error)) return [];
		throw error;
	}
}

/** Return session files modified since sinceMs without following symlinks. */
export async function sessionFiles(
	sessionDir: string,
	scope: Scope,
	sinceMs: number,
): Promise<string[]> {
	let directories = [sessionDir];
	if (scope === "all") {
		const root = dirname(sessionDir);
		try {
			const entries = await readdir(root, { withFileTypes: true });
			directories = entries
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(root, entry.name));
		} catch (error: unknown) {
			if (!isMissing(error)) throw error;
			directories = [];
		}
	}
	const files = (
		await Promise.all(directories.map((dir: string) => jsonlFiles(dir)))
	).flat();
	const recent: string[] = [];
	for (const file of files) {
		if ((await stat(file)).mtimeMs >= sinceMs) recent.push(file);
	}
	return recent.sort();
}

function textBytes(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	let bytes = 0;
	for (const block of content) {
		if (isTextBlock(block)) bytes += Buffer.byteLength(block.text);
	}
	return bytes;
}

function scanOutcomeEntry(
	entry: Record<string, unknown>,
	sinceMs: number,
	scan: Scan,
): void {
	const time =
		typeof entry.timestamp === "string"
			? Date.parse(entry.timestamp)
			: Number.NaN;
	const data = parseEntry(entry.data);
	if (Number.isNaN(time) || !data) {
		scan.invalidEntries++;
		return;
	}
	if (time < sinceMs) return;
	for (const tally of data.tallies) mergeTallies(scan.tallies, tally);
}

/** Record bash commands issued by the model before any tool_call hook rewrites them. */
function collectBashCommands(
	content: unknown[],
	commands: Map<string, string>,
): void {
	for (const block of content) {
		if (isBashToolCall(block)) {
			commands.set(block.id, block.arguments.command);
		}
	}
}

function scanToolResult(
	message: Record<string, unknown>,
	sinceMs: number,
	commands: ReadonlyMap<string, string>,
	scan: Scan,
): void {
	const { toolName, timestamp, toolCallId } = message;
	if (
		typeof toolName !== "string" ||
		typeof timestamp !== "number" ||
		timestamp < sinceMs
	)
		return;
	const bytes = textBytes(message.content);
	add(scan.tools, toolName, bytes);
	if (toolName !== "bash") return;
	const command =
		typeof toolCallId === "string" ? commands.get(toolCallId) : undefined;
	add(scan.bashCommands, command ?? "", bytes);
}

function scanEntry(
	entry: Record<string, unknown>,
	sinceMs: number,
	commands: Map<string, string>,
	scan: Scan,
): void {
	if (isOutcomeCustomEntry(entry)) {
		scanOutcomeEntry(entry, sinceMs, scan);
		return;
	}
	// Ignore non-session records such as subagent transcript artifacts.
	if (entry.type !== "message") return;
	const message = entry.message;
	if (!isRecord(message)) return;
	if (message.role === "assistant" && Array.isArray(message.content))
		collectBashCommands(message.content, commands);
	else if (message.role === "toolResult")
		scanToolResult(message, sinceMs, commands, scan);
}

/** Aggregate delivered tool output byte counts and extension outcome tallies across sessions. */
export async function scanSessions(
	files: readonly string[],
	sinceMs: number,
): Promise<Scan> {
	const scan: Scan = {
		files: files.length,
		unreadableLines: 0,
		invalidEntries: 0,
		tools: new Map(),
		bashCommands: new Map(),
		tallies: new Map(),
	};
	for (const file of files) {
		const commands = new Map<string, string>();
		const lines = createInterface({
			input: createReadStream(file, { encoding: "utf8" }),
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		for await (const line of lines) {
			if (line.trim() === "") continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				scan.unreadableLines++;
				continue;
			}
			if (isRecord(entry)) scanEntry(entry, sinceMs, commands, scan);
			else scan.unreadableLines++;
		}
	}
	return scan;
}

/** Return true when RTK's Pi hook rewrites the command, or undefined when unknown. */
export type Rewrite = (command: string) => Promise<boolean | undefined>;

export interface BashCoverage {
	rewritten: Usage;
	notRewritten: Usage;
	unclassified: Usage;
	/** Non-rewritten bash output grouped by leading program name. */
	programs: Map<string, Usage>;
}

function segmentProgram(segment: string): string | undefined {
	// Skip VAR=value assignments and transparent command wrappers so values never print.
	const words = segment.match(/[^\s;&|()]+/g) ?? [];
	let fallback: string | undefined;
	let prefix: string | undefined;
	let skipNextArg = false;
	for (const word of words) {
		if (skipNextArg) {
			skipNextArg = false;
			continue;
		}
		if (word.includes("=")) continue;
		if (prefix !== undefined && word.startsWith("-")) {
			if (word === "--") {
				prefix = undefined;
				continue;
			}
			if (SHELL_PREFIX_FLAGS_WITH_ARG[prefix]?.has(word)) skipNextArg = true;
			continue;
		}
		prefix = undefined;
		const name = word.slice(word.lastIndexOf("/") + 1);
		fallback ??= name;
		if (SHELL_PREFIX.has(name)) {
			prefix = name;
			continue;
		}
		return name;
	}
	return fallback;
}

function program(command: string): string {
	// Join line continuations and blank quoted literals so embedded separators or secrets never surface.
	const sanitized = command
		.replace(/\\\r?\n/g, " ")
		.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");
	let fallback: string | undefined;
	for (const segment of sanitized.split(/(?:&&|\|\||;|\n)+/)) {
		const name = segmentProgram(segment);
		if (name === undefined || name === "''") continue;
		fallback ??= name;
		if (!SHELL_SETUP.has(name)) return name;
	}
	return fallback ?? "?";
}

function merge(target: Usage, usage: Usage): void {
	target.results += usage.results;
	target.bytes += usage.bytes;
}

export async function classifyBash(
	commands: ReadonlyMap<string, Usage>,
	rewrite: Rewrite,
): Promise<BashCoverage> {
	const coverage: BashCoverage = {
		rewritten: { results: 0, bytes: 0 },
		notRewritten: { results: 0, bytes: 0 },
		unclassified: { results: 0, bytes: 0 },
		programs: new Map(),
	};
	const queue = [...commands].sort(
		(a: [string, Usage], b: [string, Usage]) => b[1].bytes - a[1].bytes,
	);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < queue.length) {
			const index = next++;
			const [command, usage] = queue[index] ?? ["", { results: 0, bytes: 0 }];
			let rewritten: boolean | undefined;
			if (command.trim() === "" || index >= MAX_CLASSIFIED)
				rewritten = undefined;
			else if (isRtkWrapped(command)) rewritten = true;
			else rewritten = await rewrite(command);

			if (rewritten === undefined) merge(coverage.unclassified, usage);
			else if (rewritten) merge(coverage.rewritten, usage);
			else {
				merge(coverage.notRewritten, usage);
				const name = program(command);
				const current = coverage.programs.get(name) ?? { results: 0, bytes: 0 };
				merge(current, usage);
				coverage.programs.set(name, current);
			}
		}
	};
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));
	return coverage;
}

function size(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function percent(part: number, whole: number): string {
	return whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`;
}

function owner(tool: string): string {
	switch (categoryFor(tool)) {
		case "terminal":
			return "rtk rewrite, terminal, lossless";
		case "read":
			return "dedup, non-code views";
		case "listing":
			return tool === "grep" ? "listing, grep groups" : "listing";
		case "generic":
			return "generic, lossless, dedup";
		default:
			return "none";
	}
}

function usageLine(label: string, usage: Usage, total: number): string {
	return `  ${label.padEnd(16)} ${size(usage.bytes).padStart(9)}  ${String(usage.results).padStart(6)} results  ${percent(usage.bytes, total).padStart(4)}`;
}

function byBytes<K>(usage: Iterable<[K, Usage]>): [K, Usage][] {
	return [...usage].sort(
		(a: [K, Usage], b: [K, Usage]) => b[1].bytes - a[1].bytes,
	);
}

interface Savings {
	/** Original bytes of accepted replacements. */
	touched: number;
	saved: number;
	results: number;
}

/** Sum byte savings from accepted replacements grouped by key. */
function savingsBy(
	scan: Scan,
	key: (tally: Tally) => string,
): Map<string, Savings> {
	const savings = new Map<string, Savings>();
	for (const tally of scan.tallies.values()) {
		if (tally.outcome !== "filtered") continue;
		const id = key(tally);
		const current = savings.get(id) ?? { touched: 0, saved: 0, results: 0 };
		current.touched += tally.bytesBefore;
		current.saved += tally.bytesBefore - tally.bytesAfter;
		current.results += tally.count;
		savings.set(id, current);
	}
	return savings;
}

// Sanitize tool and program names before rendering them in the report.
function label(name: string, limit = 16): string {
	return displayLabel(name, limit) || "?";
}

function toolSection(scan: Scan): string[] {
	const byTool = savingsBy(scan, (tally: Tally) => tally.tool);
	const delivered = [...scan.tools.values()].reduce(
		(sum: number, item: Usage) => sum + item.bytes,
		0,
	);
	const results = [...scan.tools.values()].reduce(
		(sum: number, item: Usage) => sum + item.results,
		0,
	);
	const saved = [...byTool.values()].reduce(
		(sum: number, item: Savings) => sum + item.saved,
		0,
	);
	const touched = [...byTool.values()].reduce(
		(sum: number, item: Savings) => sum + item.touched,
		0,
	);
	// Sessions store delivered text, so original volume equals delivered bytes plus accepted savings.
	const original = delivered + saved;
	const tools = [...scan.tools]
		.map(([tool, usage]: [string, Usage]) => {
			const own = byTool.get(tool) ?? { touched: 0, saved: 0, results: 0 };
			return { tool, usage, own, original: usage.bytes + own.saved };
		})
		.sort((a, b) => b.original - a.original);
	const lines = [
		`Tool output: ${size(original)} originally, ${size(delivered)} delivered, in ${results} results`,
		`rtk-pi-extended touched ${percent(touched, original)} of all tool output and removed ${percent(saved, touched)} of what it touched: ${size(saved)}, ${percent(saved, original)} of all tool output.`,
		"",
		"By tool        original  share  touched  saved  filter owner",
		...tools
			.slice(0, TOP_TOOLS)
			.map(
				({ tool, own, original: bytes }) =>
					`  ${label(tool).padEnd(16)}${size(bytes).padStart(9)}  ${percent(bytes, original).padStart(5)}  ${percent(own.touched, bytes).padStart(7)}  ${percent(own.saved, bytes).padStart(5)}  ${owner(tool)}`,
			),
	];
	if (tools.length > TOP_TOOLS)
		lines.push(`  … ${tools.length - TOP_TOOLS} more tools`);
	return lines;
}

function mechanismSection(scan: Scan): string[] {
	const byMechanism = byBytes(
		[...savingsBy(scan, (tally: Tally) => tally.mechanism)].map(
			([name, item]: [string, Savings]): [string, Usage] => [
				name,
				{ results: item.results, bytes: item.saved },
			],
		),
	);
	if (byMechanism.length === 0) return [];
	return [
		"Savings by mechanism (accepted replacements)",
		...byMechanism.map(
			([name, item]: [string, Usage]) =>
				`  ${label(name).padEnd(16)} ${size(item.bytes).padStart(9)} saved in ${item.results} results`,
		),
		"",
	];
}

function bashSection(scan: Scan, bash: BashCoverage): string[] {
	const total = scan.tools.get("bash")?.bytes ?? 0;
	const lines = [
		"Bash output by current `rtk rewrite` rules",
		usageLine("rewritten", bash.rewritten, total),
		usageLine("not rewritten", bash.notRewritten, total),
		usageLine("unclassified", bash.unclassified, total),
	];
	const programs = byBytes(bash.programs).slice(0, TOP_PROGRAMS);
	if (programs.length > 0) {
		const listed = programs.map(
			([name, item]: [string, Usage]) =>
				`${label(name, 32)} ${size(item.bytes)} (${item.results})`,
		);
		lines.push(`  largest not rewritten: ${listed.join(", ")}`);
	}
	return lines;
}

function outcomeSection(scan: Scan): string[] {
	const totals = new Map<
		Outcome,
		{ results: number; before: number; after: number }
	>();
	const reasons = new Map<string, number>();
	for (const tally of scan.tallies.values()) {
		const current = totals.get(tally.outcome) ?? {
			results: 0,
			before: 0,
			after: 0,
		};
		current.results += tally.count;
		current.before += tally.bytesBefore;
		current.after += tally.bytesAfter;
		totals.set(tally.outcome, current);
		if (tally.reason)
			reasons.set(tally.reason, (reasons.get(tally.reason) ?? 0) + tally.count);
	}
	const lines = [
		`rtk-pi-extended outcomes (results of at least ${MIN_BYTES} bytes)`,
	];
	if (scan.tallies.size === 0)
		return [...lines, "  no recorded outcomes in this window"];
	const filtered = totals.get("filtered") ?? {
		results: 0,
		before: 0,
		after: 0,
	};
	const removed = percent(filtered.before - filtered.after, filtered.before);
	const failed = totals.get("failed")?.results ?? 0;
	const detail = [...reasons]
		.map(([reason, count]: [string, number]) => `${reason} ${count}`)
		.join(", ");
	lines.push(
		`  filtered   ${filtered.results} results, ${size(filtered.before)} -> ${size(filtered.after)} (${removed} removed)`,
		`  unchanged  ${totals.get("unchanged")?.results ?? 0} results`,
		`  original kept after a failed check  ${failed} results${failed > 0 ? ` (${detail})` : ""}`,
	);
	return lines;
}

export function formatReport(
	options: CoverageOptions,
	scan: Scan,
	bash: BashCoverage,
): string {
	const scope = options.scope === "all" ? "all projects" : "this project";
	const lines = [
		`RTK coverage, last ${options.days} days, ${scope} (${scan.files} session files)`,
		...toolSection(scan),
		"",
		...bashSection(scan, bash),
		"",
		...mechanismSection(scan),
		...outcomeSection(scan),
	];
	if (scan.unreadableLines > 0 || scan.invalidEntries > 0) {
		lines.push(
			"",
			`Skipped ${scan.unreadableLines} unreadable session lines and ${scan.invalidEntries} invalid outcome entries.`,
		);
	}
	lines.push(
		"",
		`Results under ${MIN_BYTES} bytes are never changed. Bash rows apply today's rewrite rules to past commands; RTK's own savings on rewritten commands appear in rtk gain, not here.`,
	);
	return lines.join("\n");
}

export function windowStart(days: number, now = Date.now()): number {
	return now - days * DAY_MS;
}
