import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { ReadView } from "./views.ts";

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

/** Verbatim read results delivered in the current session. */
export class ReadIndex {
	readonly #sources: ReadSource[] = [];
	/** Start lines per path whose last delivery was a stub or condensed view. */
	readonly #replaced = new Map<string, Set<number>>();
	#chars = 0;

	/** Record a verbatim read and clear any forced re-read marker for its range. */
	record(path: string, toolCallId: string, view: ReadView): void {
		const replaced = this.#replaced.get(path);
		replaced?.delete(view.start);
		replaced?.delete(ANY_START);
		if (replaced?.size === 0) this.#replaced.delete(path);
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
		return found.sort((a: Overlap, b: Overlap) => b.to - b.from - (a.to - a.from));
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

function digest(tool: string, passage: string): string {
	return createHash("sha256")
		.update(tool)
		.update("\0")
		.update(passage)
		.digest("hex");
}

export function passages(text: string): string[] {
	return text
		.split("\n\n")
		.filter((passage: string) => Buffer.byteLength(passage) >= MIN_PASSAGE_BYTES);
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
	const flush = (): void => {
		if (!pending) return;
		out.push(
			`[rtk-pi-extended: ${pending.count} passage(s), ${pending.bytes} bytes, omitted; identical text is in the ${tool} result of tool call ${pending.call} earlier in this conversation]`,
		);
		pending = undefined;
	};
	parts.forEach((part: string, position: number): void => {
		const last = position === parts.length - 1;
		const bytes = Buffer.byteLength(part);
		let call: string | undefined;
		if (!last && bytes >= MIN_PASSAGE_BYTES) {
			const candidates = index.calls(tool, part);
			const visible = context();
			// Extend the active marker when the same earlier call also contains this passage.
			if (
				pending &&
				candidates.includes(pending.call) &&
				visible.get(pending.call)?.includes(part)
			) {
				call = pending.call;
			} else {
				call = candidates.find((id: string) => visible.get(id)?.includes(part));
			}
		}
		if (call === undefined) {
			flush();
			out.push(part);
			return;
		}
		omitted++;
		if (pending && pending.call === call) {
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
