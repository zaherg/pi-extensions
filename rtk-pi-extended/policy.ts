import { Buffer } from "node:buffer";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
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
// Leave rtk recall output untouched so stored originals reach the model verbatim.
const RTK_RECALL = /(?:^|[|&;(\s])(?:\S*\/)?rtk\s+recall\b/;
const SHELL_SETUP = new Set([
	"cd",
	"set",
	"export",
	"unset",
	"umask",
	"pushd",
	"popd",
	"shopt",
	"source",
	".",
	"trap",
	"true",
	":",
]);
const SHELL_PREFIX = new Set([
	"env",
	"time",
	"command",
	"exec",
	"nohup",
	"nice",
]);
// Match pi-lens's read-widening banner prepended ahead of the file body block.
const PI_LENS_WIDENED =
	/^\[pi-lens: read widened [\s\S]*?\bthis shows lines (\d+)-\d+\b/;
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
// Match one or more adjacent raw or data-URL base64 elision markers emitted by RTK.
const BASE64_ELIDED =
	/(?:\[base64 (?:data|[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+), [^\]]+ elided\])+/g;
const BASE64_MARKER_OPEN = "[base64 ";
const DATA_URL_HEADER = /^data:[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+;base64,/;
const MIN_BASE64_RUN = 1_024;

export interface Route {
	category: Category;
	text: string;
	/** Absolute path of a file read or a single-file Bash print command. */
	path?: string;
	/** 1-based starting line parsed from a read-widening banner when present. */
	offset?: number;
	/** Content block index replaced on multi-block read results. */
	blockIndex?: number;
	/** True when every active Bash command segment invoked rtk directly. */
	wrapped?: boolean;
}

function textBlocks(
	content: readonly (TextContent | ImageContent)[],
): string[] | undefined {
	if (content.length === 0) return undefined;
	const texts: string[] = [];
	for (const block of content) {
		if (block.type !== "text" || typeof block.text !== "string")
			return undefined;
		texts.push(block.text);
	}
	return texts;
}

function sanitizeShell(command: string): string {
	return command
		.replace(/\\\r?\n/g, " ")
		.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");
}

/** Return true when every non-setup shell segment runs through an rtk filter subcommand. */
export function isRtkWrapped(command: string): boolean {
	const sanitized = sanitizeShell(command);
	let active = 0;
	for (const segment of sanitized.split(/(?:&&|\|\||;|\||\n)+/)) {
		const words = segment.match(/[^\s()]+/g) ?? [];
		let index = 0;
		while (index < words.length) {
			const word = words[index] ?? "";
			if (word.includes("=")) {
				index++;
				continue;
			}
			const base = word.slice(word.lastIndexOf("/") + 1);
			if (SHELL_PREFIX.has(base)) {
				index++;
				while ((words[index] ?? "").startsWith("-")) {
					const flag = words[index] ?? "";
					index++;
					if (flag === "--") break;
				}
				continue;
			}
			break;
		}
		const program = words[index];
		if (program === undefined || program === "''") continue;
		const name = program.slice(program.lastIndexOf("/") + 1);
		if (SHELL_SETUP.has(name)) continue;
		active++;
		if (name !== "rtk") return false;
		const subcommand = words
			.slice(index + 1)
			.find((token: string) => !token.startsWith("-"));
		// `rtk read` prints raw file contents without terminal filtering.
		if (subcommand === undefined || subcommand === "read") return false;
	}
	return active > 0;
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
	const blocks = textBlocks(event.content);
	if (!blocks) return undefined;

	if (event.toolName === "read") {
		if (event.isError || typeof event.input.path !== "string") return undefined;
		const path = resolvePath(event.input.path, cwd);
		if (blocks.length === 1) {
			const text = blocks[0] ?? "";
			return Buffer.byteLength(text) >= MIN_BYTES
				? { category: "read", text, path }
				: undefined;
		}
		if (blocks.length === 2) {
			const banner = blocks[0] ?? "";
			const text = blocks[1] ?? "";
			const widened = PI_LENS_WIDENED.exec(banner)?.[1];
			if (widened === undefined || Buffer.byteLength(text) < MIN_BYTES)
				return undefined;
			const offset = Number(widened);
			return {
				category: "read",
				text,
				path,
				blockIndex: 1,
				...(Number.isSafeInteger(offset) && offset > 0 ? { offset } : {}),
			};
		}
		return undefined;
	}

	const text = blocks.join("\n");
	if (Buffer.byteLength(text) < MIN_BYTES) return undefined;

	if (event.toolName === "bash") {
		const command = event.input.command;
		if (typeof command !== "string" || RTK_RECALL.test(sanitizeShell(command)))
			return undefined;
		const path =
			!event.isError && blocks.length === 1
				? bashFileView(command, cwd)
				: undefined;
		if (path !== undefined) return { category: "read", text, path };
		// Include failed commands because cap preserves their trailing lines.
		return isRtkWrapped(command)
			? { category: "terminal", text, wrapped: true }
			: { category: "terminal", text };
	}
	if (event.isError || category === "read" || category === "terminal")
		return undefined;
	return { category, text };
}

/** Prefix tool names for RTK so they match only generic post-tool rules. */
export function rtkToolName(toolName: string): string {
	return `pi-${toolName}`;
}

/** Normalize a line using the same ANSI and carriage-return rules as RTK. */
function rendered(line: string | undefined): string | undefined {
	if (line === undefined) return undefined;
	const visible = line.replace(ANSI_ESCAPE, "");
	if (!visible.includes("\r")) return visible;
	return (
		visible.split("\r").findLast((segment: string) => segment !== "") ?? ""
	);
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
		// Skip lines whose visible text is empty once terminal escapes and CR resets are stripped.
		if ((rendered(line) ?? "").trim() !== "") found.push(line);
	}
	return found;
}

/** Count trailing consecutive lines matching the final non-empty visible line. */
function trailingRepeatCount(text: string): number {
	const lines = text.split("\n");
	let index = lines.length - 1;
	while (index >= 0 && (rendered(lines[index]) ?? "").trim() === "") index--;
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

/** Advance across one or more adjacent raw or data-URL base64 runs of at least 1,024 chars. */
function consumeBase64Span(
	text: string,
	from: number,
): { minEnd: number; spanEnd: number } | undefined {
	let cursor = from;
	let minEnd = -1;
	while (cursor < text.length) {
		const header = DATA_URL_HEADER.exec(text.slice(cursor))?.[0];
		const runStart = cursor + (header?.length ?? 0);
		let end = runStart;
		while (end < text.length && isBase64Code(text.charCodeAt(end))) end++;
		if (end - runStart < MIN_BASE64_RUN) {
			return minEnd < 0 ? undefined : { minEnd, spanEnd: cursor };
		}
		if (minEnd < 0) minEnd = runStart + MIN_BASE64_RUN;
		// Step into an adjacent `data:...;base64,` URI whose leading `data` was scanned as base64.
		if (
			text.charCodeAt(end) === 58 &&
			end - 4 >= runStart + MIN_BASE64_RUN &&
			DATA_URL_HEADER.test(text.slice(end - 4))
		) {
			cursor = end - 4;
			continue;
		}
		cursor = end;
		if (!DATA_URL_HEADER.test(text.slice(cursor))) {
			return { minEnd, spanEnd: cursor };
		}
	}
	return minEnd < 0 ? undefined : { minEnd, spanEnd: cursor };
}

/** Complete a trailing base64 elision marker when cap truncated inside it. */
function withCompleteTrailingBase64Marker(prefix: string): string | undefined {
	const open = prefix.lastIndexOf("[");
	if (open < 0 || prefix.indexOf("]", open) >= 0) return undefined;
	const tail = prefix.slice(open);
	if (
		tail.startsWith(BASE64_MARKER_OPEN) ||
		BASE64_MARKER_OPEN.startsWith(tail)
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
		const span = consumeBase64Span(original, pos);
		if (!span) return false;
		const { minEnd, spanEnd } = span;
		const literal = parts[index] ?? "";
		const isLast = index === parts.length - 1;
		if (isLast && !prefixOnly) {
			const end = original.length - literal.length;
			return end >= minEnd && end <= spanEnd && original.endsWith(literal);
		}
		if (isLast && prefixOnly) {
			if (literal === "") return true;
			const next = original.indexOf(literal, minEnd);
			return (
				next >= 0 && next <= spanEnd && next + literal.length < original.length
			);
		}
		const next = original.indexOf(literal, minEnd);
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

// Require a minimum byte reduction on all rewrites, plus a 10% floor on lossy file summaries.
export const MIN_SAVED_BYTES = 128;
export const MIN_SAVED_RATIO = 0.1;

/** Require lossless, dedup, and RTK replacements to save at least MIN_SAVED_BYTES. */
export function worthReplacing(original: string, replacement: string): boolean {
	return (
		Buffer.byteLength(original) - Buffer.byteLength(replacement) >=
		MIN_SAVED_BYTES
	);
}

/** Require lossy non-code file summaries to save both MIN_SAVED_BYTES and MIN_SAVED_RATIO. */
export function worthCondensing(
	original: string,
	replacement: string,
): boolean {
	const before = Buffer.byteLength(original);
	const saved = before - Buffer.byteLength(replacement);
	return saved >= MIN_SAVED_BYTES && saved >= before * MIN_SAVED_RATIO;
}
