import assert from "node:assert/strict";
import test from "node:test";
import {
	compactJsonDocument,
	factorSuffixes,
	groupGrep,
	unfactorSuffixes,
	ungroupGrep,
} from "../compact.ts";

test("groups Pi grep lines under one heading per run of a file", () => {
	const original = [
		"src/a.ts-9- before",
		"src/a.ts:10: match one",
		"src/a.ts-11- after",
		"src/a.ts:20: match two",
		"lib/b-c.ts:3: other file",
		"src/a.ts:30: back again",
		"",
		"[100 matches limit reached. Use limit=200 for more, or refine pattern]",
	].join("\n");
	const grouped = groupGrep(original);
	assert.equal(
		grouped,
		[
			"src/a.ts",
			" 9- before",
			" 10: match one",
			" 11- after",
			" 20: match two",
			"lib/b-c.ts",
			" 3: other file",
			"src/a.ts",
			" 30: back again",
			"",
			"[100 matches limit reached. Use limit=200 for more, or refine pattern]",
		].join("\n"),
	);
	assert.equal(ungroupGrep(grouped ?? ""), original);
});

test("keeps grep output lossless when paths look like line prefixes", () => {
	// `a:1: b.ts:5: x` is ambiguous in Pi's format; grouping keeps its bytes exactly.
	const original = [
		"a:1: b.ts:5: x",
		"a:1: b.ts:6: y",
		"x-1-2.ts:4: z",
		"x-1-2.ts-5- ctx",
	].join("\n");
	const grouped = groupGrep(original);
	assert.ok(grouped);
	assert.equal(ungroupGrep(grouped), original);
	// A context line next to a different file stays as it was.
	assert.equal(groupGrep("a.ts-1- orphan context"), undefined);
});

test("refuses output that FFF already grouped", () => {
	const fff = [
		"src/a.ts",
		" 10: match",
		" 11- context",
		"",
		"src/b.ts:3: native line",
	].join("\n");
	assert.equal(groupGrep(fff), undefined);
});

test("every accepted grouping round-trips on generated output", () => {
	// Deterministic generator: paths with separators, digits, and dashes.
	let seed = 7;
	const next = (n: number) => {
		seed = (seed * 1103515245 + 12345) % 2 ** 31;
		return seed % n;
	};
	const paths = ["a.ts", "a-1.ts", "dir/x:y.ts", "b", "b-2", "c 1.md"];
	for (let round = 0; round < 300; round++) {
		const lines: string[] = [];
		for (let i = 0; i < 1 + next(12); i++) {
			const path = paths[next(paths.length)] ?? "a.ts";
			const kind = next(4);
			if (kind === 0) lines.push(`${path}-${next(99)}- ctx ${next(9)}`);
			else if (kind === 3 && i > 0) lines.push("");
			else lines.push(`${path}:${next(99)}: text: ${next(9)}`);
		}
		const original = lines.join("\n");
		const grouped = groupGrep(original);
		if (grouped !== undefined)
			assert.equal(ungroupGrep(grouped), original, original);
	}
});

test("factors a long shared tail into a footnote and back", () => {
	const tail =
		" is deprecated; see https://example.com/migration-guide for replacements";
	const original = [
		`warning: foo()${tail}`,
		`warning: bar()${tail}`,
		`warning: baz()${tail}`,
		"note: unrelated line",
	].join("\n");
	const factored = factorSuffixes(original);
	assert.equal(
		factored,
		[
			"warning: foo() [^1]",
			"warning: bar() [^1]",
			"warning: baz() [^1]",
			"note: unrelated line",
			"",
			`[^1]:${tail}`,
		].join("\n"),
	);
	assert.equal(unfactorSuffixes(factored ?? ""), original);
});

test("does not factor short, rare, or footnote-like tails", () => {
	assert.equal(factorSuffixes("a x\nb x\nc x"), undefined);
	const tail = " shared by only two lines and long enough to matter otherwise";
	assert.equal(factorSuffixes(`a${tail}\nb${tail}`), undefined);
	// Existing footnote syntax would make the rewrite ambiguous.
	const tail3 = " shared by three lines and long enough to factor out here";
	assert.equal(
		factorSuffixes(`a${tail3}\nb${tail3}\nc${tail3}\nsee [^1]`),
		undefined,
	);
});

test("compacts only complete, indented JSON documents", () => {
	const document = JSON.stringify(
		{ a: [1, 2], b: { c: "  spaced  " } },
		null,
		2,
	);
	const compact = compactJsonDocument(document);
	assert.ok(compact);
	assert.deepEqual(JSON.parse(compact), JSON.parse(document));
	assert.ok(!compact.includes("\n "));
	assert.equal(compactJsonDocument('{"a":1}'), undefined);
	assert.equal(compactJsonDocument('{\n  "a": 1,\n'), undefined);
	assert.equal(compactJsonDocument("plain\n  text"), undefined);
});
