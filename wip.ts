import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let running = false;

	pi.registerCommand("wip", {
		description: 'Run git add . && git commit -m "wip"',
		handler: async (args, ctx) => {
			const notify = (message: string, type: "info" | "warning" | "error") => {
				if (ctx.hasUI) ctx.ui.notify(message, type);
			};
			if (args.trim()) {
				notify("Usage: /wip (no arguments)", "error");
				return;
			}
			if (running) {
				notify("/wip is already running.", "warning");
				return;
			}

			running = true;
			let command = "git add .";
			try {
				for (const gitArgs of [
					["add", "."],
					["commit", "-m", "wip"],
				]) {
					command = `git ${gitArgs.join(" ")}`;
					const result = await pi.exec("git", gitArgs, { cwd: ctx.cwd });
					if (result.code !== 0 || result.killed) {
						// Hooks can print secrets, so report status without forwarding output.
						notify(
							result.killed
								? `${command} was interrupted. Check git status before retrying.`
								: `${command} failed (exit code ${result.code}).`,
							"error",
						);
						return;
					}
				}
				notify('Committed with message "wip".', "info");
			} catch {
				notify(`${command} could not be executed.`, "error");
			} finally {
				running = false;
			}
		},
	});
}
