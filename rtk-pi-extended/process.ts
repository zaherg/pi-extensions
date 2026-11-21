import { Buffer } from "node:buffer";
import { relative, sep } from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { type Failure, RECALL_HINT, type Result } from "./bridge.ts";
import { compactJsonDocument, factorSuffixes, groupGrep } from "./compact.ts";
import {
	ANY_START,
	type ContextResults,
	dedupPassages,
	dedupReadExcerpts,
	type Overlap,
	type PassageIndex,
	type ReadIndex,
} from "./dedup.ts";
import { exceedsCap, type Gate } from "./gate.ts";
import type { Sample } from "./outcomes.ts";
import {
	hasRawTerminalOutput,
	type Pipeline,
	type Route,
	worthCondensing,
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

/** Minimum byte size before JSON indentation is stripped from read excerpts. */
const LARGE_JSON_BYTES = 16 * 1024;
// Preserve raw `grep -n` lines on bash so pi-lens can credit search-reads when loaded after us.
const RAW_GREP_COMMAND = /\b[ef]?grep\b/;

export type Call = Pick<ToolResultEvent, "toolName" | "toolCallId" | "input">;

export interface Dependencies {
	cwd: string;
	/** Fast pre-check returning false when a pipeline rule cannot modify text. */
	gate: Gate;
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
	/** Recoverable RTK failure recorded while keeping safe output. */
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

interface DedupStub {
	text: string;
	mechanism: string;
	complete: boolean;
}

interface RtkStepResult {
	text: string;
	mechanisms: string[];
	failure?: Failure;
}

/** Build a condensed non-code view prefixed with a warning against direct edits. */
async function condense(
	route: Route & { path: string },
	call: Call,
	view: ReadView | undefined,
	deps: Dependencies,
): Promise<Condensed | undefined> {
	// Keep Pi's read continuation or Bash truncation notice verbatim.
	const { body, trailer: notice } = view
		? { body: view.body, trailer: view.notice }
		: splitBashTrailer(route.text);
	const where = display(route.path, deps.cwd);
	const range = view
		? `lines ${view.start}-${view.start + view.lines.length - 1} of ${where}`
		: where;
	const header = (what: string): string =>
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
			// Leave small or complete JSON files intact because they are commonly read before editing.
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

/** Format a stub referencing an earlier read for shared lines while keeping unique lines verbatim. */
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

/** Build a deduplication stub pointing at an earlier model-visible read when worthwhile. */
function dedupStub(
	path: string,
	text: string,
	view: ReadView,
	deps: Dependencies,
): DedupStub | undefined {
	// Reference only earlier reads that remain visible in the projected session context.
	const shared = deps.reads
		.overlaps(path, view)
		.find(({ source }: Overlap) =>
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
	const offset =
		route.offset ??
		(typeof call.input === "object" && call.input !== null
			? (call.input as { offset?: unknown }).offset
			: undefined);
	const view =
		call.toolName === "read" ? parseReadView(text, offset) : undefined;
	if (call.toolName === "read" && !view)
		return { sample: sample(call, route, "none", text) };

	if (view && deps.reads.forcesFull(path, view.start)) {
		deps.reads.record(path, call.toolCallId, view);
		return { sample: sample(call, route, "read-forced", text) };
	}
	const stub = view ? dedupStub(path, text, view, deps) : undefined;
	let best: { text: string; mechanism: string } | undefined = stub;
	// Check whether a condensed non-code view beats a partial overlap stub.
	const condensed = stub?.complete
		? undefined
		: await condense(route, call, view, deps);
	if (
		condensed &&
		!condensed.failure &&
		worthCondensing(text, condensed.text) &&
		(best === undefined ||
			Buffer.byteLength(condensed.text) < Buffer.byteLength(best.text))
	)
		best = condensed;
	if (best) {
		// Mark ANY_START after a Bash file view so reading any range returns exact text.
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

/** Detach RTK's trailing recall hint only when RTK actually filtered the step. */
function splitRecallHint(step: RtkStepResult): { body: string; hint: string } {
	if (step.mechanisms.length === 0) return { body: step.text, hint: "" };
	const hint = RECALL_HINT.exec(step.text)?.[0] ?? "";
	return {
		body: hint ? step.text.slice(0, -hint.length) : step.text,
		hint,
	};
}

/** Run RTK before lossless rewrites so recall stores the unmodified original text. */
async function runRtkStep(
	route: Route,
	call: Call,
	pipeline: Pipeline,
	deps: Dependencies,
): Promise<RtkStepResult> {
	if (!deps.gate(pipeline, route.text))
		return { text: route.text, mechanisms: [] };
	const result = await deps.rtk(call.toolName, route.text, pipeline);
	if (result.kind === "failed")
		return {
			text: route.text,
			mechanisms: [],
			failure: result.reason,
		};
	return result.kind === "filtered"
		? { text: result.text, mechanisms: [`rtk:${pipeline}`] }
		: { text: route.text, mechanisms: [] };
}

/** Return true when a rewrite reduces UTF-8 byte length. */
function shrinks(before: string, after: string): boolean {
	return Buffer.byteLength(after) < Buffer.byteLength(before);
}

function finish(
	route: Route,
	call: Call,
	current: string,
	mechanisms: string[],
	failure?: Failure,
	defaultMechanism = "none",
): Processed {
	const mechanism = mechanisms.join("+") || defaultMechanism;
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

async function processTerminal(
	route: Route,
	call: Call,
	deps: Dependencies,
): Promise<Processed | undefined> {
	// Skip spawning RTK on wrapped commands unless raw terminal noise or >300-line output passed through.
	const allowRtk =
		!route.wrapped ||
		hasRawTerminalOutput(route.text) ||
		exceedsCap(route.text);
	const gated = allowRtk && deps.gate("terminal", route.text);
	const step: RtkStepResult = gated
		? await runRtkStep(route, call, "terminal", deps)
		: { text: route.text, mechanisms: [] };
	const mechanisms = [...step.mechanisms];
	const { body: withoutHint, hint } = splitRecallHint(step);
	const { body: initialBody, trailer } = splitBashTrailer(withoutHint);
	let body = initialBody;

	const command =
		typeof call.input === "object" && call.input !== null
			? (call.input as { command?: unknown }).command
			: undefined;
	const allowGrepGroup =
		typeof command !== "string" || !RAW_GREP_COMMAND.test(command);

	for (const [name, rewrite] of [
		["json-compact", compactJsonDocument],
		...(allowGrepGroup ? ([["grep-group", groupGrep]] as const) : []),
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

	const candidate = withNotice(body, trailer) + hint;
	const processed = finish(
		route,
		call,
		candidate,
		mechanisms,
		step.failure,
		gated ? "rtk:terminal" : "gate",
	);
	deps.passages.record(
		call.toolName,
		call.toolCallId,
		processed.text ?? route.text,
	);
	if (route.wrapped && processed.text === undefined && !processed.failure)
		return undefined;
	return processed;
}

async function processListing(
	route: Route,
	call: Call,
	deps: Dependencies,
): Promise<Processed> {
	const step = await runRtkStep(route, call, "listing", deps);
	const mechanisms = [...step.mechanisms];
	const { body: initialBody, hint } = splitRecallHint(step);
	let body = initialBody;
	if (call.toolName === "grep") {
		const grouped = groupGrep(body);
		if (grouped !== undefined && shrinks(body, grouped)) {
			body = grouped;
			mechanisms.push("grep-group");
		}
	}
	return finish(route, call, body + hint, mechanisms, step.failure);
}

async function processGeneric(
	route: Route,
	call: Call,
	deps: Dependencies,
): Promise<Processed> {
	const step = await runRtkStep(route, call, "generic", deps);
	const mechanisms = [...step.mechanisms];
	const { body: initialBody, hint } = splitRecallHint(step);
	let body = initialBody;
	const excerpts = dedupReadExcerpts(body, deps.cwd, deps.reads, deps.context);
	if (excerpts.omitted > 0) {
		body = excerpts.text;
		mechanisms.push("excerpt-dedup");
	}
	for (const [name, rewrite] of [
		["json-compact", compactJsonDocument],
		["grep-group", groupGrep],
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

/** Process one routed tool result and fall back to the original on RTK failure. */
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
