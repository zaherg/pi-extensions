import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { type FenceState, stepFenceLine } from "./compact.ts";
import { type ReadView, resolvePath } from "./views.ts";

/** Model-visible tool result text keyed by tool call ID after compaction and context edits. */
export type ContextResults = ReadonlyMap<string, string>;

export interface ReadSource {
	path: string;
	toolCallId: string;
	start: number;
	lines: string[];
	body: string;
}

/** Inclusive file line range shared identically with an earlier verbatim read. */
export interface Overlap {
	source: ReadSource;
	from: number;
	to: number;
}

const MAX_INDEXED_CHARS = 16 * 1024 * 1024;

/** Sentinel start line matching reads at any offset after a Bash file view. */
export const ANY_START = 0;

/** Return the shared line range of a source and view when every overlapping line matches. */
function overlap(source: ReadSource, view: ReadView): Overlap | undefined {
	const from = Math.max(source.start, view.start);
	const to =
		Math.min(
			source.start + source.lines.length,
			view.start + view.lines.length,
		) - 1;
	if (to < from) return undefined;
	for (let line = from; line <= to; line++) {
		if (source.lines[line - source.start] !== view.lines[line - view.start])
			return undefined;
	}
	return { source, from, to };
}

function conflictsWith(source: ReadSource, view: ReadView): boolean {
	const from = Math.max(source.start, view.start);
	const to =
		Math.min(
			source.start + source.lines.length,
			view.start + view.lines.length,
		) - 1;
	return to >= from && overlap(source, view) === undefined;
}

/** Verbatim read results delivered in the current session. */
export class ReadIndex {
	readonly #sources: ReadSource[] = [];
	/** Start lines per path whose last delivery was a stub or condensed view. */
	readonly #replaced = new Map<string, Set<number>>();
	#chars = 0;

	/** Evict earlier reads of path whose overlapping lines changed outside edit/write. */
	evictConflicts(path: string, view: ReadView): void {
		for (let index = this.#sources.length - 1; index >= 0; index--) {
			const source = this.#sources[index];
			if (source?.path !== path || !conflictsWith(source, view)) continue;
			this.#chars -= source.body.length;
			this.#sources.splice(index, 1);
		}
	}

	/** Record a verbatim read and clear any forced re-read marker for its range. */
	record(
		path: string,
		toolCallId: string,
		view: ReadView,
		requestedStart?: number,
	): void {
		this.evictConflicts(path, view);
		const replaced = this.#replaced.get(path);
		if (replaced) {
			const end = view.start + view.lines.length - 1;
			replaced.delete(view.start);
			replaced.delete(ANY_START);
			if (requestedStart !== undefined) replaced.delete(requestedStart);
			for (const start of replaced) {
				if (start >= view.start && start <= end) replaced.delete(start);
			}
			if (replaced.size === 0) this.#replaced.delete(path);
		}
		this.#sources.push({
			path,
			toolCallId,
			start: view.start,
			lines: view.lines,
			body: view.body,
		});
		this.#chars += view.body.length;
		while (this.#chars > MAX_INDEXED_CHARS && this.#sources.length > 0) {
			this.#chars -= this.#sources.shift()?.body.length ?? 0;
		}
	}

	/** Evict earlier reads extending past eofLine when a read reached end-of-file. */
	truncate(path: string, eofLine: number): void {
		for (let index = this.#sources.length - 1; index >= 0; index--) {
			const source = this.#sources[index];
			if (
				source?.path !== path ||
				source.start + source.lines.length - 1 <= eofLine
			)
				continue;
			this.#chars -= source.body.length;
			this.#sources.splice(index, 1);
		}
	}

	/** Mark the last delivery from start (or ANY_START) as a stub or condensed view. */
	markReplaced(path: string, start: number): void {
		const replaced = this.#replaced.get(path) ?? new Set<number>();
		replaced.add(start);
		this.#replaced.set(path, replaced);
	}

	/** Return true when re-reading this range must deliver the exact text. */
	forcesFull(path: string, start: number): boolean {
		const replaced = this.#replaced.get(path);
		return (
			replaced !== undefined && (replaced.has(start) || replaced.has(ANY_START))
		);
	}

	/** Return earlier verbatim reads overlapping view identically, ordered by size then recency. */
	overlaps(path: string, view: ReadView): Overlap[] {
		const found: Overlap[] = [];
		for (let index = this.#sources.length - 1; index >= 0; index--) {
			const source = this.#sources[index];
			const shared = source?.path === path ? overlap(source, view) : undefined;
			if (shared) found.push(shared);
		}
		// Rely on stable sort so equal-length overlaps stay newest first.
		return found.sort(
			(a: Overlap, b: Overlap) => b.to - b.from - (a.to - a.from),
		);
	}

	/** Forget cached reads for a path after edit or write modifies it. */
	invalidate(path: string): void {
		this.#replaced.delete(path);
		for (let index = this.#sources.length - 1; index >= 0; index--) {
			const source = this.#sources[index];
			if (source?.path !== path) continue;
			this.#chars -= source.body.length;
			this.#sources.splice(index, 1);
		}
	}

	clear(): void {
		this.#sources.length = 0;
		this.#replaced.clear();
		this.#chars = 0;
	}
}

/** Minimum byte length required before a passage can be deduplicated. */
export const MIN_PASSAGE_BYTES = 256;
const MAX_PASSAGES = 50_000;
const FILE_HEADING = /^\*\*`([^`\n]+)`\*\*/;
const NUMBERED_EXCERPT_LINE = /^(\d+)\t(.*)$/;

interface FenceTransition {
	index: number;
	kind: "open" | "close";
}

interface InspectedPart {
	lead: string;
	core: string;
	tail: string;
	balanced: boolean;
	openAfter: FenceState | undefined;
	coreInFence: boolean;
}

/** Track CommonMark fence state across a paragraph and detach outer fences so omission preserves balance. */
function inspectPartFences(
	part: string,
	openBefore: FenceState | undefined,
): InspectedPart {
	const lines = part.split("\n");
	let open = openBefore;
	const transitions: FenceTransition[] = [];
	for (let index = 0; index < lines.length; index++) {
		const { next, transition } = stepFenceLine(lines[index] ?? "", open);
		open = next;
		if (transition !== "none") {
			transitions.push({ index, kind: transition });
		}
	}
	if (transitions.length === 0) {
		return {
			lead: "",
			core: part,
			tail: "",
			balanced: true,
			openAfter: open,
			coreInFence: openBefore !== undefined,
		};
	}
	if (
		openBefore === undefined &&
		transitions.length === 1 &&
		transitions[0]?.kind === "open" &&
		transitions[0].index === 0 &&
		lines.length >= 2
	) {
		return {
			lead: `${lines[0] ?? ""}\n`,
			core: lines.slice(1).join("\n"),
			tail: "",
			balanced: true,
			openAfter: open,
			coreInFence: true,
		};
	}
	if (
		openBefore !== undefined &&
		transitions.length === 1 &&
		transitions[0]?.kind === "close" &&
		transitions[0].index === lines.length - 1 &&
		lines.length >= 2
	) {
		return {
			lead: "",
			core: lines.slice(0, -1).join("\n"),
			tail: `\n${lines[lines.length - 1] ?? ""}`,
			balanced: true,
			openAfter: open,
			coreInFence: true,
		};
	}
	if (
		openBefore === undefined &&
		transitions.length === 2 &&
		transitions[0]?.kind === "open" &&
		transitions[0].index === 0 &&
		transitions[1]?.kind === "close" &&
		transitions[1].index === lines.length - 1 &&
		lines.length >= 3
	) {
		return {
			lead: `${lines[0] ?? ""}\n`,
			core: lines.slice(1, -1).join("\n"),
			tail: `\n${lines[lines.length - 1] ?? ""}`,
			balanced: true,
			openAfter: open,
			coreInFence: true,
		};
	}
	if (
		openBefore === undefined &&
		open === undefined &&
		transitions.length >= 2
	) {
		return {
			lead: "",
			core: part,
			tail: "",
			balanced: true,
			openAfter: open,
			coreInFence: false,
		};
	}
	return {
		lead: "",
		core: part,
		tail: "",
		balanced: false,
		openAfter: open,
		coreInFence: false,
	};
}

function digest(tool: string, passage: string): string {
	return createHash("sha256")
		.update(tool)
		.update("\0")
		.update(passage)
		.digest("hex");
}

export function passages(text: string): string[] {
	const found: string[] = [];
	let openFence: FenceState | undefined;
	for (const part of text.split("\n\n")) {
		const { core, balanced, openAfter } = inspectPartFences(part, openFence);
		openFence = openAfter;
		if (balanced && Buffer.byteLength(core) >= MIN_PASSAGE_BYTES)
			found.push(core);
	}
	return found;
}

/** Long passages delivered verbatim by each tool, indexed by content hash. */
export class PassageIndex {
	readonly #calls = new Map<string, string[]>();

	record(tool: string, toolCallId: string, text: string): void {
		for (const passage of passages(text)) {
			const key = digest(tool, passage);
			const calls = this.#calls.get(key) ?? [];
			if (!calls.includes(toolCallId)) calls.push(toolCallId);
			this.#calls.delete(key);
			this.#calls.set(key, calls);
		}
		// Evict the oldest key first using Map insertion order.
		while (this.#calls.size > MAX_PASSAGES) {
			const oldest = this.#calls.keys().next().value;
			if (oldest === undefined) break;
			this.#calls.delete(oldest);
		}
	}

	/** Return earlier calls of tool that delivered this exact passage, newest first. */
	calls(tool: string, passage: string): readonly string[] {
		return (this.#calls.get(digest(tool, passage)) ?? []).toReversed();
	}

	clear(): void {
		this.#calls.clear();
	}
}

/** Replace repeated non-final passages still visible in earlier results of the same tool. */
export function dedupPassages(
	tool: string,
	text: string,
	index: PassageIndex,
	context: () => ContextResults,
): { text: string; omitted: number } {
	const parts = text.split("\n\n");
	const out: string[] = [];
	let omitted = 0;
	let pending: { count: number; bytes: number; call: string } | undefined;
	const marker = (count: number, bytes: number, call: string): string =>
		`[rtk-pi-extended: ${count} passage(s), ${bytes} bytes, omitted; identical text is in the ${tool} result of tool call ${call} earlier in this conversation]`;
	const flush = (): void => {
		if (!pending) return;
		out.push(marker(pending.count, pending.bytes, pending.call));
		pending = undefined;
	};
	let openFence: FenceState | undefined;
	parts.forEach((part: string, position: number): void => {
		const last = position === parts.length - 1;
		const { lead, core, tail, balanced, openAfter, coreInFence } =
			inspectPartFences(part, openFence);
		openFence = openAfter;
		const bytes = Buffer.byteLength(core);
		let call: string | undefined;
		if (!last && balanced && bytes >= MIN_PASSAGE_BYTES) {
			const candidates = index.calls(tool, core);
			const visible = context();
			// Extend the active marker when the same earlier call also contains this passage.
			if (
				pending &&
				!coreInFence &&
				lead === "" &&
				tail === "" &&
				candidates.includes(pending.call) &&
				visible.get(pending.call)?.includes(core)
			) {
				call = pending.call;
			} else {
				call = candidates.find((id: string) => visible.get(id)?.includes(core));
			}
		}
		if (call === undefined) {
			flush();
			out.push(part);
			return;
		}
		omitted++;
		if (coreInFence || lead !== "" || tail !== "") {
			flush();
			out.push(`${lead}${marker(1, bytes, call)}${tail}`);
		} else if (pending && pending.call === call) {
			pending.count++;
			pending.bytes += bytes;
		} else {
			flush();
			pending = { count: 1, bytes, call };
		}
	});
	flush();
	return { text: out.join("\n\n"), omitted };
}

function parseNumberedExcerpt(core: string): ReadView | undefined {
	const rawLines = core.split("\n");
	const lines: string[] = [];
	let start = 0;
	for (let index = 0; index < rawLines.length; index++) {
		const match = NUMBERED_EXCERPT_LINE.exec(rawLines[index] ?? "");
		if (!match?.[1] || match[2] === undefined) return undefined;
		const lineNumber = Number(match[1]);
		if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return undefined;
		if (index === 0) start = lineNumber;
		else if (lineNumber !== start + index) return undefined;
		lines.push(match[2]);
	}
	return lines.length === 0
		? undefined
		: { start, lines, body: lines.join("\n") };
}

/** Replace numbered fenced file hunks already present verbatim in an earlier visible read. */
export function dedupReadExcerpts(
	text: string,
	cwd: string,
	reads: ReadIndex,
	context: () => ContextResults,
): { text: string; omitted: number } {
	const parts = text.split("\n\n");
	const out: string[] = [];
	let omitted = 0;
	let openFence: FenceState | undefined;
	let currentPath: string | undefined;
	for (const part of parts) {
		const wasInFence = openFence !== undefined;
		const { lead, core, tail, balanced, openAfter, coreInFence } =
			inspectPartFences(part, openFence);
		openFence = openAfter;
		const inFence = openFence !== undefined;
		if (!wasInFence) {
			const heading = FILE_HEADING.exec(part)?.[1];
			if (heading !== undefined) {
				currentPath = resolvePath(heading, cwd);
				out.push(part);
				continue;
			}
		}
		if (!coreInFence && !wasInFence) currentPath = undefined;
		if (
			coreInFence &&
			balanced &&
			currentPath !== undefined &&
			Buffer.byteLength(core) >= MIN_PASSAGE_BYTES
		) {
			const view = parseNumberedExcerpt(core);
			if (view) {
				const end = view.start + view.lines.length - 1;
				const visible = context();
				const shared = reads
					.overlaps(currentPath, view)
					.find(
						(candidate: Overlap) =>
							candidate.from === view.start &&
							candidate.to === end &&
							visible
								.get(candidate.source.toolCallId)
								?.includes(candidate.source.body),
					);
				if (shared) {
					omitted++;
					out.push(
						`${lead}[rtk-pi-extended: lines ${view.start}-${end} omitted; identical text is in the read result of tool call ${shared.source.toolCallId} earlier in this conversation]${tail}`,
					);
					if (wasInFence && !inFence) currentPath = undefined;
					continue;
				}
			}
		}
		out.push(part);
		if (wasInFence && !inFence) currentPath = undefined;
	}
	return { text: out.join("\n\n"), omitted };
}
