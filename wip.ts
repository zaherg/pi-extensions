import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { resolveExecutable } from "./shared/executable.ts";

type NotifyLevel = NonNullable<Parameters<ExtensionUIContext["notify"]>[1]>;

export default function wipExtension(pi: ExtensionAPI): void {
	let running = false;

	pi.registerCommand("wip", {
		description: 'Run git add . && git commit -m "wip"',
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const notify = (message: string, type: NotifyLevel): void => {
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

			// Never run a git.exe planted in the project on Windows.
			const git = resolveExecutable("git");
			if (!git) {
				notify("git was not found on PATH.", "error");
				return;
			}

			running = true;
			let command = "git add .";
			try {
				const commands: string[][] = [
					["add", "."],
					["commit", "-m", "wip"],
				];
				for (const gitArgs of commands) {
					command = `git ${gitArgs.join(" ")}`;
					const result = await pi.exec(git, gitArgs, { cwd: ctx.cwd });
					if (result.code !== 0 || result.killed) {
						// Report status without forwarding hook output that could contain secrets.
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
