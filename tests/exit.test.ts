import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import exitExtension from "../exit.ts";

type NotifyLevel = NonNullable<Parameters<ExtensionUIContext["notify"]>[1]>;
type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];

interface RegisteredCommandEntry {
	name: string;
	options: CommandOptions;
}

function setupExitExtension(): {
	commands: RegisteredCommandEntry[];
	events: string[];
	handler: CommandOptions["handler"];
} {
	const commands: RegisteredCommandEntry[] = [];
	const events: string[] = [];

	const pi = {
		registerCommand(name: string, options: CommandOptions): void {
			commands.push({ name, options });
		},
		on(event: string): void {
			events.push(event);
		},
	} as unknown as ExtensionAPI;

	exitExtension(pi);

	const registered = commands[0];
	assert.ok(registered, "expected /exit command to be registered");
	return { commands, events, handler: registered.options.handler };
}

function createCommandContext(options?: {
	isIdle?: boolean;
	hasUI?: boolean;
	onShutdown?: () => void;
}): {
	ctx: ExtensionCommandContext;
	shutdownCalls: number[];
	notifications: Array<{ message: string; level: NotifyLevel | undefined }>;
} {
	const shutdownCalls: number[] = [];
	const notifications: Array<{
		message: string;
		level: NotifyLevel | undefined;
	}> = [];
	const hasUI = options?.hasUI ?? true;
	const idle = options?.isIdle ?? true;

	const ui = hasUI
		? {
				notify(message: string, level?: NotifyLevel): void {
					notifications.push({ message, level });
				},
			}
		: {
				notify(): never {
					throw new Error(
						"ctx.ui.notify must not be called when hasUI is false",
					);
				},
			};

	const ctx = {
		cwd: process.cwd(),
		hasUI,
		ui,
		isIdle(): boolean {
			return idle;
		},
		shutdown(): void {
			shutdownCalls.push(Date.now());
			options?.onShutdown?.();
		},
	} as unknown as ExtensionCommandContext;

	return { ctx, shutdownCalls, notifications };
}

describe("exitExtension", () => {
	it("registers only the /exit command with the expected description and no event hooks", () => {
		const { commands, events } = setupExitExtension();
		assert.equal(commands.length, 1);
		assert.equal(commands[0]?.name, "exit");
		assert.equal(commands[0]?.options.description, "Quit Pi");
		assert.deepEqual(events, []);
	});

	it("calls ctx.shutdown() once without error or UI notification when idle", async () => {
		const { handler } = setupExitExtension();
		const { ctx, shutdownCalls, notifications } = createCommandContext({
			isIdle: true,
			hasUI: true,
		});

		await handler("", ctx);

		assert.equal(shutdownCalls.length, 1);
		assert.deepEqual(notifications, []);
	});

	it("ignores trailing arguments and still requests graceful shutdown", async () => {
		const { handler } = setupExitExtension();
		for (const args of ["now", "--force", "   extra args   "]) {
			const { ctx, shutdownCalls, notifications } = createCommandContext({
				isIdle: true,
				hasUI: true,
			});

			await handler(args, ctx);

			assert.equal(shutdownCalls.length, 1);
			assert.deepEqual(notifications, []);
		}
	});

	it("delegates to ctx.shutdown() even when !ctx.isIdle() without notifying UI", async () => {
		const { handler } = setupExitExtension();
		const { ctx, shutdownCalls, notifications } = createCommandContext({
			isIdle: false,
			hasUI: true,
		});

		await handler("", ctx);

		assert.equal(shutdownCalls.length, 1);
		assert.deepEqual(notifications, []);
	});

	it("runs safely when hasUI is false without touching ctx.ui", async () => {
		const { handler } = setupExitExtension();
		const { ctx, shutdownCalls } = createCommandContext({
			isIdle: true,
			hasUI: false,
		});

		await handler("", ctx);

		assert.equal(shutdownCalls.length, 1);
	});

	it("propagates synchronous errors thrown by ctx.shutdown()", async () => {
		const { handler } = setupExitExtension();
		const { ctx } = createCommandContext({
			onShutdown: () => {
				throw new Error("shutdown failed");
			},
		});

		await assert.rejects(handler("", ctx), /shutdown failed/);
	});
});
