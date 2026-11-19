import assert from "node:assert/strict";
import test from "node:test";
import {
	type Candidate,
	categoryFor,
	MIN_BYTES,
	preservesTrailer,
	rtkToolName,
	select,
	structureCheck,
	worthReplacing,
} from "../policy.ts";

const CWD = "/work/app";
const HINT = "\n[full output: rtk recall 0123456789abcdef]";
// About 900 bytes: above RTK's 512-byte minimum.
const big = (prefix = "line") =>
	Array.from({ length: 100 }, (_, i) => `${prefix} ${i}`).join("\n");

function candidate(overrides: Partial<Candidate> = {}): Candidate {
	return {
		toolName: "bash",
		input: { command: "python3 report.py" },
		content: [{ type: "text", text: big() }],
		isError: false,
		...overrides,
	};
}

test("routes each tool family to its category", () => {
	assert.equal(categoryFor("bash"), "terminal");
	assert.equal(categoryFor("read"), "read");
	for (const tool of [
		"grep",
		"find",
		"ls",
		"ffgrep",
		"fffind",
		"fff-multi-grep",
		"multi_grep",
	])
		assert.equal(categoryFor(tool), "listing", tool);
	for (const tool of [
		"mcp__codegraph__codegraph_explore",
		"web_contents",
		"watchdog_diff",
		"lens_diagnostics",
	])
		assert.equal(categoryFor(tool), "generic", tool);
	for (const tool of ["edit", "write"])
		assert.equal(categoryFor(tool), undefined, tool);
});

test("routes the unrewritten Bash commands seen in real sessions to terminal filtering", () => {
	for (const command of [
		"node - <<'EOF'\nconsole.log(1)\nEOF",
		'node -e "console.log(1)"',
		"python3 - <<'EOF'\nprint(1)\nEOF",
		"for f in *.ts; do wc -l $f; done",
		"cat src/a.ts | head -50",
		"node --test tests/*.test.ts",
		"getmd https://example.com",
		"sbx policy ls",
	])
		assert.deepEqual(
			select(candidate({ input: { command } }), CWD),
			{ category: "terminal", text: big() },
			command,
		);
	assert.equal(select(candidate({ isError: true }), CWD)?.category, "terminal");
});

test("treats commands that only print one file as file views", () => {
	const views: [string, string][] = [
		["cat src/a.ts", "/work/app/src/a.ts"],
		["sed -n '1,200p' src/a.ts", "/work/app/src/a.ts"],
		["cd lib && sed -n 10,20p 'my file.ts'", "/work/app/lib/my file.ts"],
		["tail -n 100 logs/app.log", "/work/app/logs/app.log"],
		["head -50 package-lock.json", "/work/app/package-lock.json"],
		["rtk read bun.lock --head-lines 80", "/work/app/bun.lock"],
		["nl -ba /etc/hosts", "/etc/hosts"],
	];
	for (const [command, path] of views)
		assert.deepEqual(
			select(candidate({ input: { command } }), CWD),
			{ category: "read", text: big(), path },
			command,
		);
	// Failed file-view commands keep terminal handling instead of mislabelling stderr as file content.
	assert.deepEqual(
		select(
			candidate({ input: { command: "cat app.min.js" }, isError: true }),
			CWD,
		),
		{ category: "terminal", text: big() },
	);
});

test("marks RTK-wrapped commands and never touches recall output", () => {
	assert.deepEqual(
		select(candidate({ input: { command: "rtk bun run test" } }), CWD),
		{
			category: "terminal",
			text: big(),
			wrapped: true,
		},
	);
	assert.equal(
		select(candidate({ input: { command: "cd x && rtk git diff" } }), CWD)
			?.wrapped,
		true,
	);
	for (const command of [
		"rtk recall 0123abcd --full",
		"cd x && rtk recall abc",
	])
		assert.equal(
			select(candidate({ input: { command } }), CWD),
			undefined,
			command,
		);
	assert.equal(
		select(candidate({ input: { command: "myrtk run" } }), CWD)?.wrapped,
		undefined,
	);
	assert.equal(select(candidate({ input: {} }), CWD), undefined);
});

test("routes reads with their resolved path", () => {
	assert.deepEqual(
		select(candidate({ toolName: "read", input: { path: "src/a.ts" } }), CWD),
		{
			category: "read",
			text: big(),
			path: "/work/app/src/a.ts",
		},
	);
	assert.equal(
		select(candidate({ toolName: "read", input: { path: "@src/a.ts" } }), CWD)
			?.path,
		"/work/app/src/a.ts",
	);
	assert.equal(
		select(candidate({ toolName: "read", input: {} }), CWD),
		undefined,
	);
	assert.equal(
		select(
			candidate({ toolName: "read", input: { path: "a" }, isError: true }),
			CWD,
		),
		undefined,
	);
});

test("skips excluded, nested, small, failed non-bash, and non-text results", () => {
	assert.equal(select(candidate({ toolName: "edit" }), CWD), undefined);
	assert.equal(select(candidate({ toolName: "write" }), CWD), undefined);
	assert.equal(
		select(candidate({ parentToolCallId: "call-1" }), CWD),
		undefined,
	);
	assert.equal(
		select(candidate({ toolName: "grep", isError: true }), CWD),
		undefined,
	);
	const small = "x".repeat(MIN_BYTES - 1);
	assert.equal(
		select(candidate({ content: [{ type: "text", text: small }] }), CWD),
		undefined,
	);
	assert.equal(
		select(
			candidate({ content: [{ type: "text", text: "x".repeat(MIN_BYTES) }] }),
			CWD,
		)?.category,
		"terminal",
	);
	// Multibyte text is measured in UTF-8 bytes, as RTK's guard does.
	assert.notEqual(
		select(
			candidate({
				content: [{ type: "text", text: "é".repeat(MIN_BYTES / 2) }],
			}),
			CWD,
		),
		undefined,
	);
	// Images, including a read of an image file, are never touched.
	assert.equal(
		select(candidate({ content: [{ type: "image" }] }), CWD),
		undefined,
	);
	assert.equal(
		select(
			candidate({
				toolName: "read",
				input: { path: "a.png" },
				content: [{ type: "text", text: big() }, { type: "image" }],
			}),
			CWD,
		),
		undefined,
	);
});

test("names tools so RTK classifies them as `any`", () => {
	assert.equal(rtkToolName("bash"), "pi-bash");
	assert.equal(rtkToolName("mcp__x__y"), "pi-mcp__x__y");
});

test("never accepts a larger, equal, or marginally smaller replacement", () => {
	const original = "x".repeat(2000);
	assert.equal(worthReplacing(original, original), false);
	assert.equal(worthReplacing(original, `${original}!`), false);
	// 150 bytes saved is under 10% of 2,000.
	assert.equal(worthReplacing(original, "x".repeat(1850)), false);
	assert.equal(worthReplacing(original, "x".repeat(1800)), true);
	// 10% of 600 bytes is 60, but at least 128 bytes must be saved.
	assert.equal(worthReplacing("x".repeat(600), "x".repeat(500)), false);
});

test("terminal check requires the final status line and notices", () => {
	const check = structureCheck("terminal");
	const notice =
		"[Showing lines 1-2000 of 5000. Full output: /tmp/pi-bash-1.log]";
	const original = `${big()}\n\n${notice}\n\nCommand exited with code 1`;
	const elided = `line 0\n[30 lines elided]\nline 39\n\n${notice}\n\nCommand exited with code 1`;
	assert.equal(check(original, `${elided}${HINT}`), true);
	assert.equal(
		check(original, `line 0\n\nCommand exited with code 1${HINT}`),
		false,
	);
	assert.equal(check(original, `line 0\n\n${notice}${HINT}`), false);
	assert.equal(preservesTrailer(original, `${elided}${HINT}`), true);
});

test("terminal check accepts ANSI and progress rewrites of the final line", () => {
	const check = structureCheck("terminal");
	const original = `${big()}\n\u001b[32m12 passed\u001b[0m`;
	assert.equal(check(original, `line 0\n12 passed${HINT}`), true);
	const progress = `${big()}\n10%\r50%\r100%\r`;
	assert.equal(check(progress, `line 0\n100%${HINT}`), true);
	assert.equal(check(original, `line 0\n12 failed${HINT}`), false);
});

test("trailer check accepts dedup, long-line cap, and base64-elide on the final line", () => {
	const terminal = structureCheck("terminal");
	const generic = structureCheck("generic");
	// Dedup appends `[xN]` after the repeated final line, matching exact run length (>= 3).
	const repeated = `start\n${Array.from({ length: 5 }, () => "same error").join("\n")}`;
	assert.equal(terminal(repeated, `start\nsame error\n[x5]${HINT}`), true);
	assert.equal(terminal(repeated, `start\nsame error\n[x4]${HINT}`), false);
	assert.equal(terminal(repeated, `start\nother error\n[x5]${HINT}`), false);
	assert.equal(terminal("a\na", `a\n[x2]${HINT}`), false);

	// Long-line cap keeps the prefix and appends ` [+N chars]`.
	const long = `start\n${"a".repeat(2500)}`;
	assert.equal(
		terminal(long, `start\n${"a".repeat(2000)} [+500 chars]${HINT}`),
		true,
	);
	assert.equal(
		terminal(long, `start\n${"a".repeat(2000)} [+400 chars]${HINT}`),
		false,
	);

	// Base64-elide requires >= 1,024 standard base64 chars and supports touching markers + cap.
	const run = "AbCdEf0123+/".repeat(120); // 1,440 chars
	const b64 = `{"ok":true,"data":"${run}"}`;
	assert.equal(
		generic(b64, `{"ok":true,"data":"[base64 data, 1 KB elided]"}${HINT}`),
		true,
	);
	// Touching markers from two adjacent padded base64 runs.
	const touching = `{"data":"${run}==${run}=="}`;
	assert.equal(
		generic(
			touching,
			`{"data":"[base64 data, 1 KB elided][base64 data, 1 KB elided]"}${HINT}`,
		),
		true,
	);
	// Base64-elide followed by cap on a long trailing line (after marker or cutting mid-marker).
	const b64ThenCap = `prefix:${run}:middle:${"z".repeat(2200)}`;
	assert.equal(
		terminal(
			b64ThenCap,
			`prefix:[base64 data, 1 KB elided]:middle:${"z".repeat(1900)} [+300 chars]${HINT}`,
		),
		true,
	);
	const b64CutMidMarker = `${"y".repeat(1985)} ${run} end`;
	assert.equal(
		terminal(
			b64CutMidMarker,
			`${"y".repeat(1985)} [base64 data,  [+16 chars]${HINT}`,
		),
		true,
	);
	// Reject short gaps, URL-safe base64 chars (`-`/`_`), and bogus capped prefixes.
	assert.equal(
		terminal(
			"Command exited with code 1",
			`[base64 data, 1 KB elided] exited with code 1${HINT}`,
		),
		false,
	);
	assert.equal(
		terminal(
			"Command exited with code 1",
			`[base64 data, 1 KB elided] [+10 chars]${HINT}`,
		),
		false,
	);
	assert.equal(
		terminal("Command exited with code 1", `[base64 data,  [+16 chars]${HINT}`),
		false,
	);
	assert.equal(
		generic(
			`{"ok":true,"data":"${"a-b_".repeat(300)}"}`,
			`{"ok":true,"data":"[base64 data, 1 KB elided]"}${HINT}`,
		),
		false,
	);
	assert.equal(
		terminal(
			`prefix:${run}:line1\nprefix:other final line`,
			`prefix:[base64 data, 1 KB elided]:line1 [+5 chars]${HINT}`,
		),
		false,
	);
});

test("listing check keeps FFF headings bound to their match lines", () => {
	const check = structureCheck("listing");
	const fff = ["a.ts", " 1: one", " 2: two", "", "b.ts", " 3: three"].join(
		"\n",
	);
	assert.equal(check(fff, `a.ts\n 1: one\n\nb.ts\n 3: three${HINT}`), true);
	assert.equal(
		check(fff, `a.ts\n 1: one\n[2 lines elided]\n 3: three${HINT}`),
		false,
	);
	// Native grep repeats the path on every line, so windowing is safe.
	const native = [
		"a.ts:1: one",
		"a.ts:2: two",
		"b.ts:3: three",
		"",
		"[3 matches limit reached]",
	].join("\n");
	assert.equal(
		check(
			native,
			`a.ts:1: one\n[1 lines elided]\nb.ts:3: three\n\n[3 matches limit reached]${HINT}`,
		),
		true,
	);
	assert.equal(check(native, `a.ts:1: one\nb.ts:3: three${HINT}`), false);
});
