import assert from "node:assert/strict";
import test from "node:test";
import trace from "../index.ts";

const text = (value) => ({ type: "text", text: value });
const entry = (id, name, isError, content = [text(`diagnostic ${id}`)]) => ({
	type: "message",
	id,
	timestamp: "2026-11-21T01:02:03Z",
	message: {
		role: "toolResult",
		toolName: name,
		isError,
		content,
		details: { onlyInDetails: "private-detail" },
	},
});

function harness(entries, pick = (_title, options) => options[0]) {
	const notices = [],
		pages = [];
	let handler;
	const events = new Map();
	trace({
		on: (name, fn) => events.set(name, fn),
		registerCommand(name, command) {
			assert.equal(name, "trace");
			handler = command.handler;
		},
	});
	const ctx = {
		hasUI: true,
		sessionManager: { getBranch: () => entries },
		ui: {
			select(title, options, { signal }) {
				pages.push(options);
				return pick(title, options, pages.length, signal);
			},
			notify(message) {
				notices.push(message);
			},
		},
	};
	return {
		ctx,
		notices,
		pages,
		events,
		run: (args = "") => handler(args, ctx),
	};
}

test("failed picker uses exact tool and Pi's flag, newest first, without showing arguments or diagnostics", async () => {
	const entries = [
		entry("old", "bash", true),
		entry("ok", "bash", false, [text("error: pretend failure")]),
		entry("other", "bash_aux", true),
		{ type: "custom", data: "hidden" },
		{
			type: "message",
			message: {
				role: "bashExecution",
				command: "private-command",
				exitCode: 1,
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "private-thought" }],
			},
		},
		entry("new", "bash", true),
	];
	const h = harness(entries, (_t, opts) => opts[1]);
	await h.run("failed bash");
	assert.deepEqual(h.pages[0], [
		"1. failed bash · 2026-11-21T01:02:03Z · #new",
		"2. failed bash · 2026-11-21T01:02:03Z · #old",
	]);
	assert.deepEqual(h.notices, [
		"2. failed bash · 2026-11-21T01:02:03Z · #old\ndiagnostic old",
	]);
	const all = harness(entries, () => undefined);
	await all.run();
	assert.equal(all.pages[0].length, 4);
	assert.match(all.pages[0][2], /ok bash .*#ok$/);
	assert.deepEqual(all.notices, []);
});

test("tree navigation or session replacement cancels an open picker, including a late RPC reply", async () => {
	for (const event of ["session_tree", "session_shutdown"]) {
		const h = harness(
			[entry("one", "read", true)],
			(_t, options, _n, signal) =>
				new Promise((resolve) => {
					signal.addEventListener("abort", () => resolve(options[0]), {
						once: true,
					});
				}),
		);
		const command = h.run();
		h.events.get(event)();
		await command;
		assert.deepEqual(h.notices, []);
	}
});

test("older and newer pages preserve access to every result even with duplicate times", async () => {
	const entries = Array.from({ length: 55 }, (_, i) =>
		entry(String(i), "read", true),
	);
	const h = harness(entries, (_t, opts, n) =>
		n <= 2
			? opts.find((s) => s.startsWith("Older"))
			: n === 3
				? opts.find((s) => s.includes("Newer"))
				: opts[0],
	);
	await h.run("failed");
	assert.deepEqual(
		h.pages.map((p) => p.length),
		[26, 27, 6, 27],
	);
	assert.match(h.notices[0], /#29\ndiagnostic 29$/);
});

test("preview redacts known credentials, strips controls, and excludes images and details", async () => {
	const h = harness([
		{
			...entry("\u200B", "\u200B", false),
			timestamp: "\u200B",
		},
		entry("id", "b\x1b[31mash\x1b[0m", true, [
			text("\x1b[2Jfailure\x07"),
			{ type: "image", data: "private-image" },
			text("Authorization: Bearer Top.Secret123\npassword=DontEchoMe\n終"),
		]),
	]);
	await h.run();
	assert.equal(h.pages[0][1], "2. ok ? · ? · #?");
	assert.equal(
		h.notices[0].split("\n").slice(1).join("\n"),
		"failure\nAuthorization: Bearer [REDACTED]\npassword=[REDACTED]\n終",
	);
	assert.doesNotMatch(
		JSON.stringify(h.pages),
		/private|Top.Secret|DontEcho|Authorization|failure/,
	);
});

test("preview marks truncated text, keeps final diagnostics, and never follows a named path", async () => {
	const h = harness([
		entry("id", "bash", true, [
			text("noisy prefix\n".repeat(10000)),
			text("\nlast error\nFull output: /does/not/exist"),
		]),
	]);
	await h.run();
	assert.match(h.notices[0], /\[Last output only\]/);
	assert.ok(h.notices[0].split("\n").length <= 22);
	assert.ok(h.notices[0].length < 4120);
	assert.match(h.notices[0], /last error\nFull output: \/does\/not\/exist$/);
	for (const size of [16_383, 16_384]) {
		const marker = "intact-tail-marker";
		const boundary = harness([
			entry("id", "bash", true, [
				text("dropped earlier block"),
				text("a".repeat(size - marker.length) + marker),
			]),
		]);
		await boundary.run();
		assert.match(boundary.notices[0], /\[Last output only\]/);
		assert.ok(boundary.notices[0].endsWith(marker));
		assert.doesNotMatch(
			boundary.notices[0],
			/No displayable text|dropped earlier/,
		);
	}
	for (const blocks of [
		null,
		[],
		[{ type: "image", data: "not-text" }],
		[text("X".repeat(20000))],
	]) {
		const h = harness([entry("id", "read", true, blocks)]);
		await h.run();
		assert.match(h.notices[0], /No displayable text/);
		assert.doesNotMatch(h.notices[0], /not-text|XXXXX/);
	}
});

test("empty, invalid, cancelled, stale and forged choices do not disclose a preview", async () => {
	const rows = [entry("one", "read", true)];
	const empty = harness(rows);
	await empty.run("failed bash");
	await empty.run("typo");
	await empty.run("failed read extra");
	assert.deepEqual(empty.notices, [
		"No matching tool results on this branch.",
		"Usage: /trace [failed [tool]]",
		"Usage: /trace [failed [tool]]",
	]);
	assert.equal(empty.pages.length, 0);
	for (const value of [undefined, "unoffered choice"]) {
		const h = harness(rows, () => value);
		await h.run();
		assert.deepEqual(h.notices, []);
	}
	const h = harness(rows, (_t, opts) => {
		rows.length = 0;
		return opts[0];
	});
	await h.run();
	assert.deepEqual(h.notices, [
		"The selected result is no longer on this branch.",
	]);
	h.ctx.hasUI = false;
	await assert.rejects(h.run(), /requires an interactive/);
});
