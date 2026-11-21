import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Failure, filterPosthook } from "./bridge.ts";
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
import { rtkToolName, select, structureCheck } from "./policy.ts";
import { type Dependencies, type Processed, processRoute } from "./process.ts";
import { resolvePath } from "./views.ts";
import { resolveExecutable } from "../shared/executable.ts";

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

type Level = "info" | "warning" | "error";

function show(ctx: ExtensionContext, message: string, level: Level): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	// stdout can carry a JSON or RPC protocol; keep diagnostics off it.
	else process.stderr.write(`${message}\n`);
}

function textOf(content: readonly { type: string; text?: string }[]): string {
	return content
		.flatMap((block) =>
			block.type === "text" && block.text !== undefined ? [block.text] : [],
		)
		.join("\n");
}

export default function rtkPiExtended(pi: ExtensionAPI) {
	const pipelines = join(dirname(fileURLToPath(import.meta.url)), "rtk");
	const lifetime = new AbortController();
	const pending = new Set<Promise<Processed | undefined>>();
	const reported = new Set<Failure>();
	const ledger = new Ledger();
	const reads = new ReadIndex();
	const passages = new PassageIndex();
	const gate = createGate(pipelines);
	// One readback per session proves recall works here; RTK only emits a hint after storing.
	let recallVerified = false;
	let contextCache:
		| { leaf: string | null; results: Map<string, string> }
		| undefined;

	const warn = (reason: Failure, ctx: ExtensionContext) => {
		if (reason === "aborted" || reported.has(reason)) return;
		reported.add(reason);
		show(
			ctx,
			`[rtk-pi-extended] ${FAILURE_MESSAGES[reason]}; original output retained.`,
			"warning",
		);
	};

	/** Model-visible tool results, rebuilt only when the session leaf moves. */
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

	const forget = () => {
		reads.clear();
		passages.clear();
		contextCache = undefined;
	};
	// Context verification already ignores dropped results; this only frees memory.
	pi.on("session_compact", forget);
	pi.on("session_tree", forget);

	pi.on("tool_result", async (event, ctx) => {
		if (
			process.env.RTK_DISABLED === "1" ||
			lifetime.signal.aborted ||
			ctx.signal?.aborted
		)
			return;
		const { toolName, input } = event;
		if (
			(toolName === "edit" || toolName === "write") &&
			!event.isError &&
			typeof input.path === "string"
		)
			reads.invalidate(resolvePath(input.path, ctx.cwd));
		const route = select(event, ctx.cwd);
		const block = event.content[0];
		if (!route || block?.type !== "text") return;
		const signal = ctx.signal
			? AbortSignal.any([ctx.signal, lifetime.signal])
			: lifetime.signal;
		const deps: Dependencies = {
			cwd: ctx.cwd,
			gate,
			context: contextOf(ctx),
			reads,
			passages,
			rtk: async (tool, text, pipeline) => {
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
		const work = processRoute(
			route,
			{ toolName, toolCallId: event.toolCallId, input },
			deps,
		);
		pending.add(work);
		try {
			const processed = await work;
			if (!processed || signal.aborted || processed.failure === "aborted")
				return;
			ledger.record(processed.sample);
			if (processed.failure) warn(processed.failure, ctx);
			if (processed.text === undefined) return;
			// Pi's details, usage, error state, and block metadata stay untouched.
			// The machine-readable result is not model-facing; keep it complete.
			return {
				content: [{ ...block, text: processed.text }],
				...(event.structuredContent === undefined
					? {}
					: { structuredContent: event.structuredContent }),
			};
		} catch {
			// Never expose subprocess output or tool content through diagnostics.
			warn("unexpected", ctx);
		} finally {
			pending.delete(work);
		}
	});

	// Tool results are persisted by now; outcome entries never reach the model.
	pi.on("turn_end", (event) => {
		const data = ledger.drain();
		if (data === undefined) return;
		return {
			entries: [
				...event.entries,
				{ type: "custom", customType: ENTRY_TYPE, data },
			],
		};
	});

	/** Mirrors the stock RTK Pi hook's rewrite decision without running the command. */
	const rewriter =
		(rtk: string) =>
		async (command: string): Promise<boolean | undefined> => {
			try {
				// `--` keeps a command starting with `-` from being read as an rtk option.
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
		handler: async (args, ctx) => {
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
				// Resolve once per report; on Windows a bare name would also match
				// an rtk.exe planted in Pi's cwd. Without RTK, commands stay unclassified.
				const rtk = resolveExecutable("rtk");
				const bash = await classifyBash(
					scan.bashCommands,
					rtk ? rewriter(rtk) : async () => undefined,
				);
				show(ctx, formatReport(options, scan, bash), "info");
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				show(
					ctx,
					`RTK coverage could not read session files: ${reason}`,
					"error",
				);
			}
		},
	});

	pi.on("session_shutdown", async () => {
		lifetime.abort();
		forget();
		await Promise.allSettled([...pending]);
	});
}
