import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import rtkGain from "../index.ts";

const gain = (commands, before, after, saved) => ({
	summary: { total_commands: commands, total_input: before, total_output: after, total_saved: saved },
});
const ok = (value) => ({ stdout: JSON.stringify(value), stderr: "", code: 0, killed: false, truncated: false });
const exit = (code, stderr = "private diagnostic") => ({ stdout: "", stderr, code, killed: false, truncated: false });
const failure = exit(1);
const enoent = (bin) => exit(1, `spawn ${bin} ENOENT`);
const rtkArgs = ["gain", "--format", "json"];

function load(exec, hasUI = true) {
	const events = new Map();
	const calls = [], notices = [], statuses = [];
	let handler, active = true;
	const guard = () => { if (!active) throw new Error("stale extension ctx"); };
	const ctx = {
		get cwd() { guard(); return "/project"; },
		get hasUI() { guard(); return hasUI; },
		get ui() {
			guard();
			return {
				notify: (text, level) => notices.push([text, level]),
				setStatus: (key, text) => { assert.equal(key, "rtk-gain"); statuses.push(text); },
			};
		},
	};
	rtkGain({
		on: (event, fn) => events.set(event, fn),
		registerCommand: (name, command) => { assert.equal(name, "rtk-gain"); handler = command.handler; },
		exec: (bin, args, opts) => {
			assert.equal(opts.cwd, "/project");
			assert.ok(opts.timeout > 0 && opts.maxBuffer > 0);
			calls.push([bin, ...args]);
			return exec(bin, args, opts);
		},
	});
	return {
		calls, notices, statuses,
		invalidate: () => { active = false; },
		command: (args = "") => handler(args, ctx),
		fire: (event, payload = {}) => events.get(event)(payload, ctx),
	};
}

test("local footer tracks startup, tool-using turns, and settlement; details use exact counts", async () => {
	let value = gain(30, 33_000, 21_000, 12_375);
	const pi = load(() => ok(value));
	assert.deepEqual(pi.calls, []);
	pi.fire("session_start");
	await setImmediate();
	assert.deepEqual(pi.statuses, ["RTK: 12.4K tokens saved (37.5%)"]);
	await pi.command();
	assert.deepEqual(pi.notices, [["Local RTK gain: 12,375 tokens saved (37.5%)\n  30 commands | 33,000 tokens before / 21,000 after", "info"]]);
	// Text-only turns skip unnecessary reads; tool-using turns refresh live.
	pi.fire("turn_end", { toolResults: [] });
	await setImmediate();
	assert.equal(pi.calls.length, 2);
	value = gain(1, 10, 9, 1);
	pi.fire("turn_end", { toolResults: [{}] });
	await setImmediate();
	assert.equal(pi.statuses.at(-1), "RTK: 1 token saved (10.0%)");
	value = gain(0, 0, 0, 0);
	pi.fire("agent_settled", { aborted: false });
	await setImmediate();
	assert.equal(pi.statuses.at(-1), "RTK: 0 tokens saved (0.0%)");
	assert.deepEqual(pi.calls, Array(4).fill(["rtk", ...rtkArgs]));
	await pi.fire("session_shutdown");
	assert.equal(pi.statuses.at(-1), undefined);
});

test("all queries running guests in parallel, weights savings, and distinguishes guest exit codes", async () => {
	const boxes = [
		{ name: "one", status: "running" },
		{ name: "sleeping", status: "stopped" },
		{ name: "bare", status: "running" },
		{ name: "broken", status: "running" },
	];
	let inFlight = 0, peak = 0;
	const replies = {
		one: ok(gain(3, 900, 810, 90)),
		bare: exit(127),
		broken: exit(125),
	};
	const pi = load(async (bin, args) => {
		if (bin === "rtk") return ok(gain(2, 100, 60, 50));
		if (args.includes("ls")) return ok(boxes);
		inFlight++;
		peak = Math.max(peak, inFlight);
		await setImmediate();
		inFlight--;
		return replies[args[3]];
	});
	await pi.command(" all ");
	assert.equal(peak, 3);
	assert.deepEqual(pi.calls, [
		["rtk", ...rtkArgs], ["sbx", "--no-input", "ls", "--json"],
		...["one", "bare", "broken"].map(name => ["sbx", "--no-input", "exec", "--", name, "rtk", ...rtkArgs]),
	]);
	assert.deepEqual(pi.statuses, ["RTK: 50 tokens saved (50.0%)"]);
	assert.deepEqual(pi.notices, [[[
		"Total (reported only): 140 tokens saved (14.0%)", "  5 commands | 1,000 tokens before / 870 after",
		"Local: 50 tokens saved (50.0%)", "  2 commands | 100 tokens before / 60 after",
		"Sandbox one: 90 tokens saved (10.0%)", "  3 commands | 900 tokens before / 810 after",
		"Sandbox sleeping: excluded (stopped)",
		"Sandbox bare: excluded (rtk not found in sandbox)",
		"Sandbox broken: excluded (sbx could not run rtk)",
	].join("\n"), "warning"]]);
});

test("complete all report labels Total cleanly; empty or null sandbox list reports none", async () => {
	const full = load((bin, args) => {
		if (bin === "rtk") return ok(gain(1, 100, 80, 20));
		return args.includes("ls") ? ok([{ name: "dev", status: "running" }]) : ok(gain(1, 100, 50, 50));
	});
	await full.command("all");
	assert.deepEqual(full.notices, [[[
		"Total: 70 tokens saved (35.0%)", "  2 commands | 200 tokens before / 130 after",
		"Local: 20 tokens saved (20.0%)", "  1 command | 100 tokens before / 80 after",
		"Sandbox dev: 50 tokens saved (50.0%)", "  1 command | 100 tokens before / 50 after",
	].join("\n"), "info"]]);

	for (const empty of [[], null]) {
		const pi = load((bin) => bin === "rtk" ? ok(gain(1, 50, 10, 40)) : ok(empty));
		await pi.command("all");
		assert.deepEqual(pi.notices, [[[
			"Local: 40 tokens saved (80.0%)", "  1 command | 50 tokens before / 10 after",
			"Sandboxes: none",
		].join("\n"), "info"]]);
	}
});

test("ENOENT reports missing binary clearly and bad inventory cannot supply argv or terminal text", async () => {
	const missingRtk = load(() => enoent("rtk"));
	await missingRtk.command();
	assert.deepEqual(missingRtk.notices, [["Local RTK gain unavailable: rtk not found. Check rtk gain --format json.", "error"]]);

	for (const inventory of [enoent("sbx"), failure, ok([{ name: "--bad\ncontrols", status: "running" }]), ok({})]) {
		const pi = load(bin => bin === "rtk" ? ok(gain(1, 50, 10, 40)) : inventory);
		await pi.command("all");
		assert.equal(pi.calls.length, 2);
		const [[text, level]] = pi.notices;
		assert.equal(level, "warning");
		assert.match(text, /^Total \(reported only\): 40 tokens saved \(80\.0%\)/);
		assert.match(text, /Sandboxes: excluded/);
		if (inventory.stderr?.includes("ENOENT")) assert.match(text, /sbx not found/);
		assert.doesNotMatch(text, /private diagnostic|controls/);
	}
});

test("query failures clear the footer quietly and report errors on request, never fake zero", async () => {
	for (const bad of [failure, { ...ok({}), stdout: "not json" }, ok({ summary: {} }), ok(gain(1, 5, 1, 6)),
		ok(gain(1, 5, 1, "4")), ok(gain(1, 5, 1, -1)), { ...ok(gain(1, 5, 1, 4)), truncated: true },
		{ ...ok({}), killed: true }, () => { throw Error("private exception"); }]) {
		const pi = load(typeof bad === "function" ? bad : () => bad);
		pi.fire("session_start");
		await setImmediate();
		assert.deepEqual(pi.notices, []);
		assert.deepEqual(pi.statuses, [undefined]);
		await pi.command();
		const [[text, level]] = pi.notices;
		assert.equal(level, "error");
		assert.match(text, /Local RTK gain unavailable/);
		assert.doesNotMatch(text, /private|0 tokens saved/);
	}
});

test("all still reads running guests if host RTK is absent; no reports is not zero savings", async () => {
	for (const guests of [[], [{ name: "dev", status: "running" }]]) {
		const pi = load((bin, args) => {
			if (bin === "rtk") return enoent("rtk");
			return args.includes("ls") ? ok(guests) : ok(gain(0, 0, 0, 0));
		});
		await pi.command("all");
		const [[text, level]] = pi.notices;
		assert.match(text, /Local: excluded \(rtk not found\)/);
		assert.equal(level, guests.length ? "warning" : "error");
		if (guests.length) assert.match(text, /^Total \(reported only\): 0 tokens saved \(0.0%\)/);
		else assert.match(text, /^No RTK gains available\./);
	}
});

test("mid-flight refresh queues one follow-up and commands never return a stale snapshot", async () => {
	const resolvers = [];
	const pi = load(() => new Promise(resolve => { resolvers.push(resolve); }));
	pi.fire("session_start");
	pi.fire("turn_end", { toolResults: [{}] });
	pi.fire("agent_settled", { aborted: false });
	assert.equal(pi.calls.length, 1);
	resolvers.shift()(ok(gain(1, 100, 90, 10)));
	await setImmediate();
	assert.equal(pi.calls.length, 2);
	const command = pi.command();
	assert.equal(pi.calls.length, 2);
	resolvers.shift()(ok(gain(2, 100, 80, 20)));
	await setImmediate();
	assert.equal(pi.calls.length, 3);
	resolvers.shift()(ok(gain(3, 100, 70, 30)));
	await command;
	assert.deepEqual(pi.statuses, [
		"RTK: 10 tokens saved (10.0%)",
		"RTK: 20 tokens saved (20.0%)",
		"RTK: 30 tokens saved (30.0%)",
	]);
	assert.match(pi.notices[0][0], /^Local RTK gain: 30 tokens saved \(30\.0%\)/);
});

test("shutdown aborts in-flight read and never touches a stale context afterward", async () => {
	let finish, signal;
	const pi = load((_bin, _args, opts) => {
		signal = opts.signal;
		return new Promise(resolve => { finish = resolve; });
	});
	pi.fire("session_start");
	pi.fire("agent_settled", { aborted: false });
	const command = pi.command();
	assert.equal(pi.calls.length, 1);
	const shutdown = pi.fire("session_shutdown");
	assert.equal(signal.aborted, true);
	pi.invalidate();
	finish(ok(gain(2, 5, 0, 5)));
	await Promise.all([command, shutdown]);
	assert.equal(pi.calls.length, 1);
	assert.deepEqual(pi.statuses, [undefined]);
	assert.deepEqual(pi.notices, []);
});

test("headless lifecycle and unsupported arguments never run a subprocess", async () => {
	const headless = load(() => assert.fail("unexpected query"), false);
	for (const event of ["session_start", "agent_settled", "session_shutdown"]) await headless.fire(event);
	await headless.fire("turn_end", { toolResults: [{}] });
	assert.deepEqual(headless.statuses, []);
	const pi = load(() => assert.fail("unexpected query"));
	await pi.command("--reset");
	assert.deepEqual(pi.calls, []);
	assert.deepEqual(pi.notices, [["Usage: /rtk-gain [all]", "error"]]);
});
