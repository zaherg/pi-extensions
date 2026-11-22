import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import type {
	CustomEntry,
	EntryRenderOptions,
	ExtensionAPI,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, type TUI } from "@earendil-works/pi-tui";
import { bindSession, type SessionSnapshot } from "../shared/session.ts";
import {
	CAPTURE_BYTES,
	gitResultMessage,
	terminalCaptureArgs,
} from "./terminal.ts";

export function gitShellCommand(args: string): string {
	if (!args.trim()) return "git";
	const message =
		/^[ \t]*commit[ \t]+("(?:[^"\\]|\\[\s\S])*"|'[^']*')[ \t\r\n]*$/.exec(args);
	return message ? `git commit -m ${message[1]}` : `git ${args}`;
}

export default function gitExtension(pi: ExtensionAPI): void {
	const session = bindSession(pi);
	let activeRun: symbol | undefined;

	session.onLifecycle("session_start", (): void => {
		activeRun = undefined;
	});
	session.onLifecycle("session_shutdown", (): void => {
		activeRun = undefined;
	});

	pi.registerEntryRenderer<string>(
		"git-output",
		(
			entry: CustomEntry<string>,
			_options: EntryRenderOptions,
			theme: Theme,
		): Component => {
			const message =
				typeof entry.data === "string"
					? entry.data
					: "Invalid saved Git output.";
			return new Text(`${theme.fg("accent", "/git")}\n${message}`, 1, 0);
		},
	);

	session.registerCommand("git", {
		description:
			'Run any Git command with inline results; commit "message" means commit -m "message"',
		handler: async (args: string, snap: SessionSnapshot): Promise<void> => {
			if (snap.mode !== "tui") {
				throw new Error("/git requires Pi's interactive terminal.");
			}
			const idle = snap.isIdle();
			if (idle === undefined) return;
			if (activeRun !== undefined || !idle) {
				snap.notify(
					"Wait for the current operation to finish before running /git.",
					"warning",
				);
				return;
			}

			const { cwd, sessionSignal } = snap;
			const captureArgs = terminalCaptureArgs(
				process.env.SHELL || "/bin/sh",
				gitShellCommand(args),
			);

			const run = Symbol("git");
			activeRun = run;
			// Prevent Ctrl+C from terminating Pi during terminal handoff.
			const ignoreSigint = (): void => {};
			process.on("SIGINT", ignoreSigint);
			let message: string;
			try {
				const result = await snap.custom<SpawnSyncReturns<Buffer>>(
					(
						tui: TUI,
						_theme: Theme,
						_keybindings: KeybindingsManager,
						done: (result: SpawnSyncReturns<Buffer>) => void,
					): Component => {
						let spawned: SpawnSyncReturns<Buffer>;
						tui.stop();
						try {
							// Pass cwd outside the shell string so path metacharacters are not interpreted.
							spawned = spawnSync("/bin/bash", captureArgs, {
								cwd,
								stdio: ["inherit", "pipe", "inherit"],
								maxBuffer: CAPTURE_BYTES + 1024,
							});
						} finally {
							tui.start();
							tui.requestRender(true);
						}
						done(spawned);
						return { render: (): string[] => [], invalidate(): void {} };
					},
				);

				message = result.error
					? "Git shell could not be started. Check SHELL and the project directory."
					: gitResultMessage(result.stdout, result.status, result.signal);
			} catch {
				message =
					"Git terminal execution failed. Check git status before retrying.";
			} finally {
				// Wait two check phases so deferred SIGINT signals drain before restoring the listener.
				await setImmediate();
				await setImmediate();
				process.removeListener("SIGINT", ignoreSigint);
				if (activeRun === run) activeRun = undefined;
			}

			if (sessionSignal.aborted) return;

			if (!session.appendEntry<string>("git-output", message)) {
				snap.notify(`Could not save Git's inline result.\n${message}`, "warning");
			}
		},
	});
}
