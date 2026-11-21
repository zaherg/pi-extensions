import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { displayLabel } from "../shared/display.ts";

export type Phase = "live" | "finished" | "failed" | "missing";
export interface Row {
	priority: number;
	text: string;
}

type AssistantContentBlock = AssistantMessage["content"][number];
type WorkerStatus = keyof typeof priority;

const priority = {
	blocked: 0,
	failed: 0,
	aborted: 1,
	running: 2,
	pending: 3,
	completed: 4,
} as const;
const record = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const modes = new Set<unknown>([
	"single",
	"parallel",
	"chain",
	"workflow",
	"management",
]);
const knownStatus = (v: unknown): v is WorkerStatus =>
	typeof v === "string" && Object.hasOwn(priority, v);

function inferStatus(
	raw: Record<string, unknown>,
	phase: Phase,
): WorkerStatus | undefined {
	if (knownStatus(raw.status)) return raw.status;
	if (typeof raw.exitCode === "number")
		return raw.exitCode === 0 ? "completed" : "failed";
	if (phase === "live") return "running";
	return undefined;
}

function lastTool(messages: unknown, toolCalls?: unknown): string {
	if (Array.isArray(messages)) {
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg: unknown = messages[i];
			if (!record(msg)) continue;
			if (msg.role === "toolResult" && typeof msg.toolName === "string") {
				const name = displayLabel(msg.toolName, 32);
				if (name) return name;
				continue;
			}
			if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
			for (let j = msg.content.length - 1; j >= 0; j--) {
				const b: unknown = msg.content[j];
				if (!record(b) || b.type !== "toolCall" || typeof b.name !== "string")
					continue;
				const name = displayLabel(b.name, 32);
				if (name) return name;
			}
		}
	}
	if (Array.isArray(toolCalls)) {
		for (let i = toolCalls.length - 1; i >= 0; i--) {
			const entry: unknown = toolCalls[i];
			if (!record(entry) || typeof entry.text !== "string") continue;
			const name = displayLabel(entry.text, 32);
			if (name) return name;
		}
	}
	return "";
}

export function workerRows(
	source: string,
	args: unknown,
	details: unknown,
	phase: Phase,
): Row[] {
	const ref = `#${displayLabel(source, 36) || "?"}`;
	const note = (text: string, p = 1): Row => ({
		priority: p,
		text: `${ref} ${text}`,
	});
	if (phase === "missing") return [note("No worker outcome recorded.")];
	if (
		!record(details) ||
		!modes.has(details.mode) ||
		!Array.isArray(details.results)
	) {
		if (phase === "failed")
			return [note("Call failed; no worker outcome reported.", 0)];
		if (phase === "live" && details === undefined)
			return [note("Awaiting worker report.")];
		return [note("No compatible worker report.")];
	}
	if (!details.results.length) {
		if (details.mode === "workflow") {
			const wfState =
				record(details.workflowChildren) &&
				typeof details.workflowChildren.workflowState === "string"
					? displayLabel(details.workflowChildren.workflowState, 24)
					: "";
			const statusKey =
				phase === "failed" || wfState === "failed"
					? "failed"
					: phase === "live" ||
							wfState === "running" ||
							typeof details.asyncId === "string"
						? "running"
						: "completed";
			const statusLabel =
				phase !== "live" && statusKey === "running"
					? "last reported running"
					: statusKey;
			const name =
				displayLabel(
					record(args) && typeof args.workflow === "string"
						? args.workflow
						: "workflow",
					32,
				) || "workflow";
			const mission =
				record(args) && typeof args.mission === "string"
					? displayLabel(args.mission, 64)
					: "";
			const asyncTag = typeof details.asyncId === "string" ? "async" : "";
			return [
				{
					priority: priority[statusKey],
					text: [`${statusLabel} ${name} ${ref}`, mission, asyncTag]
						.filter(Boolean)
						.join(" · "),
				},
			];
		}
		if (typeof details.asyncId === "string") {
			const agent =
				(record(args) && typeof args.agent === "string"
					? displayLabel(args.agent, 32)
					: "") || "worker";
			const task =
				record(args) && typeof args.task === "string"
					? displayLabel(args.task, 64)
					: "";
			const statusLabel =
				phase === "failed"
					? "failed"
					: phase === "live"
						? "running (async)"
						: "last reported async";
			return [
				{
					priority: phase === "failed" ? 0 : priority.running,
					text: [`${statusLabel} ${agent} ${ref}`, task]
						.filter(Boolean)
						.join(" · "),
				},
			];
		}
		if (details.mode === "management") {
			const action =
				(record(args) && typeof args.action === "string"
					? displayLabel(args.action, 24)
					: "") || "action";
			const state =
				record(details.lifecycleStatus) &&
				record(details.lifecycleStatus.processTerminal) &&
				typeof details.lifecycleStatus.processTerminal.state === "string"
					? displayLabel(details.lifecycleStatus.processTerminal.state, 24)
					: record(details.steering) &&
							typeof details.steering.state === "string"
						? displayLabel(details.steering.state, 24)
						: "";
			return [
				{
					priority: phase === "failed" ? 0 : priority.completed,
					text: [
						`${phase === "failed" ? "failed" : "completed"} management:${action} ${ref}`,
						state && `state: ${state}`,
					]
						.filter(Boolean)
						.join(" · "),
				},
			];
		}
		return [
			phase === "failed"
				? note("Call failed; no worker outcome reported.", 0)
				: phase === "live"
					? note("Awaiting worker report.")
					: note("No worker outcome reported."),
		];
	}
	const assignments = record(args)
		? details.mode === "chain"
			? args.chain
			: details.mode === "parallel"
				? args.tasks
				: [args]
		: undefined;
	let reportedFailure = false;
	const rows = details.results.map((raw: unknown, i: number): Row => {
		const slot = `${ref}/${i + 1}`;
		if (!record(raw))
			return { priority: 1, text: `${slot} Unsupported worker report.` };
		const agent =
			typeof raw.agent === "string" ? displayLabel(raw.agent, 32) : "";
		const statusKey = inferStatus(raw, phase);
		if (!agent || !statusKey)
			return { priority: 1, text: `${slot} Unsupported worker report.` };
		if (statusKey === "failed" || statusKey === "aborted")
			reportedFailure = true;
		// Read requested task text from call args since chained results can embed full prior output.
		const request: unknown = Array.isArray(assignments)
			? assignments[i]
			: undefined;
		const task =
			record(request) &&
			request.agent === raw.agent &&
			typeof request.task === "string"
				? displayLabel(request.task, 64)
				: "";
		const blocker =
			statusKey === "blocked" && typeof raw.blocker === "string"
				? displayLabel(raw.blocker, 64)
				: "";
		const last = lastTool(raw.messages, raw.toolCalls);
		const status =
			phase !== "live" && (statusKey === "running" || statusKey === "pending")
				? `last reported ${statusKey}`
				: statusKey;
		return {
			priority: priority[statusKey],
			text: [
				`${status} ${agent} ${slot}`,
				blocker && `blocked by: ${blocker}`,
				task,
				last && `last: ${last}`,
			]
				.filter(Boolean)
				.join(" · "),
		};
	});
	if (phase === "failed" && !reportedFailure)
		rows.unshift(note("Call failed.", 0));
	return rows;
}

// Group subagent calls by assistant message so parallel workers stay in one batch.
export function latestBatch(entries: readonly SessionEntry[]): Row[] {
	const results = new Map<
		string,
		{ source: string; details: unknown; phase: Phase }
	>();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || entry.type !== "message") continue;
		const msg = entry.message;
		if (
			msg.role === "toolResult" &&
			msg.toolName === "subagent" &&
			!results.has(msg.toolCallId)
		) {
			results.set(msg.toolCallId, {
				source: entry.id,
				details: msg.details,
				phase: msg.isError ? "failed" : "finished",
			});
		} else if (msg.role === "assistant" && Array.isArray(msg.content)) {
			const rows = msg.content.flatMap((call: AssistantContentBlock): Row[] => {
				if (call.type !== "toolCall" || call.name !== "subagent") return [];
				const result = results.get(call.id);
				return workerRows(
					result?.source ?? call.id,
					call.arguments,
					result?.details,
					result?.phase ?? "missing",
				);
			});
			if (rows.length) return rows;
		}
	}
	return [];
}
