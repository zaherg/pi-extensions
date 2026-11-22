import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	compactJsonDocument,
	factorSuffixes,
	groupGrep,
	stepFenceLine,
	unfactorSuffixes,
	ungroupGrep,
} from "../compact.ts";

describe("groupGrep / ungroupGrep", () => {
	it("groups rg-style matches by file and roundtrips exactly", () => {
		const input = [
			"src/a.ts:10:const alpha = 1;",
			"src/a.ts:24:const beta = 2;",
			"src/b.ts:5:export function run(): void {}",
			"src/b.ts:9:const url = 'https://example.com:8080/x';",
		].join("\n");

		const grouped = groupGrep(input);
		assert.equal(
			grouped,
			[
				"src/a.ts",
				" 10:const alpha = 1;",
				" 24:const beta = 2;",
				"src/b.ts",
				" 5:export function run(): void {}",
				" 9:const url = 'https://example.com:8080/x';",
			].join("\n"),
		);
		assert.equal(ungroupGrep(grouped), input);
	});

	it("groups Pi grep-style matches (space after colon) and roundtrips", () => {
		const input = [
			"pkg/foo.ts:12: import { x } from './y.ts';",
			"pkg/foo.ts:18: console.log(x);",
		].join("\n");

		const grouped = groupGrep(input);
		assert.equal(
			grouped,
			[
				"pkg/foo.ts",
				" 12: import { x } from './y.ts';",
				" 18: console.log(x);",
			].join("\n"),
		);
		assert.equal(ungroupGrep(grouped), input);
	});

	it("attaches leading and trailing -C context lines and preserves -- separators", () => {
		const input = [
			"my-dir/my-file.ts-9-before1",
			"my-dir/my-file.ts-10-before2",
			"my-dir/my-file.ts:11:match1",
			"my-dir/my-file.ts-12-after1",
			"--",
			"my-dir/my-file.ts-40-before3",
			"my-dir/my-file.ts:41:match2",
			"--",
			"other/b.ts-1-top",
			"other/b.ts:2:hit",
			"other/b.ts-3-bottom",
		].join("\n");

		const grouped = groupGrep(input);
		assert.equal(
			grouped,
			[
				"my-dir/my-file.ts",
				" 9-before1",
				" 10-before2",
				" 11:match1",
				" 12-after1",
				"--",
				" 40-before3",
				" 41:match2",
				"--",
				"other/b.ts",
				" 1-top",
				" 2:hit",
				" 3-bottom",
			].join("\n"),
		);
		assert.equal(ungroupGrep(grouped), input);
	});

	it("rejects timestamps, bracketed clock prefixes, URLs, indented lines, and '--' paths", () => {
		const nonGrep = [
			"12:34:56 INFO started server",
			"[12:34:56] WARN slow query",
			"2026-11-22T10:30:00Z ready",
			"2026-11-22 10:30:00 connected",
			"https://example.com:8080:path",
			"  indented/file.ts:10:not a grep line",
			"--:1:not a file path",
		].join("\n");

		assert.equal(groupGrep(nonGrep), undefined);
	});

	it("leaves non-grep lines interleaved around grep blocks intact on roundtrip", () => {
		const input = [
			"12:34:56 INFO starting search",
			"src/a.ts:1:first",
			"src/a.ts:2:second",
			"Summary: 2 matches",
		].join("\n");

		const grouped = groupGrep(input);
		assert.notEqual(grouped, undefined);
		assert.equal(ungroupGrep(grouped ?? ""), input);
	});

	it("skips input that already contains grouped line prefixes", () => {
		const alreadyGrouped = [
			"src/a.ts",
			" 10:match one",
			"src/b.ts:20:match two",
		].join("\n");
		assert.equal(groupGrep(alreadyGrouped), undefined);

		const alreadyContext = ["src/a.ts", " 10-context"].join("\n");
		assert.equal(groupGrep(alreadyContext), undefined);
	});

	it("returns undefined for plain text with no grep lines", () => {
		assert.equal(groupGrep("just some plain text\nsecond line"), undefined);
	});

	it("protects fenced code blocks from false-positive grep grouping and rejects unclosed fences", () => {
		const fencedOnly = [
			"```yaml",
			"redis:7:alpine",
			"postgres:16:bookworm",
			"```",
		].join("\n");
		assert.equal(groupGrep(fencedOnly), undefined);

		const mixed = [
			"src/a.ts:1:const alpha = 1;",
			"src/a.ts:2:const beta = 2;",
			"```yaml",
			"redis:7:alpine",
			"postgres:16:bookworm",
			"```",
			"src/b.ts:10:const gamma = 3;",
			"src/b.ts:11:const delta = 4;",
		].join("\n");
		const grouped = groupGrep(mixed);
		assert.notEqual(grouped, undefined);
		assert.ok(
			(grouped ?? "").includes(
				"```yaml\nredis:7:alpine\npostgres:16:bookworm\n```",
			),
		);
		assert.equal(ungroupGrep(grouped ?? ""), mixed);

		const unclosed = [
			"src/a.ts:1:const alpha = 1;",
			"src/a.ts:2:const beta = 2;",
			"```yaml",
			"redis:7:alpine",
		].join("\n");
		assert.equal(groupGrep(unclosed), undefined);
	});
});

describe("stepFenceLine (CommonMark §4.5)", () => {
	it("opens backtick and tilde fences with 0 to 3 leading spaces", () => {
		for (const indent of ["", " ", "  ", "   "]) {
			assert.deepEqual(stepFenceLine(`${indent}\`\`\`ts`, undefined), {
				next: { char: "`", length: 3 },
				transition: "open",
			});
			assert.deepEqual(stepFenceLine(`${indent}~~~~python`, undefined), {
				next: { char: "~", length: 4 },
				transition: "open",
			});
		}
	});

	it("does not open fences indented by 4 spaces, a tab, or fewer than 3 markers", () => {
		for (const line of ["    ```ts", "\t```ts", "``ts", "~~ts", "plain"]) {
			assert.deepEqual(stepFenceLine(line, undefined), {
				next: undefined,
				transition: "none",
			});
		}
	});

	it("rejects backtick in backtick info string but allows tilde in tilde info string", () => {
		assert.deepEqual(stepFenceLine("```foo`bar", undefined), {
			next: undefined,
			transition: "none",
		});
		assert.deepEqual(stepFenceLine("```inline```", undefined), {
			next: undefined,
			transition: "none",
		});
		assert.deepEqual(stepFenceLine("~~~foo~bar", undefined), {
			next: { char: "~", length: 3 },
			transition: "open",
		});
		assert.deepEqual(stepFenceLine("~~~foo`bar", undefined), {
			next: { char: "~", length: 3 },
			transition: "open",
		});
		assert.deepEqual(stepFenceLine("```foo~bar", undefined), {
			next: { char: "`", length: 3 },
			transition: "open",
		});
	});

	it("closes only on matching char, length >= opening, 0-3 leading spaces, and trailing spaces/tabs only", () => {
		const open4 = { char: "`" as const, length: 4 };

		// Shorter closing fence (nested 3-backtick inside 4-backtick) must not close.
		assert.deepEqual(stepFenceLine("```", open4), {
			next: open4,
			transition: "none",
		});
		// Mismatched fence character must not close.
		assert.deepEqual(stepFenceLine("~~~~", open4), {
			next: open4,
			transition: "none",
		});
		// Trailing non-whitespace must not close.
		assert.deepEqual(stepFenceLine("````ts", open4), {
			next: open4,
			transition: "none",
		});
		// 4 leading spaces must not close.
		assert.deepEqual(stepFenceLine("    ````", open4), {
			next: open4,
			transition: "none",
		});
		// Exact length and longer length with trailing spaces/tabs do close.
		assert.deepEqual(stepFenceLine("   ````  \t ", open4), {
			next: undefined,
			transition: "close",
		});
		assert.deepEqual(stepFenceLine("`````", open4), {
			next: undefined,
			transition: "close",
		});
	});

	it("handles CRLF (\\r) line endings on opening and closing fences", () => {
		const opened = stepFenceLine("```ts\r", undefined);
		assert.deepEqual(opened, {
			next: { char: "`", length: 3 },
			transition: "open",
		});
		assert.deepEqual(stepFenceLine("```  \r", opened.next), {
			next: undefined,
			transition: "close",
		});
	});
});

describe("factorSuffixes / unfactorSuffixes", () => {
	const suffixA =
		" --config /workspace/project/configs/production.json --verbose";
	const suffixB =
		" -> https://registry.example.invalid/packages/v2/metadata.json";
	const suffixC = " [status=200 duration_ms=142 region=us-east-1 cache=HIT]";
	const suffixD = " (retry_attempt=0 backoff=exponential max_attempts=5 ok)";

	it("factors repeated long suffixes and roundtrips exactly", () => {
		const input = [
			`job-1${suffixA}`,
			`job-2${suffixA}`,
			`job-3${suffixA}`,
			`job-4${suffixA}`,
		].join("\n");

		const factored = factorSuffixes(input);
		assert.notEqual(factored, undefined);
		assert.ok((factored ?? "").includes("job-1 [^1]"));
		assert.ok((factored ?? "").endsWith(`\n\n[^1]:${suffixA}`));
		assert.equal(unfactorSuffixes(factored ?? ""), input);
	});

	it("enforces the MAX_FOOTNOTES (3) cap", () => {
		const input = [
			`a1${suffixA}`,
			`a2${suffixA}`,
			`a3${suffixA}`,
			`b1${suffixB}`,
			`b2${suffixB}`,
			`b3${suffixB}`,
			`c1${suffixC}`,
			`c2${suffixC}`,
			`c3${suffixC}`,
			`d1${suffixD}`,
			`d2${suffixD}`,
			`d3${suffixD}`,
		].join("\n");

		const factored = factorSuffixes(input);
		assert.notEqual(factored, undefined);
		assert.ok((factored ?? "").includes("[^1]:"));
		assert.ok((factored ?? "").includes("[^2]:"));
		assert.ok((factored ?? "").includes("[^3]:"));
		assert.equal((factored ?? "").includes("[^4]:"), false);
		assert.equal(unfactorSuffixes(factored ?? ""), input);
	});

	it("enforces the MIN_SUFFIX (40) floor and MIN_REPEATS (3) floor", () => {
		// 39 chars total including leading space -> below MIN_SUFFIX.
		const short39 = ` ${"x".repeat(38)}`;
		assert.equal(short39.length, 39);
		assert.equal(
			factorSuffixes([`a${short39}`, `b${short39}`, `c${short39}`].join("\n")),
			undefined,
		);

		// 40 chars total including leading space -> meets MIN_SUFFIX.
		const exact40 = ` ${"x".repeat(39)}`;
		assert.equal(exact40.length, 40);
		const factored = factorSuffixes(
			[`a${exact40}`, `b${exact40}`, `c${exact40}`].join("\n"),
		);
		assert.notEqual(factored, undefined);
		assert.equal(
			unfactorSuffixes(factored ?? ""),
			[`a${exact40}`, `b${exact40}`, `c${exact40}`].join("\n"),
		);

		// Only 2 repeats -> below MIN_REPEATS.
		assert.equal(
			factorSuffixes([`a${suffixA}`, `b${suffixA}`].join("\n")),
			undefined,
		);
	});

	it("protects fenced code blocks (backtick, tilde, 3-space indented, nested 4-backtick)", () => {
		const input = [
			`outside-1${suffixA}`,
			`outside-2${suffixA}`,
			`outside-3${suffixA}`,
			"```sh",
			`backtick-1${suffixA}`,
			`backtick-2${suffixA}`,
			`backtick-3${suffixA}`,
			"```",
			"~~~sh",
			`tilde-1${suffixA}`,
			`tilde-2${suffixA}`,
			`tilde-3${suffixA}`,
			"~~~",
			"   ```sh",
			`indented-1${suffixA}`,
			"   ```",
			"````md",
			"```",
			`nested-1${suffixA}`,
			"```",
			`nested-2${suffixA}`,
			"````",
		].join("\n");

		const factored = factorSuffixes(input);
		assert.notEqual(factored, undefined);
		const out = factored ?? "";
		assert.ok(out.includes("outside-1 [^1]"));
		assert.ok(out.includes(`backtick-1${suffixA}`));
		assert.ok(out.includes(`tilde-1${suffixA}`));
		assert.ok(out.includes(`indented-1${suffixA}`));
		assert.ok(out.includes(`nested-1${suffixA}`));
		assert.ok(out.includes(`nested-2${suffixA}`));
		assert.equal(unfactorSuffixes(out), input);
	});

	it("still factors inline triple-backtick prose lines", () => {
		const input = [
			`\`\`\`cmd1\`\`\`${suffixA}`,
			`\`\`\`cmd2\`\`\`${suffixA}`,
			`\`\`\`cmd3\`\`\`${suffixA}`,
		].join("\n");

		const factored = factorSuffixes(input);
		assert.notEqual(factored, undefined);
		assert.ok((factored ?? "").includes("```cmd1``` [^1]"));
		assert.equal(unfactorSuffixes(factored ?? ""), input);
	});

	it("returns undefined on unclosed EOF fence", () => {
		const unclosed = [
			`outside-1${suffixA}`,
			`outside-2${suffixA}`,
			`outside-3${suffixA}`,
			"```ts",
			"const x = 1;",
		].join("\n");
		assert.equal(factorSuffixes(unclosed), undefined);
	});

	it("returns undefined if input already contains '[^'", () => {
		const withFootnote = [
			`item-1${suffixA}`,
			`item-2${suffixA}`,
			`item-3${suffixA}`,
			"see note [^existing]",
		].join("\n");
		assert.equal(factorSuffixes(withFootnote), undefined);
	});
});

describe("compactJsonDocument", () => {
	it("strips leading indentation from valid pretty-printed JSON objects and arrays", () => {
		const obj = JSON.stringify({ a: 1, nested: { b: [2, 3] } }, null, 2);
		const compactObj = compactJsonDocument(obj);
		assert.equal(compactObj, '{\n"a": 1,\n"nested": {\n"b": [\n2,\n3\n]\n}\n}');
		assert.deepEqual(JSON.parse(compactObj ?? ""), JSON.parse(obj));

		const arr = JSON.stringify([{ id: 1 }, { id: 2 }], null, "\t");
		const compactArr = compactJsonDocument(arr);
		assert.notEqual(compactArr, undefined);
		assert.deepEqual(JSON.parse(compactArr ?? ""), [{ id: 1 }, { id: 2 }]);
	});

	it("returns undefined for invalid JSON, single-line JSON, unindented JSON, and non-object/array JSON", () => {
		assert.equal(compactJsonDocument('{\n  "broken": \n}'), undefined);
		assert.equal(compactJsonDocument('{"a": 1, "b": 2}'), undefined);
		assert.equal(compactJsonDocument('{\n"a": 1\n}'), undefined);
		assert.equal(compactJsonDocument("42\n"), undefined);
		assert.equal(compactJsonDocument("true\n"), undefined);
		assert.equal(compactJsonDocument('"hello"\n'), undefined);
		assert.equal(compactJsonDocument("null\n"), undefined);
	});
});
