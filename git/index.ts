import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import type {
	CustomEntry,
	EntryRenderOptions,
	ExtensionAPI,
	ExtensionCommandContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, type TUI } from "@earendil-works/pi-tui";
import {
	CAPTURE_BYTES,
	gitResultMessage,
	terminalCaptureArgs,
} from "./terminal.ts";

export function gitShellCommand(args: string): string {
	if (!args.trim()) return "git";
	// Rewrite standalone quoted commit messages into git commit -m.
	const message =
		/^[ \t]*commit[ \t]+("(?:[^"\\]|\\[\s\S])*"|'[^']*')[ \t\r\n]*$/.exec(args);
	return message ? `git commit -m ${message[1]}` : `git ${args}`;
}

export default function gitExtension(pi: ExtensionAPI): void {
	let running = false;

	// Render custom Git entries in the transcript without sending them to the model.
	pi.registerEntryRenderer<string>(
		"git-output",
		(entry: CustomEntry<string>, _options: EntryRenderOptions, theme: Theme): Component => {
			const message =
				typeof entry.data === "string" ? entry.data : "Invalid saved Git output.";
			return new Text(`${theme.fg("accent", "/git")}\n${message}`, 1, 0);
		},
	);

	pi.registerCommand("git", {
		description:
			'Run any Git command with inline results; commit "message" means commit -m "message"',
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			if (ctx.mode !== "tui") {
				throw new Error("/git requires Pi's interactive terminal.");
			}
			if (running || !ctx.isIdle()) {
				ctx.ui.notify(
					"Wait for the current operation to finish before running /git.",
					"warning",
				);
				return;
			}

			running = true;
			// Prevent Ctrl+C from terminating Pi during terminal handoff.
			const ignoreSigint = (): void => {};
			process.on("SIGINT", ignoreSigint);
			let message: string;
			try {
				const result = await ctx.ui.custom<SpawnSyncReturns<Buffer>>(
					(
						tui: TUI,
						_theme: Theme,
						_keybindings: KeybindingsManager,
						done: (result: SpawnSyncReturns<Buffer>) => void,
					): Component => {
						let result: SpawnSyncReturns<Buffer>;
						tui.stop();
						try {
							// Pass cwd outside the shell string so path metacharacters are not interpreted.
							result = spawnSync(
								"/bin/bash",
								terminalCaptureArgs(
									process.env.SHELL || "/bin/sh",
									gitShellCommand(args),
								),
								{
									cwd: ctx.cwd,
									stdio: ["inherit", "pipe", "inherit"],
									maxBuffer: CAPTURE_BYTES + 1024,
								},
							);
						} finally {
							tui.start();
							tui.requestRender(true);
						}
						done(result);
						return { render: (): string[] => [], invalidate(): void {} };
					},
				);

				message = result.error
					? "Git shell could not be started. Check SHELL and the project directory."
					: gitResultMessage(result.stdout, result.status, result.signal);
			} catch {
				// Avoid copying shell errors that could contain credentials into the transcript.
				message =
					"Git terminal execution failed. Check git status before retrying.";
			} finally {
				// Wait two check phases so deferred SIGINT signals drain before restoring the listener.
				await setImmediate();
				await setImmediate();
				process.removeListener("SIGINT", ignoreSigint);
				running = false;
			}

			try {
				pi.appendEntry<string>("git-output", message);
			} catch {
				// Warn instead of failing after Git has already executed.
				ctx.ui.notify(
					`Could not save Git's inline result.\n${message}`,
					"warning",
				);
			}
		},
	});
}
