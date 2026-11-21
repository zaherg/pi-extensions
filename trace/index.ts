import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { displayLabel, displayTail } from "../shared/display.ts";

const PAGE_SIZE = 25;
const OLDER = "Older results →";
const NEWER = "← Newer results";

const PREVIEW_KEYS = [
	"command",
	"path",
	"file_path",
	"pattern",
	"query",
	"url",
	"action",
	"agent",
	"workflow",
] as const;

interface NestedCall {
	name: string;
	args: string;
	status: string;
	error: string;
}

interface TraceItem {
	id: string;
	time: string;
	msg: ToolResultMessage;
	preview: string;
	hasFailedNestedCall: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const isFailedCall = (c: NestedCall): boolean =>
	c.status === "error" || c.status === "cancelled";

export function callPreview(args: unknown): string {
	if (!isRecord(args)) return "";
	for (const key of PREVIEW_KEYS) {
		const val = args[key];
		if (typeof val !== "string") continue;
		const label = displayLabel(val, 40);
		if (label) return label;
	}
	if (typeof args.code === "string") {
		const line =
			args.code
				.split(/\r?\n/u)
				.find(
					(l: string): boolean =>
						Boolean(l.trim()) && !l.trim().startsWith("// @options:"),
				) ?? "";
		return displayLabel(line, 40);
	}
	return "";
}

export function codemodeCalls(msg: ToolResultMessage): NestedCall[] {
	if (
		msg.toolName !== "codemode" ||
		!isRecord(msg.details) ||
		!Array.isArray(msg.details.calls)
	)
		return [];
	const out: NestedCall[] = [];
	for (const raw of msg.details.calls) {
		if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name) continue;
		out.push({
			name: raw.name,
			args: typeof raw.args === "string" ? raw.args : callPreview(raw.args),
			status:
				typeof raw.status === "string"
					? displayLabel(raw.status, 16) || "unknown"
					: "unknown",
			error: typeof raw.error === "string" ? raw.error : "",
		});
	}
	return out;
}

function diagnostic(msg: ToolResultMessage): string {
	// Keep only a bounded text tail without loading referenced files or rendering images.
	const { content } = msg;
	let text = "";
	let cut = false;
	if (Array.isArray(content)) {
		for (let i = content.length - 1; i >= 0; i--) {
			const block = content[i];
			if (
				block?.type !== "text" ||
				typeof block.text !== "string" ||
				!block.text
			)
				continue;
			const space = 16_384 - text.length - (text ? 1 : 0);
			if (space <= 0) {
				// Prepend a newline when earlier blocks were dropped so this block stays intact.
				text = `\n${text}`;
				cut = true;
				break;
			}
			text = block.text.slice(-space) + (text ? `\n${text}` : "");
			if (block.text.length > space) {
				cut = true;
				break;
			}
		}
	}
	const tail = displayTail(
		text,
		cut,
		"(No displayable text in the retained output.)",
	);
	const nested = codemodeCalls(msg);
	if (!nested.length) return tail;
	const lines = ["[Nested calls]"];
	if (nested.length > 10) lines.push(`(Showing last 10 of ${nested.length})`);
	for (const c of nested.slice(-10)) {
		const name = displayLabel(c.name, 32) || "?";
		const arg = c.args ? displayLabel(c.args, 40) : "";
		const err = c.error ? displayLabel(c.error, 120) : "";
		lines.push(
			`- ${c.status} ${name}${arg ? ` (${arg})` : ""}${err ? `: ${err}` : ""}`,
		);
	}
	return `${lines.join("\n")}\n\n${tail}`;
}

export default function trace(pi: ExtensionAPI): void {
	let branch = new AbortController();
	pi.on("session_tree", (): void => {
		branch.abort();
		branch = new AbortController();
	});
	pi.on("session_shutdown", (): void => branch.abort());

	pi.registerCommand("trace", {
		description:
			"Inspect recorded tool results on this branch: /trace [failed] [tool]",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			if (!ctx.hasUI)
				throw new Error("/trace requires an interactive Pi or RPC UI.");
			const tokens = args.trim() ? args.trim().split(/\s+/u) : [];
			if (
				tokens.length > 2 ||
				(tokens.length === 2 && tokens[0] !== "failed")
			) {
				ctx.ui.notify("Usage: /trace [failed] [tool]", "warning");
				return;
			}
			const failedOnly = tokens[0] === "failed";
			const tool = failedOnly ? tokens[1] : tokens[0];
			const calls = new Map<string, unknown>();
			const results = ctx.sessionManager
				.getBranch()
				.flatMap((entry: SessionEntry): TraceItem[] => {
					if (entry.type !== "message") return [];
					if (
						entry.message.role === "assistant" &&
						Array.isArray(entry.message.content)
					) {
						for (const block of entry.message.content) {
							if (block?.type === "toolCall")
								calls.set(block.id, block.arguments);
						}
						return [];
					}
					if (entry.message.role !== "toolResult") return [];
					const msg = entry.message;
					const nested = codemodeCalls(msg);
					const failedNested = nested.filter(isFailedCall).length;
					const hasFailedNestedCall = failedNested > 0;
					if (nested.length > 0) {
						const directMatch =
							(!failedOnly || msg.isError === true || hasFailedNestedCall) &&
							(!tool || tool === "codemode");
						const nestedMatch =
							Boolean(tool && tool !== "codemode") &&
							nested.some(
								(c: NestedCall): boolean =>
									c.name === tool && (!failedOnly || isFailedCall(c)),
							);
						if (!directMatch && !nestedMatch) return [];
					} else if (
						(failedOnly && msg.isError !== true) ||
						(tool && msg.toolName !== tool)
					) {
						return [];
					}
					const nestedTool =
						tool && tool !== "codemode" ? displayLabel(tool, 24) : "";
					const hint =
						nested.length > 0 && (failedNested > 0 || nestedTool)
							? failedNested > 0 && nestedTool
								? `[${nestedTool} ${failedNested}/${nested.length} err]`
								: failedNested > 0
									? `[${failedNested}/${nested.length} err]`
									: `[${nestedTool}]`
							: "";
					const preview = [hint, callPreview(calls.get(msg.toolCallId))]
						.filter(Boolean)
						.join(" ");
					return [
						{
							id: entry.id,
							time: entry.timestamp,
							msg,
							preview,
							hasFailedNestedCall,
						},
					];
				})
				.reverse();
			if (!results.length) {
				ctx.ui.notify("No matching tool results on this branch.", "info");
				return;
			}
			const { signal } = branch;
			let offset = 0;
			for (;;) {
				const page = results.slice(offset, offset + PAGE_SIZE);
				const labels = page.map(
					(
						{ id, time, msg, preview, hasFailedNestedCall }: TraceItem,
						i: number,
					): string => {
						const status = msg.isError
							? "failed"
							: hasFailedNestedCall
								? "nested-err"
								: "ok";
						return `${offset + i + 1}. ${status} ${displayLabel(msg.toolName, 64) || "?"}${preview ? ` (${preview})` : ""} · ${displayLabel(time, 32) || "?"} · #${displayLabel(id, 36) || "?"}`;
					},
				);
				const options = [...labels];
				if (offset) options.push(NEWER);
				if (offset + page.length < results.length) options.push(OLDER);
				const pick = await ctx.ui.select(
					`Tool trace (${offset + 1}-${offset + page.length} of ${results.length})`,
					options,
					{ signal },
				);
				if (signal.aborted || !pick || !options.includes(pick)) return;
				if (pick === NEWER) offset -= PAGE_SIZE;
				else if (pick === OLDER) offset += PAGE_SIZE;
				else {
					const selected = page[labels.indexOf(pick)];
					if (!selected) return;
					if (
						!ctx.sessionManager
							.getBranch()
							.some((entry: SessionEntry) => entry.id === selected.id)
					) {
						ctx.ui.notify(
							"The selected result is no longer on this branch.",
							"warning",
						);
						return;
					}
					ctx.ui.notify(
						`${pick}\n${diagnostic(selected.msg)}`,
						selected.msg.isError || selected.hasFailedNestedCall
							? "warning"
							: "info",
					);
				}
			}
		},
	});
}
