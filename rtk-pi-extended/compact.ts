import { stripJsonIndentation } from "./views.ts";

// Lossless rewrites that verify exact round-trip reconstruction before returning.
const MATCH = /^(.+?):(\d+):/;
const COMPACT = /^ (\d+)([:-])(.*)$/;

interface GrepLine {
	path: string;
	/** Match or context suffix such as `:12: text`, `:12:text`, or `-13-text`. */
	rest: string;
}

function isGrepPath(path: string): boolean {
	return (
		path !== "" &&
		path !== "--" &&
		// Reject bare timestamps, bracketed clock prefixes, and URL schemes.
		!/^\s|^\[?\d+$|^\d{4}-\d{2}-\d{2}[T ]\d{2}$/.test(path) &&
		!path.includes("://")
	);
}

/** Attach a grep context line to its surrounding match block path. */
function contextLine(
	line: string,
	path: string | undefined,
): GrepLine | undefined {
	if (path === undefined || !line.startsWith(`${path}-`)) return undefined;
	const rest = line.slice(path.length);
	return /^-\d+-/.test(rest) ? { path, rest } : undefined;
}

function parseGrep(lines: readonly string[]): (GrepLine | undefined)[] {
	const parsed: (GrepLine | undefined)[] = lines.map(
		(line: string): GrepLine | undefined => {
			const path = MATCH.exec(line)?.[1];
			return path !== undefined && isGrepPath(path)
				? { path, rest: line.slice(path.length) }
				: undefined;
		},
	);
	// Propagate file paths across trailing and leading context lines.
	let previous: string | undefined;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const found = parsed[index] ?? contextLine(line, previous);
		parsed[index] = found;
		previous = found?.path;
	}
	let next: string | undefined;
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index] ?? "";
		const found = parsed[index] ?? contextLine(line, next);
		parsed[index] = found;
		next = found?.path;
	}
	return parsed;
}

/** Restore full file prefixes to grouped grep lines. */
export function ungroupGrep(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let heading: string | undefined;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const compact = COMPACT.exec(line);
		if (compact && heading !== undefined) {
			const separator = compact[2] ?? ":";
			out.push(
				`${heading}${separator}${compact[1]}${separator}${compact[3] ?? ""}`,
			);
		} else if (
			line === "--" &&
			heading !== undefined &&
			COMPACT.test(lines[index + 1] ?? "")
		) {
			out.push(line);
		} else if (COMPACT.test(lines[index + 1] ?? "")) {
			heading = line;
		} else {
			out.push(line);
			heading = undefined;
		}
	}
	return out.join("\n");
}

/** Group consecutive grep lines by file path while preserving line order. */
export function groupGrep(text: string): string | undefined {
	const lines = text.split("\n");
	// Skip output that already uses grouped line prefixes.
	if (lines.some((line: string) => COMPACT.test(line))) return undefined;
	const parsed = parseGrep(lines);
	const out: string[] = [];
	let current: string | undefined;
	for (let index = 0; index < lines.length; index++) {
		const entry = parsed[index];
		if (entry === undefined) {
			const line = lines[index] ?? "";
			out.push(line);
			if (line !== "--") current = undefined;
			continue;
		}
		if (entry.path !== current) out.push(entry.path);
		current = entry.path;
		// Convert `:12:text` to ` 12:text` and `-13-text` to ` 13-text`.
		out.push(` ${entry.rest.slice(1)}`);
	}
	const grouped = out.join("\n");
	return grouped !== text && ungroupGrep(grouped) === text
		? grouped
		: undefined;
}

const MIN_SUFFIX = 40;
const MAX_SUFFIX = 400;
const MIN_REPEATS = 3;
const MAX_FOOTNOTES = 3;
const MAX_LINES = 5_000;
export interface FenceState {
	readonly char: "`" | "~";
	readonly length: number;
}

const FENCE_CANDIDATE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Advance CommonMark fenced-code state across a single line. */
export function stepFenceLine(
	line: string,
	open: FenceState | undefined,
): { next: FenceState | undefined; transition: "open" | "close" | "none" } {
	const match = FENCE_CANDIDATE.exec(line);
	const marker = match?.[1];
	const rest = match?.[2] ?? "";
	if (!marker) return { next: open, transition: "none" };
	const char: "`" | "~" = marker[0] === "~" ? "~" : "`";
	if (!open) {
		if (char === "`" && rest.includes("`")) {
			return { next: undefined, transition: "none" };
		}
		return {
			next: { char, length: marker.length },
			transition: "open",
		};
	}
	if (
		char === open.char &&
		marker.length >= open.length &&
		/^[ \t]*$/.test(rest)
	) {
		return { next: undefined, transition: "close" };
	}
	return { next: open, transition: "none" };
}

function unfencedMask(lines: readonly string[]): {
	eligible: boolean[];
	unclosed: boolean;
} {
	let open: FenceState | undefined;
	const eligible = lines.map((line: string): boolean => {
		const { next, transition } = stepFenceLine(line, open);
		open = next;
		if (transition !== "none") return false;
		return open === undefined;
	});
	return { eligible, unclosed: open !== undefined };
}

function bestSuffix(
	lines: readonly string[],
	eligible: readonly boolean[],
): string | undefined {
	const counts = new Map<string, number>();
	const limit = Math.min(lines.length, MAX_LINES);
	for (let row = 0; row < limit; row++) {
		if (!eligible[row]) continue;
		const line = lines[row] ?? "";
		const seen = new Set<string>();
		const from = Math.max(1, line.length - MAX_SUFFIX);
		for (
			let index = line.indexOf(" ", from);
			index >= 0;
			index = line.indexOf(" ", index + 1)
		) {
			if (line.length - index < MIN_SUFFIX) break;
			const suffix = line.slice(index);
			if (seen.has(suffix)) continue;
			seen.add(suffix);
			counts.set(suffix, (counts.get(suffix) ?? 0) + 1);
		}
	}
	let best: string | undefined;
	let bestGain = 0;
	for (const [suffix, count] of counts) {
		const gain = (count - 1) * suffix.length - count * 6;
		if (count >= MIN_REPEATS && gain > bestGain) {
			best = suffix;
			bestGain = gain;
		}
	}
	return best;
}

/** Expand factored Markdown suffix footnotes back into each line. */
export function unfactorSuffixes(text: string): string {
	const lines = text.split("\n");
	const notes = new Map<string, string>();
	let end = lines.length;
	while (end > 0) {
		const note = /^\[\^(\d+)\]:( .*)$/.exec(lines[end - 1] ?? "");
		if (!note?.[1] || note[2] === undefined) break;
		notes.set(note[1], note[2]);
		end--;
	}
	// Strip the blank line separating the footnote definitions.
	if (notes.size > 0 && lines[end - 1] === "") end--;
	return lines
		.slice(0, end)
		.map((line: string): string => {
			const marker = / \[\^(\d+)\]$/.exec(line);
			const suffix =
				marker?.[1] === undefined ? undefined : notes.get(marker[1]);
			return suffix === undefined || !marker
				? line
				: line.slice(0, marker.index) + suffix;
		})
		.join("\n");
}

/** Replace repeated long line suffixes outside fenced code blocks with trailing Markdown footnotes. */
export function factorSuffixes(text: string): string | undefined {
	if (text.includes("[^")) return undefined;
	let lines = text.split("\n");
	const { eligible, unclosed } = unfencedMask(lines);
	if (unclosed) return undefined;
	const notes: string[] = [];
	for (let label = 1; label <= MAX_FOOTNOTES; label++) {
		const suffix = bestSuffix(lines, eligible);
		if (suffix === undefined) break;
		lines = lines.map((line: string, index: number): string =>
			eligible[index] && line.endsWith(suffix) && line.length > suffix.length
				? `${line.slice(0, -suffix.length)} [^${label}]`
				: line,
		);
		notes.push(`[^${label}]:${suffix}`);
	}
	if (notes.length === 0) return undefined;
	const factored = `${lines.join("\n")}\n\n${notes.join("\n")}`;
	return unfactorSuffixes(factored) === text ? factored : undefined;
}

/** Strip leading indentation from a complete, pretty-printed JSON document. */
export function compactJsonDocument(text: string): string | undefined {
	const trimmed = text.trim();
	if (!/^[[{]/.test(trimmed) || !text.includes("\n")) return undefined;
	try {
		JSON.parse(text);
	} catch {
		return undefined;
	}
	const compact = stripJsonIndentation(text);
	return compact === text ? undefined : compact;
}
