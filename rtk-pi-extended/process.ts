import { Buffer } from "node:buffer";
import { relative, sep } from "node:path";
import { type Failure, RECALL_HINT, type Result } from "./bridge.ts";
import { compactJsonDocument, factorSuffixes, groupGrep } from "./compact.ts";
import {
	ANY_START,
	type ContextResults,
	dedupPassages,
	type Overlap,
	type PassageIndex,
	type ReadIndex,
} from "./dedup.ts";
import type { Sample } from "./outcomes.ts";
import {
	hasRawTerminalOutput,
	type Pipeline,
	type Route,
	worthReplacing,
} from "./policy.ts";
import {
	fileClass,
	lockfilePackages,
	parseReadView,
	type ReadView,
	splitBashTrailer,
	stripJsonIndentation,
	truncateLongLines,
} from "./views.ts";

/** Indentation is only stripped from JSON excerpts this large; smaller files are usually edited. */
const LARGE_JSON_BYTES = 16 * 1024;

export interface Call {
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
}

export interface Dependencies {
	cwd: string;
	/** Whether the profile's RTK rule could change `text`; `false` skips the process. */
	gate: (pipeline: Pipeline, text: string) => boolean;
	/** Run RTK's post-tool pipeline for a profile. */
	rtk: (toolName: string, text: string, pipeline: Pipeline) => Promise<Result>;
	context: () => ContextResults;
	reads: ReadIndex;
	passages: PassageIndex;
}

export interface Processed {
	/** Replacement text, present only for an accepted change. */
	text?: string;
	sample: Sample;
	/** RTK failure worth reporting; the original or a lossless rewrite was kept. */
	failure?: Failure;
}

function sample(
	call: Call,
	route: Route,
	mechanism: string,
	before: string,
	after?: string,
	reason?: Failure,
): Sample {
	const bytesBefore = Buffer.byteLength(before);
	const identity = { tool: call.toolName, category: route.category, mechanism };
	if (after !== undefined)
		return {
			...identity,
			outcome: "filtered",
			bytesBefore,
			bytesAfter: Buffer.byteLength(after),
		};
	if (reason)
		return {
			...identity,
			outcome: "failed",
			reason,
			bytesBefore,
			bytesAfter: bytesBefore,
		};
	return {
		...identity,
		outcome: "unchanged",
		bytesBefore,
		bytesAfter: bytesBefore,
	};
}

function display(path: string, cwd: string): string {
	const local = relative(cwd, path);
	return local === "" || local.startsWith(`..${sep}`) || local === ".."
		? path
		: local;
}

function withNotice(text: string, notice: string | undefined): string {
	return notice === undefined ? text : `${text}\n\n${notice}`;
}

interface Condensed {
	text: string;
	mechanism: string;
	failure?: Failure;
}

/**
 * Non-code views. Every one starts with a header saying it is not the file's
 * literal text, so it cannot be mistaken for `edit` input.
 */
async function condense(
	route: Route & { path: string },
	call: Call,
	view: ReadView | undefined,
	deps: Dependencies,
): Promise<Condensed | undefined> {
	// Pi's continuation notice, or Bash's truncation notice, stays verbatim.
	const { body, trailer: notice } = view
		? { body: view.body, trailer: view.notice }
		: splitBashTrailer(route.text);
	const where = display(route.path, deps.cwd);
	const range = view
		? `lines ${view.start}-${view.start + view.lines.length - 1} of ${where}`
		: where;
	const header = (what: string) =>
		`[rtk-pi-extended] ${what} ${range}. This is not the file's literal text; do not copy it into edit. ${
			call.toolName === "read"
				? "Read the same path and offset again for the exact text."
				: "Read the file with the read tool for the exact text."
		}`;
	switch (fileClass(route.path)) {
		case "lockfile": {
			const packages = lockfilePackages(route.path, body);
			if (packages.length === 0) return undefined;
			return {
				mechanism: "lockfile-summary",
				text: withNotice(
					`${header(`Lockfile summary (${packages.length} name@version entries; hashes, URLs, and dependency maps omitted) of`)}\n${packages.join("\n")}`,
					notice,
				),
			};
		}
		case "minified":
			return {
				mechanism: "long-line-trim",
				text: withNotice(
					`${header("Lines over 300 characters trimmed in")}\n${truncateLongLines(body)}`,
					notice,
				),
			};
		case "json":
			// Whole small files are usually read in order to edit them.
			if (
				Buffer.byteLength(body) < LARGE_JSON_BYTES ||
				(view !== undefined && view.notice === undefined)
			)
				return undefined;
			return {
				mechanism: "json-indent",
				text: withNotice(
					`${header("JSON with indentation removed,")}\n${stripJsonIndentation(body)}`,
					notice,
				),
			};
		case "log": {
			if (!deps.gate("terminal", route.text)) return undefined;
			const result = await deps.rtk(call.toolName, route.text, "terminal");
			if (result.kind === "failed")
				return { mechanism: "rtk:terminal", text: "", failure: result.reason };
			if (result.kind !== "filtered") return undefined;
			return {
				mechanism: "rtk:terminal",
				text: `${header("Log condensed by RTK:")}\n${result.text}`,
			};
		}
		default:
			return undefined;
	}
}

/**
 * Points at an earlier read for the lines it shares with this view. Lines
 * outside the overlap are delivered verbatim, separated by marker lines.
 */
function readStub(view: ReadView, where: string, shared: Overlap): string {
	const end = view.start + view.lines.length - 1;
	const call = shared.source.toolCallId;
	if (shared.from === view.start && shared.to === end) {
		return withNotice(
			`[rtk-pi-extended] Unchanged: lines ${view.start}-${end} of ${where} are identical to the read result of tool call ${call}, which is still in this conversation. Use that text, including for edit. Read the same path and offset again to receive it here.`,
			view.notice,
		);
	}
	const before = view.lines.slice(0, shared.from - view.start);
	const after = view.lines.slice(shared.to - view.start + 1);
	return withNotice(
		[
			`[rtk-pi-extended] Partly unchanged: lines ${view.start}-${end} of ${where} follow, except lines ${shared.from}-${shared.to}, which are identical to the read result of tool call ${call} that is still in this conversation. All other lines are verbatim; marker lines are not file text. Read the same path and offset again to receive every line here.`,
			...before,
			`[rtk-pi-extended: lines ${shared.from}-${shared.to} omitted, see tool call ${call}]`,
			...after,
		].join("\n"),
		view.notice,
	);
}

/** A stub pointing at an earlier read the model can still see, if worth delivering. */
function dedupStub(
	path: string,
	text: string,
	view: ReadView,
	deps: Dependencies,
) {
	// Only text the model can still see is referenced; compaction and pruning drop it.
	const shared = deps.reads
		.overlaps(path, view)
		.find(({ source }) =>
			deps.context().get(source.toolCallId)?.includes(source.body),
		);
	if (!shared) return undefined;
	const stub = readStub(view, display(path, deps.cwd), shared);
	if (!worthReplacing(text, stub)) return undefined;
	const complete =
		shared.from === view.start &&
		shared.to === view.start + view.lines.length - 1;
	return { text: stub, mechanism: "read-dedup", complete };
}

async function processRead(
	route: Route & { path: string },
	call: Call,
	deps: Dependencies,
): Promise<Processed> {
	const { path, text } = route;
	const view =
		call.toolName === "read"
			? parseReadView(text, call.input.offset)
			: undefined;
	if (call.toolName === "read" && !view)
		return { sample: sample(call, route, "none", text) };

	if (view && deps.reads.forcesFull(path, view.start)) {
		deps.reads.record(path, call.toolCallId, view);
		return { sample: sample(call, route, "read-forced", text) };
	}
	const stub = view ? dedupStub(path, text, view, deps) : undefined;
	let best: { text: string; mechanism: string } | undefined = stub;
	// A partial stub still carries file lines; a non-code view of them may be smaller.
	const condensed = stub?.complete
		? undefined
		: await condense(route, call, view, deps);
	if (
		condensed &&
		!condensed.failure &&
		worthReplacing(text, condensed.text) &&
		(best === undefined ||
			Buffer.byteLength(condensed.text) < Buffer.byteLength(best.text))
	)
		best = condensed;
	if (best) {
		// After a Bash view, a read of any range of the file returns the exact text.
		deps.reads.markReplaced(path, view?.start ?? ANY_START);
		return {
			text: best.text,
			sample: sample(call, route, best.mechanism, text, best.text),
			...(condensed?.failure ? { failure: condensed.failure } : {}),
		};
	}
	if (view) deps.reads.record(path, call.toolCallId, view);
	if (condensed?.failure)
		return {
			sample: sample(
				call,
				route,
				condensed.mechanism,
				text,
				undefined,
				condensed.failure,
			),
			failure: condensed.failure,
		};
	return { sample: sample(call, route, condensed?.mechanism ?? "none", text) };
}

async function processTerminal(
	route: Route,
	call: Call,
	deps: Dependencies,
): Promise<Processed | undefined> {
	const { text } = route;
	if (route.wrapped && !hasRawTerminalOutput(text)) return undefined;
	if (!deps.gate("terminal", text))
		return { sample: sample(call, route, "gate", text) };
	const result = await deps.rtk(call.toolName, text, "terminal");
	if (result.kind === "failed")
		return {
			sample: sample(
				call,
				route,
				"rtk:terminal",
				text,
				undefined,
				result.reason,
			),
			failure: result.reason,
		};
	if (result.kind === "filtered" && worthReplacing(text, result.text))
		return {
			text: result.text,
			sample: sample(call, route, "rtk:terminal", text, result.text),
		};
	return { sample: sample(call, route, "rtk:terminal", text) };
}

/** RTK runs first so its recall stores the true original; lossless rewrites follow. */
async function runRtkStep(
	route: Route,
	call: Call,
	pipeline: Pipeline,
	deps: Dependencies,
) {
	if (!deps.gate(pipeline, route.text))
		return { text: route.text, mechanisms: [] as string[] };
	const result = await deps.rtk(call.toolName, route.text, pipeline);
	if (result.kind === "failed")
		return {
			text: route.text,
			mechanisms: [] as string[],
			failure: result.reason,
		};
	return result.kind === "filtered"
		? { text: result.text, mechanisms: [`rtk:${pipeline}`] }
		: { text: route.text, mechanisms: [] as string[] };
}

/** Each lossless step must pay for itself; the whole result is then held to `worthReplacing`. */
function shrinks(before: string, after: string): boolean {
	return Buffer.byteLength(after) < Buffer.byteLength(before);
}

function finish(
	route: Route,
	call: Call,
	current: string,
	mechanisms: string[],
	failure?: Failure,
): Processed {
	const mechanism = mechanisms.join("+") || "none";
	if (current !== route.text && worthReplacing(route.text, current))
		return {
			text: current,
			sample: sample(call, route, mechanism, route.text, current),
			...(failure ? { failure } : {}),
		};
	return {
		sample: sample(
			call,
			route,
			mechanism === "none" && failure ? `rtk:${route.category}` : mechanism,
			route.text,
			undefined,
			failure,
		),
		...(failure ? { failure } : {}),
	};
}

async function processListing(
	route: Route,
	call: Call,
	deps: Dependencies,
): Promise<Processed> {
	const step = await runRtkStep(route, call, "listing", deps);
	let current = step.text;
	const mechanisms = [...step.mechanisms];
	if (call.toolName === "grep") {
		const grouped = groupGrep(current);
		if (grouped !== undefined && shrinks(current, grouped)) {
			current = grouped;
			mechanisms.push("grep-group");
		}
	}
	return finish(route, call, current, mechanisms, step.failure);
}

async function processGeneric(
	route: Route,
	call: Call,
	deps: Dependencies,
): Promise<Processed> {
	const step = await runRtkStep(route, call, "generic", deps);
	const mechanisms = [...step.mechanisms];
	// Keep RTK's recall hint as the final line.
	const hint = RECALL_HINT.exec(step.text)?.[0] ?? "";
	let body = hint ? step.text.slice(0, -hint.length) : step.text;
	for (const [name, rewrite] of [
		["json-compact", compactJsonDocument],
		["suffix-factor", factorSuffixes],
	] as const) {
		const rewritten = rewrite(body);
		if (rewritten !== undefined && shrinks(body, rewritten)) {
			body = rewritten;
			mechanisms.push(name);
		}
	}
	const deduped = dedupPassages(
		call.toolName,
		body,
		deps.passages,
		deps.context,
	);
	if (deduped.omitted > 0) {
		body = deduped.text;
		mechanisms.push("passage-dedup");
	}
	const processed = finish(route, call, body + hint, mechanisms, step.failure);
	deps.passages.record(
		call.toolName,
		call.toolCallId,
		processed.text ?? route.text,
	);
	return processed;
}

/** Decide one routed result. Never throws for RTK failures; those keep the original. */
export async function processRoute(
	route: Route,
	call: Call,
	deps: Dependencies,
): Promise<Processed | undefined> {
	switch (route.category) {
		case "read":
			return route.path === undefined
				? undefined
				: processRead({ ...route, path: route.path }, call, deps);
		case "terminal":
			return processTerminal(route, call, deps);
		case "listing":
			return processListing(route, call, deps);
		case "generic":
			return processGeneric(route, call, deps);
	}
}
