import type {
	AgentEndEvent,
	AgentSettledEvent,
	AgentToolResult,
	AgentToolUpdateCallback,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
	ExtensionUIContext,
	ExtensionWidgetOptions,
	InputEvent,
	InputEventResult,
	McpServerConfig,
	RegisteredCommand,
	SessionCompactEvent,
	SessionEntry,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionTreeEvent,
	Theme,
	ToolDefinition,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolResultEvent,
	ToolResultEventResult,
	TurnEndEvent,
	TurnEndEventResult,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Static, TSchema } from "typebox";

export type NotifyLevel = NonNullable<
	Parameters<ExtensionUIContext["notify"]>[1]
>;

export interface NotifyOptions {
	stderr?: boolean | "errors";
}

type WidgetContent =
	| string[]
	| ((tui: TUI, theme: Theme) => Component & { dispose?(): void })
	| undefined;

export interface SessionSnapshot {
	readonly rawContext: ExtensionContext;
	readonly cwd: string;
	readonly hasUI: boolean;
	readonly mode: ExtensionContext["mode"] | undefined;
	readonly callSignal: AbortSignal | undefined;
	readonly sessionSignal: AbortSignal;
	readonly signal: AbortSignal;
	isIdle(): boolean | undefined;
	shutdown(): void;
	notify(message: string, type?: NotifyLevel, options?: NotifyOptions): void;
	setStatus(key: string, text: string | undefined): void;
	setWidget: ExtensionUIContext["setWidget"];
	select: ExtensionUIContext["select"];
	custom: ExtensionUIContext["custom"];
	branch(): SessionEntry[] | undefined;
	sessionDir(): string | undefined;
	sessionId(): string | undefined;
	leafProjection():
		| {
				leaf: string | null;
				messages: ReturnType<
					ExtensionContext["sessionManager"]["buildSessionProjection"]
				>["messages"];
		  }
		| undefined;
}

interface VoidEventMap {
	session_start: SessionStartEvent;
	session_compact: SessionCompactEvent;
	session_shutdown: SessionShutdownEvent;
	session_tree: SessionTreeEvent;
	agent_end: AgentEndEvent;
	agent_settled: AgentSettledEvent;
	turn_start: TurnStartEvent;
	tool_execution_start: ToolExecutionStartEvent;
	tool_execution_update: ToolExecutionUpdateEvent;
	tool_execution_end: ToolExecutionEndEvent;
}

interface ResultEventMap {
	before_agent_start: [BeforeAgentStartEvent, BeforeAgentStartEventResult];
	turn_end: [TurnEndEvent, TurnEndEventResult];
	tool_result: [ToolResultEvent, ToolResultEventResult];
	input: [InputEvent, InputEventResult];
}

type VoidHandler<E, S> =
	| ((event: E, snap: S) => void)
	| ((event: E, snap: S) => Promise<void>);

type ResultHandler<E, R, S> = (
	event: E,
	snap: S,
) => Promise<R | undefined> | R | undefined;

type BoundToolDefinition<
	TParams extends TSchema = TSchema,
	TDetails = unknown,
> = Omit<ToolDefinition<TParams, TDetails>, "execute"> & {
	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		snap: SessionSnapshot,
	): Promise<AgentToolResult<TDetails>>;
};

export interface BoundSession {
	readonly signal: AbortSignal;
	on<
		K extends Exclude<keyof VoidEventMap, "session_start" | "session_shutdown">,
	>(
		event: K,
		handler: VoidHandler<VoidEventMap[K], SessionSnapshot>,
	): void;
	on<K extends keyof ResultEventMap>(
		event: K,
		handler: ResultHandler<
			ResultEventMap[K][0],
			ResultEventMap[K][1],
			SessionSnapshot
		>,
	): void;
	onLifecycle<K extends keyof VoidEventMap>(
		event: K,
		handler: VoidHandler<VoidEventMap[K], SessionSnapshot | undefined>,
	): void;
	onLifecycle<K extends keyof ResultEventMap>(
		event: K,
		handler: ResultHandler<
			ResultEventMap[K][0],
			ResultEventMap[K][1],
			SessionSnapshot | undefined
		>,
	): void;
	registerCommand(
		name: string,
		options: Omit<RegisteredCommand, "name" | "sourceInfo" | "handler"> & {
			handler: (args: string, snap: SessionSnapshot) => Promise<void>;
		},
	): void;
	registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(
		tool: BoundToolDefinition<TParams, TDetails>,
	): void;
	appendEntry<T = unknown>(customType: string, data?: T): boolean;
	registerMcpServer(name: string, config: McpServerConfig): void;
}

function makeAbortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function isStaleSessionError(error: unknown): boolean {
	return error instanceof Error && /stale after session/i.test(error.message);
}

export function captureSnapshot(
	ctx: ExtensionContext | ExtensionCommandContext | undefined,
	sessionSignal: AbortSignal,
): SessionSnapshot | undefined {
	if (!ctx || typeof ctx !== "object") return undefined;
	let hasUI: boolean;
	let cwd: string;
	let mode: ExtensionContext["mode"] | undefined;
	let callSignal: AbortSignal | undefined;
	let ui: ExtensionUIContext | undefined;
	try {
		hasUI = Boolean(ctx.hasUI);
		cwd = typeof ctx.cwd === "string" ? ctx.cwd : "";
		mode = ctx.mode;
		callSignal = ctx.signal;
		ui = hasUI ? ctx.ui : undefined;
	} catch {
		return undefined;
	}

	const combinedSignal = callSignal
		? AbortSignal.any([callSignal, sessionSignal])
		: sessionSignal;

	const setWidgetImpl = (
		key: string,
		content: WidgetContent,
		options?: ExtensionWidgetOptions,
	): void => {
		if (!hasUI || !ui) return;
		try {
			if (typeof content === "function") ui.setWidget(key, content, options);
			else ui.setWidget(key, content, options);
		} catch {}
	};

	const selectImpl: ExtensionUIContext["select"] = async (
		title,
		options,
		opts,
	) => {
		if (!hasUI || !ui) return undefined;
		return ui.select(title, options, opts);
	};

	const customImpl: ExtensionUIContext["custom"] = async <T>(
		factory: Parameters<ExtensionUIContext["custom"]>[0],
		options?: Parameters<ExtensionUIContext["custom"]>[1],
	): Promise<T> => {
		if (!hasUI || !ui) {
			throw new Error("Interactive terminal UI is unavailable.");
		}
		return ui.custom<T>(factory as Parameters<typeof ui.custom<T>>[0], options);
	};

	return {
		rawContext: ctx,
		cwd,
		hasUI,
		mode,
		callSignal,
		sessionSignal,
		signal: combinedSignal,
		isIdle(): boolean | undefined {
			try {
				return ctx.isIdle();
			} catch {
				return undefined;
			}
		},
		shutdown(): void {
			if (!("shutdown" in ctx) || typeof ctx.shutdown !== "function") return;
			try {
				ctx.shutdown();
			} catch {}
		},
		notify(message: string, type?: NotifyLevel, options?: NotifyOptions): void {
			if (sessionSignal.aborted) return;
			if (hasUI) {
				try {
					ui?.notify(message, type);
				} catch {}
				return;
			}
			const stderrMode = options?.stderr;
			if (
				stderrMode === true ||
				(stderrMode === "errors" && type === "error")
			) {
				// Pi headless JSON and RPC modes reserve stdout for protocol frames, so headless diagnostics go to stderr.
				process.stderr.write(`${message}\n`);
			}
		},
		setStatus(key: string, text: string | undefined): void {
			if (!hasUI || !ui) return;
			try {
				ui.setStatus(key, text);
			} catch {}
		},
		setWidget: setWidgetImpl as ExtensionUIContext["setWidget"],
		select: selectImpl,
		custom: customImpl,
		branch(): SessionEntry[] | undefined {
			try {
				return ctx.sessionManager.getBranch();
			} catch {
				return undefined;
			}
		},
		sessionDir(): string | undefined {
			try {
				return ctx.sessionManager.getSessionDir();
			} catch {
				return undefined;
			}
		},
		sessionId(): string | undefined {
			try {
				return ctx.sessionManager.getSessionId();
			} catch {
				return undefined;
			}
		},
		leafProjection() {
			try {
				return {
					leaf: ctx.sessionManager.getLeafId(),
					messages: ctx.sessionManager.buildSessionProjection().messages,
				};
			} catch {
				return undefined;
			}
		},
	};
}

function runSequence<E>(
	handlers: ReadonlyArray<VoidHandler<E, SessionSnapshot | undefined>>,
	event: E,
	snap: SessionSnapshot | undefined,
): Promise<void> | undefined {
	let chain: Promise<void> | undefined;
	for (const handler of handlers) {
		if (chain) {
			chain = chain.then(() => handler(event, snap));
		} else {
			const result = handler(event, snap);
			if (result instanceof Promise) chain = result;
		}
	}
	return chain;
}

export function bindSession(pi: ExtensionAPI): BoundSession {
	let lifetime = new AbortController();
	const startHandlers: Array<
		VoidHandler<SessionStartEvent, SessionSnapshot | undefined>
	> = [];
	const shutdownHandlers: Array<
		VoidHandler<SessionShutdownEvent, SessionSnapshot | undefined>
	> = [];

	if (typeof pi.on === "function") {
		pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
			lifetime.abort();
			lifetime = new AbortController();
			const snap = captureSnapshot(ctx, lifetime.signal);
			return runSequence(startHandlers, event, snap);
		});
		pi.on(
			"session_shutdown",
			(event: SessionShutdownEvent, ctx: ExtensionContext) => {
				const snap = captureSnapshot(ctx, lifetime.signal);
				lifetime.abort();
				return runSequence(shutdownHandlers, event, snap);
			},
		);
	}

	type RawListener = (event: never, ctx: ExtensionContext) => unknown;
	const registerRawEvent = (event: string, listener: RawListener): void => {
		if (typeof pi.on !== "function") return;
		(pi.on as (name: string, fn: RawListener) => () => void)(event, listener);
	};

	const onImpl = (
		event: string,
		handler: (event: never, snap: SessionSnapshot) => unknown,
	): void => {
		registerRawEvent(event, (ev, ctx) => {
			const snap = captureSnapshot(ctx, lifetime.signal);
			if (!snap) return undefined;
			return handler(ev, snap);
		});
	};

	const onLifecycleImpl = (
		event: string,
		handler: (event: never, snap: SessionSnapshot | undefined) => unknown,
	): void => {
		if (event === "session_start") {
			startHandlers.push(
				handler as VoidHandler<SessionStartEvent, SessionSnapshot | undefined>,
			);
			return;
		}
		if (event === "session_shutdown") {
			shutdownHandlers.push(
				handler as VoidHandler<
					SessionShutdownEvent,
					SessionSnapshot | undefined
				>,
			);
			return;
		}
		registerRawEvent(event, (ev, ctx) =>
			handler(ev, captureSnapshot(ctx, lifetime.signal)),
		);
	};

	return {
		get signal(): AbortSignal {
			return lifetime.signal;
		},
		on: onImpl as BoundSession["on"],
		onLifecycle: onLifecycleImpl as BoundSession["onLifecycle"],
		registerCommand(name, options): void {
			const { handler, ...rest } = options;
			pi.registerCommand(name, {
				...rest,
				handler: async (
					args: string,
					ctx: ExtensionCommandContext,
				): Promise<void> => {
					const snap = captureSnapshot(ctx, lifetime.signal);
					if (!snap) return;
					await handler(args, snap);
				},
			});
		},
		registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(
			tool: BoundToolDefinition<TParams, TDetails>,
		): void {
			const { execute, ...rest } = tool;
			pi.registerTool<TParams, TDetails>({
				...rest,
				execute: async (
					toolCallId: string,
					params: Static<TParams>,
					signal: AbortSignal | undefined,
					onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
					ctx: ExtensionToolContext,
				): Promise<AgentToolResult<TDetails>> => {
					const snap = captureSnapshot(ctx, lifetime.signal);
					if (!snap) throw makeAbortError("Session is no longer active.");
					return execute(toolCallId, params, signal, onUpdate, snap);
				},
			});
		},
		appendEntry<T = unknown>(customType: string, data?: T): boolean {
			try {
				pi.appendEntry(customType, data);
				return true;
			} catch {
				return false;
			}
		},
		registerMcpServer(name: string, config: McpServerConfig): void {
			try {
				pi.registerMcpServer(name, config);
			} catch (error: unknown) {
				if (lifetime.signal.aborted || isStaleSessionError(error)) return;
				throw error;
			}
		},
	};
}
