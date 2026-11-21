import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionUIContext,
	isEditToolResult,
	isWriteToolResult,
	type ToolResultEvent,
	type ToolResultEventResult,
	type TurnEndEvent,
	type TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";
import { resolveExecutable } from "../shared/executable.ts";
import { type Failure, filterPosthook, type Result } from "./bridge.ts";
import {
	classifyBash,
	formatReport,
	parseCoverageArgs,
	scanSessions,
	sessionFiles,
	windowStart,
} from "./coverage.ts";
import { type ContextResults, PassageIndex, ReadIndex } from "./dedup.ts";
import { createGate } from "./gate.ts";
import { ENTRY_TYPE, Ledger } from "./outcomes.ts";
import { type Pipeline, rtkToolName, select, structureCheck } from "./policy.ts";
import { type Dependencies, type Processed, processRoute } from "./process.ts";
import { resolvePath } from "./views.ts";

const REWRITE_TIMEOUT_MS = 2_000;

const FAILURE_MESSAGES: Record<Failure, string> = {
	unavailable: "rtk was not found in PATH",
	process: "the RTK process failed",
	timeout: "RTK exceeded the two-second process timeout",
	aborted: "filtering was cancelled",
	"input-limit": "the input exceeded the two-MiB limit",
	"output-limit": "RTK exceeded the two-MiB output limit",
	protocol: "RTK returned an unsupported response",
	boundaries:
		"a file heading, Pi notice, or final status line could not be verified",
	recovery: "the original output could not be verified through RTK recall",
	unexpected: "an unexpected adapter error occurred",
};

type NotifyLevel = NonNullable<Parameters<ExtensionUIContext["notify"]>[1]>;

function show(ctx: ExtensionContext, message: string, level: NotifyLevel): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	// Write diagnostics to stderr so JSON or RPC stdout streams stay clean.
	else process.stderr.write(`${message}\n`);
}

function textOf(content: readonly (TextContent | ImageContent)[]): string {
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block: TextContent) => block.text)
		.join("\n");
}

export default function rtkPiExtended(pi: ExtensionAPI): void {
	const pipelines = join(dirname(fileURLToPath(import.meta.url)), "rtk");
	const lifetime = new AbortController();
	const pending = new Set<Promise<Processed | undefined>>();
	const reported = new Set<Failure>();
	const ledger = new Ledger();
	const reads = new ReadIndex();
	const passages = new PassageIndex();
	const gate = createGate(pipelines);
	// Verify recall once per session since RTK only emits a hint after storing.
	let recallVerified = false;
	let contextCache:
		| { leaf: string | null; results: Map<string, string> }
		| undefined;

	const warn = (reason: Failure, ctx: ExtensionContext): void => {
		if (reason === "aborted" || reported.has(reason)) return;
		reported.add(reason);
		show(
			ctx,
			`[rtk-pi-extended] ${FAILURE_MESSAGES[reason]}; original output retained.`,
			"warning",
		);
	};

	/** Return model-visible tool results, rebuilding only when the session leaf moves. */
	const contextOf = (ctx: ExtensionContext) => (): ContextResults => {
		const leaf = ctx.sessionManager.getLeafId();
		if (contextCache?.leaf === leaf) return contextCache.results;
		const results = new Map<string, string>();
		for (const message of ctx.sessionManager.buildSessionProjection()
			.messages) {
			if (message.role === "toolResult")
				results.set(message.toolCallId, textOf(message.content));
		}
		contextCache = { leaf, results };
		return results;
	};

	const forget = (): void => {
		reads.clear();
		passages.clear();
		contextCache = undefined;
	};
	// Clear cached indexes on compaction or branch switches to free memory.
	pi.on("session_compact", forget);
	pi.on("session_tree", forget);

	pi.on(
		"tool_result",
		async (
			event: ToolResultEvent,
			ctx: ExtensionContext,
		): Promise<ToolResultEventResult | undefined> => {
			if (
				process.env.RTK_DISABLED === "1" ||
				lifetime.signal.aborted ||
				ctx.signal?.aborted
			)
				return undefined;
			if (
				(isEditToolResult(event) || isWriteToolResult(event)) &&
				!event.isError &&
				typeof event.input.path === "string"
			)
				reads.invalidate(resolvePath(event.input.path, ctx.cwd));
			const route = select(event, ctx.cwd);
			const block = event.content[0];
			if (!route || block?.type !== "text") return undefined;
			const signal = ctx.signal
				? AbortSignal.any([ctx.signal, lifetime.signal])
				: lifetime.signal;
			const deps: Dependencies = {
				cwd: ctx.cwd,
				gate,
				context: contextOf(ctx),
				reads,
				passages,
				rtk: async (
					tool: string,
					text: string,
					pipeline: Pipeline,
				): Promise<Result> => {
					const verify = !recallVerified;
					const result = await filterPosthook(
						rtkToolName(tool),
						text,
						{ cwd: ctx.cwd, configDirectory: join(pipelines, pipeline), signal },
						structureCheck(pipeline),
						verify,
					);
					if (verify && result.kind === "filtered") recallVerified = true;
					return result;
				},
			};
			const work = processRoute(route, event, deps);
			pending.add(work);
			try {
				const processed = await work;
				if (!processed || signal.aborted || processed.failure === "aborted")
					return undefined;
				ledger.record(processed.sample);
				if (processed.failure) warn(processed.failure, ctx);
				if (processed.text === undefined) return undefined;
				// Preserve block metadata and structuredContent while replacing only model-facing text.
				return {
					content: [{ ...block, text: processed.text }],
					...(event.structuredContent === undefined
						? {}
						: { structuredContent: event.structuredContent }),
				};
			} catch {
				// Never expose subprocess output or tool content through diagnostics.
				warn("unexpected", ctx);
				return undefined;
			} finally {
				pending.delete(work);
			}
		},
	);

	// Append outcome tallies at turn end without exposing them to the model.
	pi.on("turn_end", (event: TurnEndEvent): TurnEndEventResult | undefined => {
		const data = ledger.drain();
		if (data === undefined) return undefined;
		return {
			entries: [
				...event.entries,
				{ type: "custom", customType: ENTRY_TYPE, data },
			],
		};
	});

	/** Mirror the stock RTK Pi hook's rewrite decision without executing the command. */
	const rewriter =
		(rtk: string) =>
		async (command: string): Promise<boolean | undefined> => {
			try {
				// Pass `--` so commands starting with `-` are not parsed as rtk flags.
				const result = await pi.exec(rtk, ["rewrite", "--", command], {
					timeout: REWRITE_TIMEOUT_MS,
				});
				if (result.killed) return undefined;
				if (result.code !== 0 && result.code !== 3) return false;
				const rewritten = result.stdout.trim();
				return rewritten !== "" && rewritten !== command;
			} catch {
				return undefined;
			}
		};

	pi.registerCommand("rtk-coverage", {
		description:
			"Tool-output volume, RTK coverage, and savings from Pi sessions: /rtk-coverage [days] [project|all]",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const parsed = parseCoverageArgs(args);
			if (!parsed.ok) {
				show(ctx, parsed.message, "error");
				return;
			}
			const { options } = parsed;
			const since = windowStart(options.days);
			try {
				const files = await sessionFiles(
					ctx.sessionManager.getSessionDir(),
					options.scope,
					since,
				);
				const scan = await scanSessions(files, since);
				// Resolve rtk from PATH once per report, leaving commands unclassified when absent.
				const rtk = resolveExecutable("rtk");
				const bash = await classifyBash(
					scan.bashCommands,
					rtk ? rewriter(rtk) : async (): Promise<undefined> => undefined,
				);
				show(ctx, formatReport(options, scan, bash), "info");
			} catch (error: unknown) {
				const reason = error instanceof Error ? error.message : String(error);
				show(
					ctx,
					`RTK coverage could not read session files: ${reason}`,
					"error",
				);
			}
		},
	});

	pi.on("session_shutdown", async (): Promise<void> => {
		lifetime.abort();
		forget();
		await Promise.allSettled([...pending]);
	});
}
