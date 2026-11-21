import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionShutdownEvent,
	SessionTreeEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { latestBatch, type Row, workerRows } from "./report.ts";

const KEY = "worker-board";
const PAGE_SIZE = 6;

function resultDetails(value: unknown): unknown {
	return typeof value === "object" && value !== null && "details" in value
		? value.details
		: undefined;
}

function widgetLines(lines: string[], width: number): string[] {
	// Limit each worker entry to two screen lines so long tasks do not bury blockers.
	const inset = width > 2 ? " " : "";
	const columns = Math.max(1, width - 2 * inset.length);
	return lines.flatMap((line: string): string[] => {
		const [first = "", ...rest] = wrapTextWithAnsi(line, columns);
		return rest.length
			? [inset + first, inset + truncateToWidth(rest.join(" "), columns, "…")]
			: [inset + first];
	});
}

export default function workerBoard(pi: ExtensionAPI): void {
	const batch = new Map<string, { args: unknown; rows: Row[] }>();
	let page = 0;
	let previous = "";
	let hidden = false;

	function draw(ctx: ExtensionContext, requested?: number): void {
		if (!ctx.hasUI || (!page && !requested)) return;
		const rows = batch.size
			? [...batch.values()].flatMap((call) => call.rows)
			: latestBatch(ctx.sessionManager.getBranch());
		rows.sort((a: Row, b: Row) => a.priority - b.priority);
		const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
		if (requested !== undefined && requested > pages) {
			ctx.ui.notify(`Worker board has ${pages} page(s).`, "warning");
			return;
		}
		page = Math.min(requested ?? page, pages);
		const lines = [
			`Workers · ${batch.size ? "current batch" : "last recorded batch"} · ${page}/${pages}`,
		];
		if (rows.length)
			lines.push(
				...rows
					.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
					.map((row: Row) => row.text),
			);
		else lines.push("No subagent calls on this branch.");
		lines.push(
			pages > 1
				? "/workers N: page · /workers hide: close"
				: "/workers hide: close",
		);
		const snapshot = lines.join("\n");
		if (snapshot === previous) return;
		if (ctx.mode === "tui") {
			ctx.ui.setWidget(KEY, (): Component => ({
				render: (width: number): string[] => widgetLines(lines, width),
				invalidate(): void {},
			}));
		} else {
			ctx.ui.setWidget(KEY, lines);
		}
		previous = snapshot;
	}

	function hide(ctx: ExtensionContext): void {
		if (page && ctx.hasUI) ctx.ui.setWidget(KEY, undefined);
		page = 0;
		previous = "";
	}

	pi.registerCommand("workers", {
		description: "Show the subagent worker board: /workers [page|hide]",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			if (!ctx.hasUI)
				throw new Error("/workers requires an interactive Pi or RPC UI.");
			const value = args.trim();
			if (value === "hide") {
				hidden = true;
				hide(ctx);
			} else if (!value || /^[1-9]\d{0,8}$/.test(value)) {
				hidden = false;
				draw(ctx, Number(value || 1));
			} else ctx.ui.notify("Usage: /workers [page|hide]", "warning");
		},
	});

	// Ignore nested tool calls because they have no independent result on the parent branch.
	pi.on("tool_execution_start", (event: ToolExecutionStartEvent, ctx: ExtensionContext): void => {
		if (
			!ctx.hasUI ||
			event.toolName !== "subagent" ||
			event.parentToolCallId !== undefined
		)
			return;
		const callArgs: unknown = event.args;
		const isManagement =
			typeof callArgs === "object" &&
			callArgs !== null &&
			"action" in callArgs &&
			!("agent" in callArgs) &&
			!("tasks" in callArgs) &&
			!("chain" in callArgs) &&
			!("workflow" in callArgs) &&
			!("workflowScript" in callArgs);
		if (!page && !hidden && !isManagement) page = 1;
		batch.set(event.toolCallId, {
			args: callArgs,
			rows: workerRows(event.toolCallId, callArgs, undefined, "live"),
		});
		draw(ctx);
	});
	pi.on("tool_execution_update", (event: ToolExecutionUpdateEvent, ctx: ExtensionContext): void => {
		if (event.toolName !== "subagent" || event.parentToolCallId !== undefined)
			return;
		const call = batch.get(event.toolCallId);
		if (!call) return;
		call.rows = workerRows(
			event.toolCallId,
			call.args,
			resultDetails(event.partialResult),
			"live",
		);
		draw(ctx);
	});
	pi.on("tool_execution_end", (event: ToolExecutionEndEvent, ctx: ExtensionContext): void => {
		if (event.toolName !== "subagent" || event.parentToolCallId !== undefined)
			return;
		const call = batch.get(event.toolCallId);
		if (!call) return;
		call.rows = workerRows(
			event.toolCallId,
			call.args,
			resultDetails(event.result),
			event.isError ? "failed" : "finished",
		);
		draw(ctx);
	});
	function settled(ctx: ExtensionContext): void {
		batch.clear();
		hidden = false;
		draw(ctx);
	}
	// Clear transient live state once persisted results are available on the branch.
	pi.on("turn_start", (_event: TurnStartEvent, ctx: ExtensionContext): void => settled(ctx));
	pi.on("agent_end", (_event: AgentEndEvent, ctx: ExtensionContext): void => settled(ctx));
	pi.on("session_tree", (_event: SessionTreeEvent, ctx: ExtensionContext): void => settled(ctx));
	pi.on("session_shutdown", (_event: SessionShutdownEvent, ctx: ExtensionContext): void => {
		batch.clear();
		hidden = false;
		hide(ctx);
	});
}
