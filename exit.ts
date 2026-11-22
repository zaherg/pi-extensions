import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bindSession, type SessionSnapshot } from "./shared/session.ts";

export default function exitExtension(pi: ExtensionAPI): void {
	const session = bindSession(pi);
	session.registerCommand("exit", {
		description: "Quit Pi",
		handler: async (_args: string, snap: SessionSnapshot): Promise<void> => {
			snap.shutdown();
		},
	});
}
