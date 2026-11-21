import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

export default function exitExtension(pi: ExtensionAPI): void {
	pi.registerCommand("exit", {
		description: "Quit Pi",
		handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
			ctx.shutdown();
		},
	});
}
