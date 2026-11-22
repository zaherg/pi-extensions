import type {
	ExtensionAPI,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { bindSession, type SessionSnapshot } from "../shared/session.ts";
import { latestBatch, type Row, workerRows } from "./report.ts";

const KEY = "worker-board";
const PAGE_SIZE = 6;

function resultDetails(value: unknown): unknown {
	return typeof value === "object" && value !== null && "details" in value
		? value.details
		: undefined;
}

function widgetLines(lines: string[], width: number): string[] {
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
	const session = bindSession(pi);
	const batch = new Map<string, { args: unknown; rows: Row[] }>();
	let page = 0;
	let previous = "";
	let hidden = false;

	function draw(snap: SessionSnapshot, requested?: number): void {
		if (!snap.hasUI || (!page && !requested)) return;
		let rows: Row[];
		if (batch.size) {
			rows = [...batch.values()].flatMap((call) => call.rows);
		} else {
			const entries = snap.branch();
			if (!entries) return;
			rows = latestBatch(entries);
		}
		rows.sort((a: Row, b: Row) => a.priority - b.priority);
		const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
		if (requested !== undefined && requested > pages) {
			snap.notify(`Worker board has ${pages} page(s).`, "warning");
			return;
		}
		if (requested !== undefined) hidden = false;
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
		if (snap.mode === "tui") {
			snap.setWidget(
				KEY,
				(): Component => ({
					render: (width: number): string[] => widgetLines(lines, width),
					invalidate(): void {},
				}),
			);
		} else {
			snap.setWidget(KEY, lines);
		}
		previous = snapshot;
	}

	function hide(snap: SessionSnapshot | undefined): void {
		if (page) snap?.setWidget(KEY, undefined);
		page = 0;
		previous = "";
	}

	session.registerCommand("workers", {
		description: "Show the subagent worker board: /workers [page|hide]",
		handler: async (args: string, snap: SessionSnapshot): Promise<void> => {
			if (!snap.hasUI)
				throw new Error("/workers requires an interactive Pi or RPC UI.");
			const value = args.trim();
			if (value === "hide") {
				hidden = true;
				hide(snap);
			} else if (!value || /^[1-9]\d{0,8}$/.test(value)) {
				draw(snap, Number(value || 1));
			} else snap.notify("Usage: /workers [page|hide]", "warning");
		},
	});

	// Ignore nested tool calls because they have no independent result on the parent branch.
	session.on(
		"tool_execution_start",
		(event: ToolExecutionStartEvent, snap: SessionSnapshot): void => {
			if (
				!snap.hasUI ||
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
			draw(snap);
		},
	);
	session.on(
		"tool_execution_update",
		(event: ToolExecutionUpdateEvent, snap: SessionSnapshot): void => {
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
			draw(snap);
		},
	);
	session.on(
		"tool_execution_end",
		(event: ToolExecutionEndEvent, snap: SessionSnapshot): void => {
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
			draw(snap);
		},
	);
	function settled(snap: SessionSnapshot | undefined): void {
		batch.clear();
		hidden = false;
		if (snap) draw(snap);
	}
	function resetSession(snap: SessionSnapshot | undefined): void {
		batch.clear();
		hidden = false;
		hide(snap);
	}
	session.onLifecycle("turn_start", (_event, snap): void => settled(snap));
	session.onLifecycle("agent_end", (_event, snap): void => settled(snap));
	session.onLifecycle("session_tree", (_event, snap): void => settled(snap));
	session.onLifecycle("session_start", (_event, snap): void =>
		resetSession(snap),
	);
	session.onLifecycle("session_shutdown", (_event, snap): void =>
		resetSession(snap),
	);
}
