import { Buffer } from "node:buffer";
import {
	preservesBoundaries,
	RECALL_HINT,
	type StructureCheck,
} from "./bridge.ts";
import { bashFileView, resolvePath } from "./views.ts";

/** How a result is handled; also the unit of the coverage report. */
export type Category = "read" | "terminal" | "listing" | "generic";

/** Bundled RTK profile directories under `rtk/`. */
export type Pipeline = "terminal" | "listing" | "generic";

/** RTK's posthook `min_size` guard in `rtk:default`; smaller results are never worth a change. */
export const MIN_BYTES = 512;

// `edit` and `write` results are short confirmations.
const EXCLUDED = new Set(["edit", "write"]);
// Pi's native search tools, plus FFF's names in both registration modes.
const LISTING = new Set([
	"grep",
	"find",
	"ls",
	"ffgrep",
	"fffind",
	"fff-multi-grep",
	"multi_grep",
]);
// RTK's posthook `is_rtk_command` pattern.
export const RTK_IN_COMMAND = /(?:^|[|&;(\s])rtk\s/;
// Recall output must reach the model exactly as stored.
const RTK_RECALL = /(?:^|[|&;(\s])rtk\s+recall\b/;
// FFF binds ` 12: text` match lines to the preceding file heading.
const NUMBERED_LINE = /^ \d+[:-] /;
// Pi bash and MCP notices that point at the saved full output.
const FULL_OUTPUT_NOTICE = /^\[.*Full output: .*\]$/;
// CSI, OSC, and two-byte escape sequences, as removed by RTK's `ansi` method.
const ANSI_ESCAPE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are the match target.
	/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// RTK `dedup` emits `[xN]` (N >= 3) on the line after a collapsed run of identical lines.
const DEDUP_COUNT = /^\[x(\d+)\]$/;
const MIN_DEDUP_RUN = 3;
// RTK `cap` truncates lines over 2,000 characters with a trailing ` [+N chars]` suffix.
const LONG_LINE_CAP = /^([\s\S]*) \[\+(\d+) chars\]$/;
// RTK `base64-elide` replaces standard base64 runs (>= 1,024 chars); adjacent padded runs touch.
const BASE64_ELIDED = /(?:\[base64 data, [^\]]+ elided\])+/g;
const BASE64_MARKER_PREFIX = "[base64 data, ";
const MIN_BASE64_RUN = 1_024;

/** The subset of Pi's `tool_result` event that routing depends on. */
export interface Candidate {
	toolName: string;
	input: Record<string, unknown>;
	content: readonly { type: string; text?: string }[];
	isError: boolean;
	parentToolCallId?: string;
}

export interface Route {
	category: Category;
	text: string;
	/** Absolute path of a file read or a Bash command that only prints one file. */
	path?: string;
	/**
	 * The command went through an RTK wrapper. RTK's filters strip terminal
	 * escapes, so escapes or carriage returns mean the wrapper passed raw
	 * output through; anything else is left alone to avoid double filtering.
	 */
	wrapped?: boolean;
}

/** Category for a tool's results, or `undefined` when this extension never changes them. */
export function categoryFor(toolName: string): Category | undefined {
	if (EXCLUDED.has(toolName)) return undefined;
	if (toolName === "read") return "read";
	if (toolName === "bash") return "terminal";
	return LISTING.has(toolName) ? "listing" : "generic";
}

export function hasRawTerminalOutput(text: string): boolean {
	return text.includes("\u001b") || text.includes("\r");
}

/** Route a result this extension may change, or return nothing. */
export function select(candidate: Candidate, cwd: string): Route | undefined {
	const { toolName, input } = candidate;
	const category = categoryFor(toolName);
	// Nested calls (for example from codemode scripts) feed programs, not the model.
	if (category === undefined || candidate.parentToolCallId !== undefined)
		return;
	if (candidate.content.length !== 1) return;
	const block = candidate.content[0];
	if (block?.type !== "text" || typeof block.text !== "string") return;
	const text = block.text;
	if (Buffer.byteLength(text) < MIN_BYTES) return;

	if (category === "terminal") {
		const command = input.command;
		if (typeof command !== "string" || RTK_RECALL.test(command)) return;
		const path = candidate.isError ? undefined : bashFileView(command, cwd);
		if (path !== undefined) return { category: "read", text, path };
		// Failed commands are included: `cap` keeps their tail.
		return RTK_IN_COMMAND.test(command)
			? { category, text, wrapped: true }
			: { category, text };
	}
	if (candidate.isError) return;
	if (category === "read") {
		return typeof input.path === "string"
			? { category, text, path: resolvePath(input.path, cwd) }
			: undefined;
	}
	return { category, text };
}

/** Name RTK sees; never a Claude Code tool name or an `mcp__` prefix. */
export function rtkToolName(toolName: string): string {
	return `pi-${toolName}`;
}

function lastNonEmptyLines(text: string, limit: number): string[] {
	const lines = text.split("\n");
	const found: string[] = [];
	for (
		let index = lines.length - 1;
		index >= 0 && found.length < limit;
		index--
	) {
		const line = lines[index] ?? "";
		if (line.trim() !== "") found.push(line);
	}
	return found;
}

/** Normalize a line the way `ansi` and `progress` legitimately rewrite it. */
function rendered(line: string | undefined): string | undefined {
	if (line === undefined) return undefined;
	const visible = line.replace(ANSI_ESCAPE, "");
	if (!visible.includes("\r")) return visible;
	return visible.split("\r").findLast((segment) => segment !== "") ?? "";
}

/** Count consecutive lines at the end of `text` (ignoring trailing blanks) matching its final line. */
function trailingRepeatCount(text: string): number {
	const lines = text.split("\n");
	let index = lines.length - 1;
	while (index >= 0 && (lines[index] ?? "").trim() === "") index--;
	if (index < 0) return 0;
	const target = rendered(lines[index]);
	let count = 0;
	while (index >= 0 && rendered(lines[index]) === target) {
		count++;
		index--;
	}
	return count;
}

function isBase64Code(code: number): boolean {
	return (
		(code >= 65 && code <= 90) || // A-Z
		(code >= 97 && code <= 122) || // a-z
		(code >= 48 && code <= 57) || // 0-9
		code === 43 || // +
		code === 47 || // /
		code === 61 // =
	);
}

/** If `cap` cut mid-way through a trailing `[base64 data, ... elided]` marker, complete it for matching. */
function withCompleteTrailingBase64Marker(prefix: string): string | undefined {
	const open = prefix.lastIndexOf("[");
	if (open < 0 || prefix.indexOf("]", open) >= 0) return undefined;
	const tail = prefix.slice(open);
	if (
		tail.startsWith(BASE64_MARKER_PREFIX) ||
		BASE64_MARKER_PREFIX.startsWith(tail)
	) {
		return `${prefix.slice(0, open)}[base64 data, 0 elided]`;
	}
	return undefined;
}

/**
 * Verify `filtered` equals `original` (or a capped prefix when `prefixOnly` is
 * true) with each marker group replacing a standard base64 run of >= 1,024 chars.
 */
function matchesBase64Elided(
	original: string,
	filtered: string,
	prefixOnly = false,
): boolean {
	const parts = filtered.split(BASE64_ELIDED);
	if (parts.length < 2) return false;
	const head = parts[0] ?? "";
	if (!original.startsWith(head)) return false;
	let pos = head.length;
	for (let index = 1; index < parts.length; index++) {
		let spanEnd = pos;
		while (
			spanEnd < original.length &&
			isBase64Code(original.charCodeAt(spanEnd))
		) {
			spanEnd++;
		}
		if (spanEnd - pos < MIN_BASE64_RUN) return false;
		const literal = parts[index] ?? "";
		const isLast = index === parts.length - 1;
		if (isLast && !prefixOnly) {
			const end = original.length - literal.length;
			return (
				end >= pos + MIN_BASE64_RUN &&
				end <= spanEnd &&
				original.endsWith(literal)
			);
		}
		if (isLast && prefixOnly) {
			if (literal === "") return true;
			const next = original.indexOf(literal, pos + MIN_BASE64_RUN);
			return (
				next >= 0 && next <= spanEnd && next + literal.length < original.length
			);
		}
		const next = original.indexOf(literal, pos + MIN_BASE64_RUN);
		if (next < 0 || next > spanEnd) return false;
		pos = next + literal.length;
	}
	return false;
}

/** Check that RTK kept the final line, allowing `ansi`, `progress`, `base64-elide`, and long-line `cap`. */
function matchesLastLine(
	original: string | undefined,
	filtered: string | undefined,
): boolean {
	const origVis = rendered(original);
	const filtVis = rendered(filtered);
	if (origVis === undefined || filtVis === undefined)
		return origVis === filtVis;
	if (origVis === filtVis) return true;
	if (matchesBase64Elided(origVis, filtVis)) return true;
	const capped = LONG_LINE_CAP.exec(filtVis);
	if (capped?.[1] !== undefined && capped[2] !== undefined) {
		const prefix = capped[1];
		const omitted = Number(capped[2]);
		if (
			omitted > 0 &&
			origVis.startsWith(prefix) &&
			[...origVis].length - [...prefix].length === omitted
		) {
			return true;
		}
		// `base64-elide` can run before `cap` on the same line (including cutting inside the marker).
		if (omitted > 0) {
			if (matchesBase64Elided(origVis, prefix, true)) return true;
			const completed = withCompleteTrailingBase64Marker(prefix);
			if (
				completed !== undefined &&
				matchesBase64Elided(origVis, completed, true)
			)
				return true;
		}
	}
	return false;
}

/**
 * Status lines and Pi notices end the output and point at the saved full
 * output, so both must survive filtering unchanged (allowing RTK's `ansi`,
 * `progress`, `dedup`, `base64-elide`, and long-line `cap` rewrites).
 */
export function preservesTrailer(original: string, filtered: string): boolean {
	const body = filtered.replace(RECALL_HINT, "");
	const [origLast] = lastNonEmptyLines(original, 1);
	const [filtLast, filtPrev] = lastNonEmptyLines(body, 2);
	const dedupMatch = filtLast !== undefined ? DEDUP_COUNT.exec(filtLast) : null;
	const dedupCount = dedupMatch?.[1] ? Number(dedupMatch[1]) : 0;
	const dedupedTail =
		dedupCount >= MIN_DEDUP_RUN &&
		trailingRepeatCount(original) === dedupCount &&
		matchesLastLine(origLast, filtPrev);
	if (!dedupedTail && !matchesLastLine(origLast, filtLast)) return false;
	const kept = new Set(body.split("\n"));
	return original
		.split("\n")
		.every((line) => !FULL_OUTPUT_NOTICE.test(line) || kept.has(line));
}

export function structureCheck(pipeline: Pipeline): StructureCheck {
	if (pipeline !== "listing") return preservesTrailer;
	return (original, filtered) =>
		preservesTrailer(original, filtered) &&
		// FFF output in override mode reaches this profile under native names.
		(!original.split("\n").some((line) => NUMBERED_LINE.test(line)) ||
			preservesBoundaries(original, filtered));
}

// A replacement must save at least this much to be worth a lossy or reformatted view.
export const MIN_SAVED_BYTES = 128;
export const MIN_SAVED_RATIO = 0.1;

/** Never-worse plus a minimum gain: small or negative savings keep the original. */
export function worthReplacing(original: string, replacement: string): boolean {
	const before = Buffer.byteLength(original);
	const saved = before - Buffer.byteLength(replacement);
	return saved >= MIN_SAVED_BYTES && saved >= before * MIN_SAVED_RATIO;
}
