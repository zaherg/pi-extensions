import { stripJsonIndentation } from "./views.ts";

/**
 * Lossless rewrites. Each one proves itself by rebuilding the input exactly
 * from its output and returns `undefined` when it cannot.
 */

const MATCH = /^(.+?):(\d+): /;
const COMPACT = /^ (\d+)([:-]) /;

interface GrepLine {
	path: string;
	/** `:12: text` for matches, `-13- text` for context. */
	rest: string;
}

/** Context lines carry the path of the match block they belong to. */
function contextLine(line: string, path: string | undefined) {
	if (path === undefined || !line.startsWith(`${path}-`)) return undefined;
	const rest = line.slice(path.length);
	return /^-\d+- /.test(rest) ? { path, rest } : undefined;
}

function parseGrep(lines: readonly string[]): (GrepLine | undefined)[] {
	const parsed: (GrepLine | undefined)[] = lines.map((line) => {
		const path = MATCH.exec(line)?.[1];
		return path === undefined
			? undefined
			: { path, rest: line.slice(path.length) };
	});
	// Context after a match, then context before one.
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

/** Inverse of `groupGrep`; also the proof each grouping is checked against. */
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
				`${heading}${separator}${compact[1]}${separator} ${line.slice(compact[0].length)}`,
			);
		} else if (COMPACT.test(lines[index + 1] ?? "")) {
			heading = line;
		} else {
			out.push(line);
			heading = undefined;
		}
	}
	return out.join("\n");
}

/**
 * Groups Pi `grep` lines (`path:12: text`, `path-13- text`) under one
 * heading per consecutive run of a file, as FFF does. Order is unchanged.
 */
export function groupGrep(text: string): string | undefined {
	const lines = text.split("\n");
	// Already grouped (FFF registered under a native name): ungrouping would be ambiguous.
	if (lines.some((line) => COMPACT.test(line))) return undefined;
	const parsed = parseGrep(lines);
	const out: string[] = [];
	let current: string | undefined;
	for (let index = 0; index < lines.length; index++) {
		const entry = parsed[index];
		if (entry === undefined) {
			out.push(lines[index] ?? "");
			current = undefined;
			continue;
		}
		if (entry.path !== current) out.push(entry.path);
		current = entry.path;
		// `:12: text` becomes ` 12: text`; `-13- text` becomes ` 13- text`.
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

function bestSuffix(lines: readonly string[]): string | undefined {
	const counts = new Map<string, number>();
	for (const line of lines.slice(0, MAX_LINES)) {
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

/** Inverse of `factorSuffixes`; also the proof each rewrite is checked against. */
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
	// The footnote block is separated by one blank line.
	if (notes.size > 0 && lines[end - 1] === "") end--;
	return lines
		.slice(0, end)
		.map((line) => {
			const marker = / \[\^(\d+)\]$/.exec(line);
			const suffix =
				marker?.[1] === undefined ? undefined : notes.get(marker[1]);
			return suffix === undefined || !marker
				? line
				: line.slice(0, marker.index) + suffix;
		})
		.join("\n");
}

/**
 * Replaces a long tail shared by many lines (diagnostic boilerplate, for
 * example) with a Markdown footnote marker, defined once at the end.
 */
export function factorSuffixes(text: string): string | undefined {
	if (text.includes("[^")) return undefined;
	let lines = text.split("\n");
	const notes: string[] = [];
	for (let label = 1; label <= MAX_FOOTNOTES; label++) {
		const suffix = bestSuffix(lines);
		if (suffix === undefined) break;
		lines = lines.map((line) =>
			line.endsWith(suffix) && line.length > suffix.length
				? `${line.slice(0, -suffix.length)} [^${label}]`
				: line,
		);
		notes.push(`[^${label}]:${suffix}`);
	}
	if (notes.length === 0) return undefined;
	const factored = `${lines.join("\n")}\n\n${notes.join("\n")}`;
	return unfactorSuffixes(factored) === text ? factored : undefined;
}

/** Drops indentation from a complete, pretty-printed JSON document. */
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
