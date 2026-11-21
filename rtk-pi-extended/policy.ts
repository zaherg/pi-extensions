import { Buffer } from "node:buffer";
import {
	isBashToolResult,
	isReadToolResult,
	type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
	preservesBoundaries,
	RECALL_HINT,
	type StructureCheck,
} from "./bridge.ts";
import { bashFileView, resolvePath } from "./views.ts";

/** Filtering category assigned to a tool result. */
export type Category = "read" | "terminal" | "listing" | "generic";

/** Bundled RTK profile directories under `rtk/`. */
export type Pipeline = "terminal" | "listing" | "generic";

/** Minimum UTF-8 byte size before a tool result is considered for filtering. */
export const MIN_BYTES = 512;

// Skip edit and write tools because their results are short confirmations.
const EXCLUDED = new Set(["edit", "write"]);
// Match Pi's built-in search tools and FFF's tool names in both registration modes.
const LISTING = new Set([
	"grep",
	"find",
	"ls",
	"ffgrep",
	"fffind",
	"fff-multi-grep",
	"multi_grep",
]);
// Match commands invoking rtk directly.
export const RTK_IN_COMMAND = /(?:^|[|&;(\s])rtk\s/;
// Leave rtk recall output untouched so stored originals reach the model verbatim.
const RTK_RECALL = /(?:^|[|&;(\s])rtk\s+recall\b/;
// Match numbered FFF output lines bound to a preceding file heading.
const NUMBERED_LINE = /^ \d+[:-] /;
// Match Pi bash and MCP notices pointing to saved full output files.
const FULL_OUTPUT_NOTICE = /^\[.*Full output: .*\]$/;
// Match CSI, OSC, and two-byte terminal escape sequences removed by RTK's ansi method.
const ANSI_ESCAPE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are the match target.
	/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// Match `[xN]` markers emitted by RTK's dedup method after collapsed identical lines.
const DEDUP_COUNT = /^\[x(\d+)\]$/;
const MIN_DEDUP_RUN = 3;
// Match lines over 2,000 characters truncated by RTK's cap method.
const LONG_LINE_CAP = /^([\s\S]*) \[\+(\d+) chars\]$/;
// Match one or more adjacent base64 elision markers emitted by RTK.
const BASE64_ELIDED = /(?:\[base64 data, [^\]]+ elided\])+/g;
const BASE64_MARKER_PREFIX = "[base64 data, ";
const MIN_BASE64_RUN = 1_024;

export interface Route {
	category: Category;
	text: string;
	/** Absolute path of a file read or a single-file Bash print command. */
	path?: string;
	/** True when the Bash command invoked rtk directly so clean output is not filtered twice. */
	wrapped?: boolean;
}

/** Return the filtering category for a tool name, or undefined when excluded. */
export function categoryFor(toolName: string): Category | undefined {
	if (EXCLUDED.has(toolName)) return undefined;
	if (toolName === "read") return "read";
	if (toolName === "bash") return "terminal";
	return LISTING.has(toolName) ? "listing" : "generic";
}

export function hasRawTerminalOutput(text: string): boolean {
	return text.includes("\u001b") || text.includes("\r");
}

/** Route a Pi tool_result event for filtering, or return undefined when skipped. */
export function select(event: ToolResultEvent, cwd: string): Route | undefined {
	const category = categoryFor(event.toolName);
	// Ignore nested tool calls because they feed caller scripts rather than the model.
	if (category === undefined || event.parentToolCallId !== undefined)
		return undefined;
	if (event.content.length !== 1) return undefined;
	const block = event.content[0];
	if (block?.type !== "text" || typeof block.text !== "string") return undefined;
	const text = block.text;
	if (Buffer.byteLength(text) < MIN_BYTES) return undefined;

	if (isBashToolResult(event)) {
		const command = event.input.command;
		if (typeof command !== "string" || RTK_RECALL.test(command)) return undefined;
		const path = event.isError ? undefined : bashFileView(command, cwd);
		if (path !== undefined) return { category: "read", text, path };
		// Include failed commands because cap preserves their trailing lines.
		return RTK_IN_COMMAND.test(command)
			? { category: "terminal", text, wrapped: true }
			: { category: "terminal", text };
	}
	if (event.isError) return undefined;
	if (isReadToolResult(event)) {
		return typeof event.input.path === "string"
			? { category: "read", text, path: resolvePath(event.input.path, cwd) }
			: undefined;
	}
	if (category === "read" || category === "terminal") return undefined;
	return { category, text };
}

/** Prefix tool names for RTK so they match only generic post-tool rules. */
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

/** Normalize a line using the same ANSI and carriage-return rules as RTK. */
function rendered(line: string | undefined): string | undefined {
	if (line === undefined) return undefined;
	const visible = line.replace(ANSI_ESCAPE, "");
	if (!visible.includes("\r")) return visible;
	return visible.split("\r").findLast((segment: string) => segment !== "") ?? "";
}

/** Count trailing consecutive lines matching the final non-empty line. */
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
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122) ||
		(code >= 48 && code <= 57) ||
		code === 43 ||
		code === 47 ||
		code === 61
	);
}

/** Complete a trailing base64 elision marker when cap truncated inside it. */
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

/** Check that base64 elision markers replace valid base64 runs of at least 1,024 characters. */
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

/** Check that RTK preserved the final line modulo allowed terminal and cap rewrites. */
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
		// Handle lines where base64-elide ran before cap, including mid-marker cuts.
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

/** Verify that the final status line and all full-output notices survived filtering. */
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
		.every((line: string) => !FULL_OUTPUT_NOTICE.test(line) || kept.has(line));
}

export function structureCheck(pipeline: Pipeline): StructureCheck {
	if (pipeline !== "listing") return preservesTrailer;
	return (original: string, filtered: string): boolean =>
		preservesTrailer(original, filtered) &&
		// Check FFF group boundaries when override-mode output uses native tool names.
		(!original.split("\n").some((line: string) => NUMBERED_LINE.test(line)) ||
			preservesBoundaries(original, filtered));
}

// Require a minimum absolute and relative byte reduction before replacing output.
export const MIN_SAVED_BYTES = 128;
export const MIN_SAVED_RATIO = 0.1;

/** Require replacements to save both minimum bytes and a minimum fraction of the original. */
export function worthReplacing(original: string, replacement: string): boolean {
	const before = Buffer.byteLength(original);
	const saved = before - Buffer.byteLength(replacement);
	return saved >= MIN_SAVED_BYTES && saved >= before * MIN_SAVED_RATIO;
}
