import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createGate, ruleMethods } from "../gate.ts";

const BUNDLED = fileURLToPath(new URL("../rtk", import.meta.url));

function rule(use: string, extra = ""): string {
	return `schema_version = 1\n\n[pipeline]\nname = "t"\nextends = "rtk:default"\n\n# use = ["ignored"]\n[[hook.after_tool.any]]\nname = "r"\n${extra}use = [${use}]\n`;
}

function profiles(t: test.TestContext, files: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), "rtk-gate-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(join(root, name));
		writeFileSync(join(root, name, "pipeline.toml"), text);
	}
	return root;
}

test("reads the bundled profiles' methods", () => {
	assert.deepEqual(ruleMethods(join(BUNDLED, "terminal")), [
		"ansi",
		"progress",
		"dedup",
		"base64-elide",
		"cap",
	]);
	assert.deepEqual(ruleMethods(join(BUNDLED, "listing")), ["ansi", "cap"]);
	assert.deepEqual(ruleMethods(join(BUNDLED, "generic")), [
		"ansi",
		"base64-elide",
		"dedup",
	]);
});

test("models only rule shapes it understands", (t) => {
	const root = profiles(t, {
		disabled: rule('"cap"', "enabled = false\n"),
		unknown: rule('"ansi", "toon"'),
		two: `${rule('"cap"')}\n[[hook.after_tool.any]]\nuse = ["ansi"]\n`,
		other: rule('"cap"').replace("after_tool.any", "after_tool.shell"),
		extra: rule('"cap"'),
	});
	mkdirSync(join(root, "extra", "pipelines"));
	assert.deepEqual(ruleMethods(join(root, "disabled")), []);
	assert.equal(ruleMethods(join(root, "unknown")), undefined);
	assert.equal(ruleMethods(join(root, "two")), undefined);
	assert.equal(ruleMethods(join(root, "other")), undefined);
	assert.equal(ruleMethods(join(root, "extra")), undefined);
});

test("skips RTK only when no bundled method could change the text", () => {
	const gate = createGate(BUNDLED);
	const terse = Array.from({ length: 40 }, (_, i) => `M src/file${i}.ts`).join(
		"\n",
	);
	for (const profile of ["terminal", "listing", "generic"])
		assert.equal(gate(profile, terse), false, profile);
	const tall = Array.from({ length: 301 }, (_, i) => `row ${i}`).join("\n");
	assert.equal(gate("terminal", `${terse}\n\u001b[31mred\u001b[0m`), true);
	assert.equal(gate("terminal", `${terse}\n10%\r100%`), true);
	assert.equal(gate("terminal", `${terse}\nsame\nsame\nsame`), true);
	assert.equal(
		gate("terminal", `${terse}\n\n\n\n`),
		false,
		"blank runs are not deduplicated",
	);
	assert.equal(gate("terminal", tall), true);
	assert.equal(gate("terminal", "x".repeat(2001)), true);
	assert.equal(
		gate("listing", `${terse}\nsame\nsame\nsame`),
		false,
		"listing has no dedup",
	);
	assert.equal(gate("listing", tall), true);
	assert.equal(gate("generic", tall), false, "generic does not window");
	assert.equal(gate("generic", "Ab1".repeat(400)), true);
	assert.equal(
		gate("missing", terse),
		true,
		"configuration problems are left to RTK",
	);
});

test("re-reads a profile when its file changes", (t) => {
	const root = profiles(t, { p: rule('"ansi"') });
	const gate = createGate(root);
	const repeated = "same\nsame\nsame";
	assert.equal(gate("p", repeated), false);
	writeFileSync(join(root, "p", "pipeline.toml"), rule('"ansi", "dedup"'));
	const later = new Date(Date.now() + 5_000);
	utimesSync(join(root, "p", "pipeline.toml"), later, later);
	assert.equal(gate("p", repeated), true);
	writeFileSync(
		join(root, "p", "pipeline.toml"),
		rule('"dedup"', "enabled = false\n"),
	);
	const latest = new Date(Date.now() + 10_000);
	utimesSync(join(root, "p", "pipeline.toml"), latest, latest);
	assert.equal(gate("p", repeated), false, "a disabled rule never runs");
});
