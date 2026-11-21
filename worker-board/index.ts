import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { latestBatch, type Row, workerRows } from "./report.ts";

const KEY = "worker-board";
const PAGE_SIZE = 6;

function widgetLines(lines: string[], width: number): string[] {
	// At most two screen lines per worker so long assignments cannot bury blockers.
	const inset = width > 2 ? " " : "";
	const columns = Math.max(1, width - 2 * inset.length);
	return lines.flatMap((line) => {
		const [first, ...rest] = wrapTextWithAnsi(line, columns);
		return rest.length
			? [inset + first, inset + truncateToWidth(rest.join(" "), columns, "…")]
			: [inset + first];
	});
}

export default function workerBoard(pi: ExtensionAPI) {
	const batch = new Map<string, { args: unknown; rows: Row[] }>();
	let page = 0;
	let previous = "";

	function draw(ctx: ExtensionContext, requested?: number) {
		if (!ctx.hasUI || (!page && !requested)) return;
		const rows = batch.size
			? [...batch.values()].flatMap((call) => call.rows)
			: latestBatch(ctx.sessionManager.getBranch());
		rows.sort((a, b) => a.priority - b.priority);
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
					.map((row) => row.text),
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
			ctx.ui.setWidget(KEY, () => ({
				render: (width) => widgetLines(lines, width),
				invalidate() {},
			}));
		} else {
			ctx.ui.setWidget(KEY, lines);
		}
		previous = snapshot;
	}

	function hide(ctx: ExtensionContext) {
		if (page && ctx.hasUI) ctx.ui.setWidget(KEY, undefined);
		page = 0;
		previous = "";
	}

	pi.registerCommand("workers", {
		description: "Show the subagent worker board: /workers [page|hide]",
		handler: async (args, ctx) => {
			if (!ctx.hasUI)
				throw new Error("/workers requires an interactive Pi or RPC UI.");
			const value = args.trim();
			if (value === "hide") hide(ctx);
			else if (!value || /^[1-9]\d{0,8}$/.test(value))
				draw(ctx, Number(value || 1));
			else ctx.ui.notify("Usage: /workers [page|hide]", "warning");
		},
	});

	// Nested tool calls have no independently persisted result on the parent branch.
	pi.on("tool_execution_start", (event, ctx) => {
		if (
			!ctx.hasUI ||
			event.toolName !== "subagent" ||
			event.parentToolCallId !== undefined
		)
			return;
		batch.set(event.toolCallId, {
			args: event.args,
			rows: workerRows(event.toolCallId, event.args, undefined, "live"),
		});
		draw(ctx);
	});
	pi.on("tool_execution_update", (event, ctx) => {
		if (event.toolName !== "subagent" || event.parentToolCallId !== undefined)
			return;
		const call = batch.get(event.toolCallId);
		if (!call) return;
		call.rows = workerRows(
			event.toolCallId,
			call.args,
			event.partialResult?.details,
			"live",
		);
		draw(ctx);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName !== "subagent" || event.parentToolCallId !== undefined)
			return;
		const call = batch.get(event.toolCallId);
		if (!call) return;
		call.rows = workerRows(
			event.toolCallId,
			call.args,
			event.result?.details,
			event.isError ? "failed" : "finished",
		);
		draw(ctx);
	});
	function settled(ctx: ExtensionContext) {
		batch.clear();
		draw(ctx);
	}
	// The next turn sees persisted results without opting into Pi's context-edit boundary.
	pi.on("turn_start", (_event, ctx) => settled(ctx));
	pi.on("agent_end", (_event, ctx) => settled(ctx));
	pi.on("session_tree", (_event, ctx) => settled(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		batch.clear();
		hide(ctx);
	});
}
