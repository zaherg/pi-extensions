import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { ReadView } from "./views.ts";

/**
 * Model-visible tool-result text by tool call ID, after compaction and
 * context edits. Deduplication only points at text found here, so
 * compaction, branch changes, and pruning invalidate it automatically.
 */
export type ContextResults = ReadonlyMap<string, string>;

export interface ReadSource {
	path: string;
	toolCallId: string;
	start: number;
	lines: string[];
	body: string;
}

/** File lines `from`-`to` (inclusive) of a view that an earlier verbatim read shows identically. */
export interface Overlap {
	source: ReadSource;
	from: number;
	to: number;
}

const MAX_INDEXED_CHARS = 16 * 1024 * 1024;

/** Any start line: a Bash file view is followed by `read` at an arbitrary offset. */
export const ANY_START = 0;

/** Shared line range of a source and a view, if every shared line is identical. */
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

/** Verbatim `read` results this extension delivered in the current session. */
export class ReadIndex {
	readonly #sources: ReadSource[] = [];
	/** Start lines per path whose last delivery was a stub or condensed view. */
	readonly #replaced = new Map<string, Set<number>>();
	#chars = 0;

	/** Record a verbatim delivery; it ends the forced re-read it satisfied. */
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

	/** The last delivery from `start` (or `ANY_START`) was a stub or condensed view. */
	markReplaced(path: string, start: number): void {
		const replaced = this.#replaced.get(path) ?? new Set<number>();
		replaced.add(start);
		this.#replaced.set(path, replaced);
	}

	/** Reading a replaced range again returns the exact text. */
	forcesFull(path: string, start: number): boolean {
		const replaced = this.#replaced.get(path);
		return (
			replaced !== undefined && (replaced.has(start) || replaced.has(ANY_START))
		);
	}

	/**
	 * Earlier verbatim reads of `path` whose lines shared with `view` are all
	 * identical, largest overlap first and newest first among equals.
	 */
	overlaps(path: string, view: ReadView): Overlap[] {
		const found: Overlap[] = [];
		for (let index = this.#sources.length - 1; index >= 0; index--) {
			const source = this.#sources[index];
			const shared = source?.path === path ? overlap(source, view) : undefined;
			if (shared) found.push(shared);
		}
		// `sort` is stable, so equal overlaps stay newest first.
		return found.sort((a, b) => b.to - b.from - (a.to - a.from));
	}

	/** Forget a path after `edit` or `write` changed it. */
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

/** Passages shorter than this are never replaced: the stub would barely save anything. */
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
		.filter((passage) => Buffer.byteLength(passage) >= MIN_PASSAGE_BYTES);
}

/** Long passages each tool delivered verbatim, by content hash. */
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
		// Maps iterate in insertion order, so the first key is the stalest.
		while (this.#calls.size > MAX_PASSAGES) {
			const oldest = this.#calls.keys().next().value;
			if (oldest === undefined) break;
			this.#calls.delete(oldest);
		}
	}

	/** Earlier calls of `tool` that delivered this exact passage, newest first. */
	calls(tool: string, passage: string): readonly string[] {
		return (this.#calls.get(digest(tool, passage)) ?? []).toReversed();
	}

	clear(): void {
		this.#calls.clear();
	}
}

/**
 * Replace long passages that an earlier result of the same tool still shows
 * the model. The final passage is kept so status lines and notices survive.
 */
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
	const flush = () => {
		if (!pending) return;
		out.push(
			`[rtk-pi-extended: ${pending.count} passage(s), ${pending.bytes} bytes, omitted; identical text is in the ${tool} result of tool call ${pending.call} earlier in this conversation]`,
		);
		pending = undefined;
	};
	parts.forEach((part, position) => {
		const last = position === parts.length - 1;
		const bytes = Buffer.byteLength(part);
		let call: string | undefined;
		if (!last && bytes >= MIN_PASSAGE_BYTES) {
			const candidates = index.calls(tool, part);
			const visible = context();
			// Prefer extending the active marker when the same earlier call also contains this passage.
			if (
				pending &&
				candidates.includes(pending.call) &&
				visible.get(pending.call)?.includes(part)
			) {
				call = pending.call;
			} else {
				call = candidates.find((id) => visible.get(id)?.includes(part));
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
