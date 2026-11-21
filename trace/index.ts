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

interface TraceItem {
	id: string;
	time: string;
	msg: ToolResultMessage;
}

function diagnostic(content: ToolResultMessage["content"]): string {
	// Keep only a bounded text tail without loading referenced files or rendering images.
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
	return displayTail(
		text,
		cut,
		"(No displayable text in the retained output.)",
	);
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
			"Inspect recorded tool results on this branch: /trace [failed [tool]]",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			if (!ctx.hasUI)
				throw new Error("/trace requires an interactive Pi or RPC UI.");
			const [filter, tool, extra] = args.trim().split(/\s+/u);
			if ((filter && filter !== "failed") || extra) {
				ctx.ui.notify("Usage: /trace [failed [tool]]", "warning");
				return;
			}
			const results = ctx.sessionManager
				.getBranch()
				.flatMap((entry: SessionEntry): TraceItem[] => {
					if (entry.type !== "message" || entry.message.role !== "toolResult")
						return [];
					const msg = entry.message;
					if (
						(filter && msg.isError !== true) ||
						(tool && msg.toolName !== tool)
					)
						return [];
					return [{ id: entry.id, time: entry.timestamp, msg }];
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
					({ id, time, msg }: TraceItem, i: number): string =>
						`${offset + i + 1}. ${msg.isError ? "failed" : "ok"} ${displayLabel(msg.toolName, 64) || "?"} · ${displayLabel(time, 32) || "?"} · #${displayLabel(id, 36) || "?"}`,
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
					ctx.ui.notify(`${pick}\n${diagnostic(selected.msg.content)}`, "info");
					return;
				}
			}
		},
	});
}
