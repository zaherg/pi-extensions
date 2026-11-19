import assert from "node:assert/strict";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { filterPosthook } from "../bridge.ts";
import { structureCheck } from "../policy.ts";

// A stand-in `rtk` that logs each invocation and answers like RTK 1.2's
// posthook and recall. FAKE_FILTERED is the replacement text (with or
// without a hint); FAKE_RECALL is what `rtk recall` prints.
const FAKE = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "recall") {
	appendFileSync(process.env.FAKE_LOG, args.join(" ") + "\\n");
	process.stdout.write(process.env.FAKE_RECALL ?? "");
} else {
	let input = "";
	process.stdin.on("data", (chunk) => (input += chunk));
	process.stdin.on("end", () => {
		appendFileSync(process.env.FAKE_LOG, args.join(" ") + " " + JSON.parse(input).tool_name + "\\n");
		process.stdout.write(JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PostToolUse",
				updatedToolOutput: { content: [{ type: "text", text: process.env.FAKE_FILTERED }] },
			},
		}));
	});
}
`;

const ORIGINAL = Array.from({ length: 50 }, (_, i) => `row ${i}`).join("\n");
const HINT = "\n[full output: rtk recall 0123456789abcdef]";
const FILTERED = `row 0\n[48 lines elided]\nrow 49${HINT}`;

function fake(t: test.TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "rtk-bridge-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const executable = join(dir, "rtk");
	writeFileSync(executable, FAKE);
	chmodSync(executable, 0o755);
	const log = join(dir, "log");
	writeFileSync(log, "");
	const run = (
		text: string,
		env: { FAKE_FILTERED: string; FAKE_RECALL?: string },
		verifyRecall: boolean,
		check = () => true,
	) =>
		filterPosthook(
			"pi-bash",
			text,
			{
				cwd: dir,
				configDirectory: dir,
				executable,
				env: { ...process.env, FAKE_LOG: log, ...env },
			},
			check,
			verifyRecall,
		);
	const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
	const ffgrep = (
		text: string,
		env: { FAKE_FILTERED: string; FAKE_RECALL?: string },
	) =>
		filterPosthook(
			"pi-ffgrep",
			text,
			{
				cwd: dir,
				configDirectory: dir,
				executable,
				env: { ...process.env, FAKE_LOG: log, ...env },
			},
			structureCheck("listing"),
			true,
		);
	return { run, calls, ffgrep };
}

test("reads recall back when asked and accepts only an exact original", async (t) => {
	const { run, calls } = fake(t);
	assert.deepEqual(
		await run(
			ORIGINAL,
			{ FAKE_FILTERED: FILTERED, FAKE_RECALL: ORIGINAL },
			true,
		),
		{
			kind: "filtered",
			text: FILTERED,
		},
	);
	assert.deepEqual(calls(), [
		"hook claude pi-bash",
		"recall 0123456789abcdef --full",
	]);
	assert.deepEqual(
		await run(
			ORIGINAL,
			{ FAKE_FILTERED: FILTERED, FAKE_RECALL: `${ORIGINAL}!` },
			true,
		),
		{
			kind: "failed",
			reason: "recovery",
		},
	);
});

test("skips the readback once recall is proven, in a single process", async (t) => {
	const { run, calls } = fake(t);
	assert.deepEqual(await run(ORIGINAL, { FAKE_FILTERED: FILTERED }, false), {
		kind: "filtered",
		text: FILTERED,
	});
	assert.deepEqual(calls(), ["hook claude pi-bash"]);
});

test("still reads back when the original itself ends like a recall hint", async (t) => {
	const { run, calls } = fake(t);
	const spoof = `${ORIGINAL}${HINT}`;
	assert.deepEqual(
		await run(spoof, { FAKE_FILTERED: FILTERED, FAKE_RECALL: ORIGINAL }, false),
		{
			kind: "failed",
			reason: "recovery",
		},
	);
	assert.deepEqual(calls(), [
		"hook claude pi-bash",
		"recall 0123456789abcdef --full",
	]);
});

test("refuses replacements without a hint, larger ones, and broken structure", async (t) => {
	const { run, calls } = fake(t);
	assert.deepEqual(
		await run(
			ORIGINAL,
			{ FAKE_FILTERED: "row 0\n[48 lines elided]\nrow 49" },
			false,
		),
		{
			kind: "failed",
			reason: "recovery",
		},
	);
	assert.deepEqual(
		await run(ORIGINAL, { FAKE_FILTERED: `${ORIGINAL}\nmore${HINT}` }, false),
		{ kind: "unchanged" },
	);
	assert.deepEqual(
		await run(ORIGINAL, { FAKE_FILTERED: FILTERED }, false, () => false),
		{
			kind: "failed",
			reason: "boundaries",
		},
	);
	// No readback for any refused replacement.
	assert.deepEqual(calls(), [
		"hook claude pi-bash",
		"hook claude pi-bash",
		"hook claude pi-bash",
	]);
});

test("ffgrep output keeps its headings through the listing check", async (t) => {
	const { ffgrep, calls } = fake(t);
	const fff = [
		"a.ts",
		...Array.from({ length: 40 }, (_, i) => ` ${i + 1}: match ${i}`),
	].join("\n");
	const kept = `a.ts\n 1: match 0\n[38 lines elided]\n 40: match 39${HINT}`;
	assert.deepEqual(
		await ffgrep(fff, { FAKE_FILTERED: kept, FAKE_RECALL: fff }),
		{ kind: "filtered", text: kept },
	);
	// Dropping the heading fails the FFF boundary check before any readback.
	assert.deepEqual(await ffgrep(fff, { FAKE_FILTERED: ` 1: match 0${HINT}` }), {
		kind: "failed",
		reason: "boundaries",
	});
	assert.deepEqual(calls(), [
		"hook claude pi-ffgrep",
		"recall 0123456789abcdef --full",
		"hook claude pi-ffgrep",
	]);
});
