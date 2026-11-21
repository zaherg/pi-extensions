import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { displayLabel } from "../../shared/display.ts";

// Pi supplies this peer at runtime, including for source checkouts with no node_modules.
const host = createRequire(
	process.env.PI_PACKAGE_ROOT
		? join(process.env.PI_PACKAGE_ROOT, "package.json")
		: import.meta.url,
);
const tui = host.resolve("@earendil-works/pi-tui");
const hooks = registerHooks({
	resolve(name, ctx, next) {
		return next(name === "@earendil-works/pi-tui" ? tui : name, ctx);
	},
});
const { default: workerBoard } = await import("../index.ts");
hooks.deregister();
const { visibleWidth } = await import(pathToFileURL(tui).href);

const call = (id, args) => ({
	type: "toolCall",
	name: "subagent",
	id,
	arguments: args,
});
const dispatch = (...content) => ({
	type: "message",
	message: { role: "assistant", content },
});
const result = (id, toolCallId, details, isError = false) => ({
	type: "message",
	id,
	message: {
		role: "toolResult",
		toolName: "subagent",
		toolCallId,
		details,
		isError,
	},
});
const details = (mode, ...results) => ({ mode, results });
const worker = (agent, status, fields) => ({ agent, status, ...fields });
const task = (agent, task) => ({ agent, task });

function harness() {
	const events = new Map(),
		widgets = [],
		notices = [];
	let handler;
	workerBoard({
		on: (name, fn) => events.set(name, fn),
		registerCommand(name, cmd) {
			assert.equal(name, "workers");
			handler = cmd.handler;
		},
	});
	const h = {
		branch: [],
		widgets,
		notices,
		ctx: {
			mode: "rpc",
			hasUI: true,
			sessionManager: { getBranch: () => h.branch },
			ui: {
				setWidget(key, lines) {
					assert.equal(key, "worker-board");
					widgets.push(lines);
				},
				notify(message) {
					notices.push(message);
				},
			},
		},
		run: (args = "") => handler(args, h.ctx),
		emit: (name, fields = {}) =>
			events.get(name)(
				{ type: name, toolName: "subagent", toolCallId: "c", ...fields },
				h.ctx,
			),
		show: () => widgets.at(-1)?.join("\n") ?? "",
	};
	return h;
}

test("Pi's installed example runner supplies compatible partial and final reports", {
	skip: !process.env.PI_PACKAGE_ROOT,
}, async (t) => {
	const root = process.env.PI_PACKAGE_ROOT;
	const dir = await mkdtemp(join(tmpdir(), "pi-board-contract-"));
	const original = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(async () => {
		if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = original;
		await rm(dir, { recursive: true, force: true });
	});
	const { loadExtensions } = await import(
		pathToFileURL(join(root, "dist/core/extensions/loader.js")).href
	);
	const loaded = await loadExtensions(
		[join(root, "examples/extensions/subagent/index.ts")],
		dir,
	);
	assert.deepEqual(loaded.errors, []);
	const runner = loaded.extensions[0].tools.get("subagent").definition;
	const args = {
		tasks: [task("missing-a", "First task"), task("missing-b", "Second task")],
	};
	const h = harness();
	await h.run();
	h.emit("tool_execution_start", { args });
	// Missing workers exercise the real runner without spawning a child or contacting a provider.
	const output = await runner.execute(
		"c",
		args,
		undefined,
		(partialResult) => h.emit("tool_execution_update", { partialResult }),
		{ cwd: dir, hasUI: false },
	);
	assert.ok(
		h.widgets.some((lines) =>
			lines?.some((line) => line.startsWith("pending missing-b")),
		),
	);
	assert.equal(output.details.isError, true);
	h.emit("tool_execution_end", { result: output, isError: true });
	assert.match(h.show(), /failed missing-a #c\/1 · First task/);
	assert.match(h.show(), /failed missing-b #c\/2 · Second task/);
});

test("terminal widget fits long Unicode assignments at narrow and wide widths", async () => {
	const h = harness();
	h.ctx.mode = "tui";
	const agent = "scout",
		items = Array.from({ length: 8 }, () =>
			task(agent, "Review 界🧪".repeat(22)),
		);
	h.branch = [
		dispatch(call("c", { tasks: items })),
		result(
			"s",
			"c",
			details(
				"parallel",
				...items.map((_, i) =>
					worker(agent, i === 7 ? "blocked" : "completed"),
				),
			),
		),
	];
	await h.run();
	const widget = h.widgets.at(-1)();
	for (const width of [16, 45, 110]) {
		const lines = widget.render(width);
		assert.ok(lines.some((line) => line.includes("blocked")));
		assert.ok(
			lines.length <= 16 && lines.every((line) => visibleWidth(line) <= width),
		);
	}
});

test("opens mid-run, updates without polling, restores result evidence, and hides", async () => {
	const h = harness(),
		args = {
			tasks: [task("scout", "Inspect parser"), task("scout", "Inspect UI")],
		};
	h.emit("tool_execution_start", { args });
	h.emit("tool_execution_update", {
		partialResult: { details: details("parallel") },
	});
	const update = details(
		"parallel",
		worker("scout", "running", {
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							name: "read",
							arguments: { path: "tool-args-secret" },
						},
					],
				},
			],
		}),
		worker("scout", "pending"),
	);
	await h.run();
	assert.match(h.show(), /#c Awaiting worker report\./);
	h.emit("tool_execution_update", { partialResult: { details: update } });
	assert.deepEqual(h.widgets.at(-1), [
		"Workers · current batch · 1/1",
		"running scout #c/1 · Inspect parser · last: read",
		"pending scout #c/2 · Inspect UI",
		"/workers hide: close",
	]);
	h.emit("tool_execution_update", { partialResult: { details: update } });
	assert.equal(h.widgets.length, 2, "unchanged reports must not redraw");
	const final = details(
		"parallel",
		worker("scout", "completed"),
		worker("scout", "failed"),
	);
	h.emit("tool_execution_end", { result: { details: final }, isError: true });
	assert.match(h.widgets.at(-1)[1], /^failed scout #c\/2/);
	h.branch = [dispatch(call("c", args)), result("final", "c", final, true)];
	h.emit("turn_start");
	assert.match(h.show(), /last recorded batch/);
	assert.match(h.show(), /failed scout #final\/2 · Inspect UI/);
	assert.match(h.show(), /completed scout #final\/1 · Inspect parser/);
	await h.run("hide");
	assert.equal(h.widgets.at(-1), undefined);
	h.emit("session_tree");
	assert.equal(h.widgets.at(-1), undefined);
});

test("interleaved top-level calls survive as a batch; unrelated, nested and old calls stay out", async () => {
	const h = harness(),
		a = task("writer", "Implement"),
		b = task("reader", "Review");
	h.branch = [
		dispatch(call("old", a)),
		result(
			"oldresult",
			"old",
			details("single", worker("old-agent", "completed")),
		),
	];
	await h.run();
	for (const props of [{ toolName: "other" }, { parentToolCallId: "parent" }]) {
		h.emit("tool_execution_start", { args: a, ...props });
		h.emit("tool_execution_end", { result: {}, ...props });
	}
	assert.equal(h.widgets.length, 1);
	h.emit("tool_execution_start", { toolCallId: "a", args: a });
	h.emit("tool_execution_start", { toolCallId: "b", args: b });
	const blocked = details(
		"single",
		worker("reader", "blocked", { blocker: "Needs approval" }),
	);
	const ok = details("single", worker("writer", "completed"));
	h.emit("tool_execution_update", {
		toolCallId: "b",
		partialResult: { details: blocked },
	});
	h.emit("tool_execution_end", { toolCallId: "a", result: { details: ok } });
	assert.match(
		h.show(),
		/blocked reader #b\/1 · blocked by: Needs approval · Review/,
	);
	assert.match(h.show(), /completed writer #a\/1/);
	h.branch.push(
		dispatch(call("a", a), call("b", b)),
		result("first", "a", ok),
		result("second", "b", blocked),
	);
	h.emit("agent_end");
	assert.match(h.show(), /#second\/1/);
	assert.match(h.show(), /#first\/1/);
	assert.doesNotMatch(h.show(), /oldresult/);
	// An aborted assistant stream persists a subagent call without starting tool execution.
	h.branch.push(dispatch(call("aborted-stream", b)));
	h.emit("agent_end");
	assert.match(h.show(), /#aborted-stream No worker outcome recorded/);
	h.branch = [
		{ type: "message", message: { role: "assistant", content: null } },
		dispatch(call("dup", a)),
		result("older", "dup", details("single", worker("writer", "failed")), true),
		result("newer", "dup", ok),
	];
	h.emit("session_tree");
	assert.match(h.show(), /completed writer #newer\/1/);
	assert.doesNotMatch(h.show(), /#older/);
	h.branch = [];
	h.emit("session_tree");
	assert.match(h.show(), /No subagent calls on this branch/);
	h.emit("session_shutdown");
	assert.equal(h.widgets.at(-1), undefined);
});

test("chain previews are original assignments; output, thinking, details and controls stay out", async () => {
	const h = harness();
	const args = {
		chain: [
			task("a", "Find"),
			task("b", "Check {previous}\npassword=private-password\x1b[2J"),
		],
	};
	h.branch = [
		dispatch(call("chain", args)),
		result(
			"\u200B",
			"chain",
			details(
				"chain",
				worker("a", "completed"),
				worker("b", "aborted", {
					task: "Check private-result",
					stderr: "private-stderr",
					messages: [
						{
							role: "toolResult",
							toolName: "read",
							content: [{ type: "text", text: "private-text" }],
						},
						{
							role: "assistant",
							content: [
								{ type: "toolCall", name: "\u200B", arguments: {} },
								{ type: "thinking", thinking: "private-thinking" },
							],
						},
						{
							role: "toolResult",
							toolName: "\u200B",
							content: [{ type: "text", text: "private-text" }],
						},
					],
				}),
			),
			true,
		),
	];
	await h.run();
	assert.match(
		h.show(),
		/aborted b #\?\/2 · Check \{previous\} password=\[REDACTED\] · last: read/,
	);
	assert.doesNotMatch(h.show(), /private-/);
	assert.ok(!h.show().includes("\x1b"));
});

test("runner shape and failure are explicit; historical partials are not live or successful", async () => {
	const h = harness();
	for (const [data, error, expected] of [
		[undefined, true, "Call failed; no worker outcome reported."],
		[details("single"), true, "Call failed; no worker outcome reported."],
		[details("single"), false, "No worker outcome reported."],
		[
			{ results: [worker("a", "completed")] },
			false,
			"No compatible worker report.",
		],
		[
			details("single", { agent: "a", status: "toString" }),
			false,
			"unsupported report",
		],
		[
			details("single", { agent: "\u200B", status: "running" }),
			false,
			"unsupported report",
		],
		[
			details("single", { agent: "\u200B".repeat(1025), status: "running" }),
			false,
			"unsupported report",
		],
		[details("single", worker("a", "running")), false, "last reported running"],
		[details("single", worker("a", "pending")), false, "last reported pending"],
		[details("single", worker("a", "completed")), true, "Call failed."],
		[
			details("single", { agent: "\u200B", status: "failed" }),
			true,
			"Call failed.",
		],
	]) {
		h.branch = [
			dispatch(call("c", task("a", "Check"))),
			result("s", "c", data, error),
		];
		await h.run();
		assert.ok(h.show().includes(expected));
		assert.match(h.show(), /last recorded batch/);
	}
	h.branch = [
		dispatch(call("c1", task("a", "First")), call("c2", task("b", "Second"))),
		result("s1", "c1", details("single", worker("a", "blocked")), true),
		result("s2", "c2", details("single"), true),
	];
	await h.run();
	assert.equal(h.widgets.at(-1)[1], "#s1 Call failed.");
	assert.match(h.widgets.at(-1)[2], /^blocked a #s1\/1/);
	assert.equal(
		h.widgets.at(-1)[3],
		"#s2 Call failed; no worker outcome reported.",
	);
});

test("displayLabel hardens redaction across the 1,024-char boundary and keeps output well-formed", async () => {
	const bearerUrl = `Bearer ${"A".repeat(995)} https://u:topsecret99@host`;
	const quotedSecret = `Bearer ${"A".repeat(988)} password="my secret pass phrase" tail`;
	assert.equal(displayLabel(bearerUrl, 64), "Bearer [REDACTED]…");
	assert.equal(
		displayLabel(quotedSecret, 64),
		"Bearer [REDACTED] password=[REDACTED]…",
	);
	assert.equal(
		displayLabel('password="a" foo="b"', 64),
		'password=[REDACTED] foo="b"',
	);
	assert.equal(displayLabel(" ".repeat(1025), 32), "");
	assert.equal(displayLabel("\u200B".repeat(1025), 32), "");
	assert.equal(displayLabel("\x1b[31m".repeat(300), 32), "");
	assert.equal(displayLabel("x".repeat(1025), 32), "…");
	const emojiLabel = displayLabel("😀".repeat(20), 32);
	assert.equal(emojiLabel, `${"😀".repeat(15)}…`);
	assert.equal(emojiLabel.isWellFormed(), true);
	assert.equal(displayLabel("bad\uD800label", 32).isWellFormed(), true);
	const h = harness();
	h.branch = [
		dispatch(
			call("c", {
				tasks: [task("a", bearerUrl), task("b", quotedSecret)],
			}),
		),
		result(
			"s",
			"c",
			details("parallel", worker("a", "completed"), worker("b", "completed")),
		),
	];
	await h.run();
	assert.doesNotMatch(h.show(), /topsecret99|\b(?:my|secret|pass|phrase)\b/);
	assert.match(h.show(), /Bearer \[REDACTED\]…/);
	assert.match(h.show(), /Bearer \[REDACTED\] password=\[REDACTED\]…/);
});

test("paging does not lose rows; invalid commands do not change the board; no UI means no draw", async () => {
	const h = harness();
	const items = Array.from({ length: 15 }, (_, i) =>
		task("a", `Item ${i + 1}`),
	);
	h.branch = [
		dispatch(call("c", { chain: items })),
		result(
			"s",
			"c",
			details("chain", ...items.map(() => worker("a", "completed"))),
		),
	];
	for (let page = 1; page <= 3; page++) {
		await h.run(String(page));
		assert.equal(h.widgets.at(-1).length, page === 3 ? 5 : 8);
		assert.match(h.show(), new RegExp(`Item ${(page - 1) * 6 + 1}(\\n|$)`));
	}
	await h.run("4");
	await h.run("0");
	assert.deepEqual(h.notices, [
		"Worker board has 3 page(s).",
		"Usage: /workers [page|hide]",
	]);
	assert.equal(h.widgets.length, 3);
	h.branch = [];
	h.emit("session_tree");
	assert.match(h.show(), /1\/1/);
	h.ctx.hasUI = false;
	await assert.rejects(h.run(), /requires an interactive/);
});
