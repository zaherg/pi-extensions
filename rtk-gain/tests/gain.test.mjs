import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import rtkGain from "../index.ts";

const gain = (commands, before, after, saved) => ({
	summary: { total_commands: commands, total_input: before, total_output: after, total_saved: saved },
});
const ok = (value) => ({ stdout: JSON.stringify(value), stderr: "", code: 0, killed: false, truncated: false });
const failure = { ...ok(null), stderr: "private diagnostic", code: 1 };
const rtkArgs = ["gain", "--format", "json"];

function load(exec, hasUI = true) {
	const events = new Map();
	const calls = [], notices = [], statuses = [];
	let handler;
	const ctx = { cwd: "/project", hasUI, ui: {
		notify: (text, level) => notices.push([text, level]),
		setStatus: (key, text) => { assert.equal(key, "rtk-gain"); statuses.push(text); },
	} };
	rtkGain({
		on: (event, fn) => events.set(event, fn),
		registerCommand: (name, command) => { assert.equal(name, "rtk-gain"); handler = command.handler; },
		exec: (bin, args, opts) => {
			assert.equal(opts.cwd, ctx.cwd);
			assert.ok(opts.timeout > 0 && opts.maxBuffer > 0);
			calls.push([bin, ...args]);
			return exec(bin, args, opts);
		},
	});
	return { calls, notices, statuses, command: (args = "") => handler(args, ctx), fire: (event) => events.get(event)({}, ctx) };
}

test("local footer follows RTK at startup and after work; details use exact counts", async () => {
	let value = gain(30, 33_000, 21_000, 12_375);
	const pi = load(() => ok(value));
	assert.deepEqual(pi.calls, []);
	pi.fire("session_start");
	await setImmediate();
	assert.deepEqual(pi.statuses, ["RTK: 12.4K tokens saved (37.5%)"]);
	await pi.command();
	assert.deepEqual(pi.notices, [["Local RTK gain: 12,375 tokens saved (37.5%)\n  30 commands | 33,000 tokens before / 21,000 after", "info"]]);
	value = gain(0, 0, 0, 0);
	pi.fire("agent_settled");
	await setImmediate();
	assert.equal(pi.statuses.at(-1), "RTK: 0 tokens saved (0.0%)");
	assert.deepEqual(pi.calls, Array(3).fill(["rtk", ...rtkArgs]));
	await pi.fire("session_shutdown");
	assert.equal(pi.statuses.at(-1), undefined);
});

test("all weights RTK's reported savings, keeps the footer local, and excludes unreadable guests", async () => {
	const boxes = [ { name: "one", status: "running" }, { name: "sleeping", status: "stopped" }, { name: "broken", status: "running" } ];
	const replies = [ok(gain(2, 100, 60, 50)), ok(boxes), ok(gain(3, 900, 810, 90)), failure];
	const pi = load(() => replies.shift());
	await pi.command(" all ");
	assert.deepEqual(pi.calls, [
		["rtk", ...rtkArgs], ["sbx", "--no-input", "ls", "--json"],
		...["one", "broken"].map(name => ["sbx", "--no-input", "exec", "--", name, "rtk", ...rtkArgs]),
	]);
	assert.deepEqual(pi.statuses, ["RTK: 50 tokens saved (50.0%)"]);
	assert.deepEqual(pi.notices, [[[
		"Total (reported only): 140 tokens saved (14.0%)", "  5 commands | 1,000 tokens before / 870 after",
		"Local: 50 tokens saved (50.0%)", "  2 commands | 100 tokens before / 60 after",
		"Sandbox one: 90 tokens saved (10.0%)", "  3 commands | 900 tokens before / 810 after",
		"Sandbox sleeping: excluded (stopped)", "Sandbox broken: excluded (sbx exited with code 1)",
	].join("\n"), "warning"]]);
});

test("bad inventory cannot supply argv or terminal text, and a missing sbx does not hide local gains", async () => {
	for (const inventory of [failure, ok([{ name: "--bad\ncontrols", status: "running" }]), ok({})]) {
		const pi = load(bin => bin === "rtk" ? ok(gain(1, 50, 10, 40)) : inventory);
		await pi.command("all");
		assert.equal(pi.calls.length, 2);
		const [[text, level]] = pi.notices;
		assert.equal(level, "warning");
		assert.match(text, /^Total \(reported only\): 40 tokens saved \(80\.0%\)/);
		assert.match(text, /Sandboxes: excluded/);
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
			if (bin === "rtk") return failure;
			return args.includes("ls") ? ok(guests) : ok(gain(0, 0, 0, 0));
		});
		await pi.command("all");
		const [[text, level]] = pi.notices;
		assert.match(text, /Local: excluded/);
		assert.equal(level, guests.length ? "warning" : "error");
		if (guests.length) assert.match(text, /^Total \(reported only\): 0 tokens saved \(0.0%\)/);
		else assert.match(text, /^No RTK gains available\./);
	}
});

test("overlapping refreshes share one read, and shutdown prevents a late footer update", async () => {
	let finish, signal;
	const pi = load((_bin, _args, opts) => {
		signal = opts.signal;
		return new Promise(resolve => { finish = resolve; });
	});
	pi.fire("session_start");
	pi.fire("agent_settled");
	const command = pi.command();
	assert.equal(pi.calls.length, 1);
	const shutdown = pi.fire("session_shutdown");
	assert.equal(signal.aborted, true);
	finish(ok(gain(2, 5, 0, 5)));
	await Promise.all([command, shutdown]);
	assert.deepEqual(pi.statuses, [undefined]);
	assert.deepEqual(pi.notices, []);
});

test("headless lifecycle and unsupported arguments never run a subprocess", async () => {
	const headless = load(() => assert.fail("unexpected query"), false);
	for (const event of ["session_start", "agent_settled", "session_shutdown"]) await headless.fire(event);
	assert.deepEqual(headless.statuses, []);
	const pi = load(() => assert.fail("unexpected query"));
	await pi.command("--reset");
	assert.deepEqual(pi.calls, []);
	assert.deepEqual(pi.notices, [["Usage: /rtk-gain [all]", "error"]]);
});
