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
	it("groups rg and Pi grep matches (with -C context and -- separators) and roundtrips", () => {
		const rgInput = [
			"src/a.ts:10:const alpha = 1;",
			"src/a.ts:24:const beta = 2;",
			"src/b.ts:5: export function run(): void {}",
			"src/b.ts:9:const url = 'https://example.com:8080/x';",
		].join("\n");
		const groupedRg = groupGrep(rgInput);
		assert.equal(
			groupedRg,
			[
				"src/a.ts",
				" 10:const alpha = 1;",
				" 24:const beta = 2;",
				"src/b.ts",
				" 5: export function run(): void {}",
				" 9:const url = 'https://example.com:8080/x';",
			].join("\n"),
		);
		assert.equal(ungroupGrep(groupedRg), rgInput);

		const ctxInput = [
			"my-dir/my-file.ts-9-before",
			"my-dir/my-file.ts:10:match1",
			"my-dir/my-file.ts-11-after",
			"--",
			"my-dir/my-file.ts:41:match2",
		].join("\n");
		const groupedCtx = groupGrep(ctxInput);
		assert.notEqual(groupedCtx, undefined);
		assert.equal(ungroupGrep(groupedCtx ?? ""), ctxInput);
	});

	it("rejects non-grep lines, already-grouped input, and protects fenced code blocks", () => {
		const nonGrep = [
			"12:34:56 INFO started server",
			"[12:34:56] WARN slow query",
			"2026-11-22T10:30:00Z ready",
			"https://example.com:8080:path",
			"  indented/file.ts:10:not a grep line",
			"--:1:not a file path",
		].join("\n");
		assert.equal(groupGrep(nonGrep), undefined);
		assert.equal(
			groupGrep("src/a.ts\n 10:already grouped\nsrc/b.ts:20:match"),
			undefined,
		);

		const mixedWithFence = [
			"src/a.ts:1:const alpha = 1;",
			"src/a.ts:2:const beta = 2;",
			"```yaml",
			"redis:7:alpine",
			"postgres:16:bookworm",
			"```",
			"src/b.ts:10:const gamma = 3;",
			"src/b.ts:11:const delta = 4;",
		].join("\n");
		const grouped = groupGrep(mixedWithFence);
		assert.notEqual(grouped, undefined);
		assert.ok(
			(grouped ?? "").includes(
				"```yaml\nredis:7:alpine\npostgres:16:bookworm\n```",
			),
		);
		assert.equal(ungroupGrep(grouped ?? ""), mixedWithFence);

		assert.equal(
			groupGrep("src/a.ts:1:a\nsrc/a.ts:2:b\n```yaml\nredis:7:alpine"),
			undefined,
		);
	});
});

describe("stepFenceLine (CommonMark §4.5)", () => {
	it("tracks open/close rules for backticks, tildes, indentation, info strings, and CRLF", () => {
		assert.deepEqual(stepFenceLine("   ```ts\r", undefined), {
			next: { char: "`", length: 3 },
			transition: "open",
		});
		assert.deepEqual(stepFenceLine("~~~~python", undefined), {
			next: { char: "~", length: 4 },
			transition: "open",
		});
		for (const nonOpen of [
			"    ```ts",
			"\t```ts",
			"``ts",
			"```foo`bar",
			"```inline```",
		]) {
			assert.deepEqual(stepFenceLine(nonOpen, undefined), {
				next: undefined,
				transition: "none",
			});
		}
		assert.deepEqual(stepFenceLine("~~~foo~bar", undefined), {
			next: { char: "~", length: 3 },
			transition: "open",
		});

		const open4 = { char: "`" as const, length: 4 };
		for (const nonClose of ["```", "~~~~", "````ts", "    ````"]) {
			assert.deepEqual(stepFenceLine(nonClose, open4), {
				next: open4,
				transition: "none",
			});
		}
		assert.deepEqual(stepFenceLine("   `````  \t\r", open4), {
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

	it("factors repeated suffixes within MAX_FOOTNOTES=3, MIN_SUFFIX=40, MIN_REPEATS=3 and roundtrips", () => {
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
		assert.ok((factored ?? "").includes("[^3]:"));
		assert.equal((factored ?? "").includes("[^4]:"), false);
		assert.equal(unfactorSuffixes(factored ?? ""), input);

		const short39 = ` ${"x".repeat(38)}`;
		assert.equal(
			factorSuffixes([`a${short39}`, `b${short39}`, `c${short39}`].join("\n")),
			undefined,
		);
		assert.equal(
			factorSuffixes([`a${suffixA}`, `b${suffixA}`].join("\n")),
			undefined,
		);
		assert.equal(
			factorSuffixes(
				[`a${suffixA}`, `b${suffixA}`, `c${suffixA}`, "note [^1]"].join("\n"),
			),
			undefined,
		);
	});

	it("protects fenced code blocks and rejects unclosed fences", () => {
		const input = [
			`out-1${suffixA}`,
			`out-2${suffixA}`,
			`out-3${suffixA}`,
			"````md",
			"```",
			`nested-1${suffixA}`,
			"```",
			"````",
		].join("\n");
		const factored = factorSuffixes(input);
		assert.notEqual(factored, undefined);
		assert.ok((factored ?? "").includes("out-1 [^1]"));
		assert.ok((factored ?? "").includes(`nested-1${suffixA}`));
		assert.equal(unfactorSuffixes(factored ?? ""), input);

		assert.equal(
			factorSuffixes(
				[`a${suffixA}`, `b${suffixA}`, `c${suffixA}`, "```ts", "x"].join("\n"),
			),
			undefined,
		);
	});
});

describe("compactJsonDocument", () => {
	it("strips indentation from valid multi-line JSON objects/arrays and skips invalid/primitive inputs", () => {
		const obj = JSON.stringify({ a: 1, nested: { b: [2, 3] } }, null, 2);
		const compact = compactJsonDocument(obj);
		assert.equal(compact, '{\n"a": 1,\n"nested": {\n"b": [\n2,\n3\n]\n}\n}');
		assert.deepEqual(JSON.parse(compact ?? ""), JSON.parse(obj));

		assert.equal(compactJsonDocument('{\n  "broken": \n}'), undefined);
		assert.equal(compactJsonDocument('{"a": 1, "b": 2}'), undefined);
		assert.equal(compactJsonDocument("42\n"), undefined);
	});
});
