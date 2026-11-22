import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
	type ContextResults,
	dedupPassages,
	dedupReadExcerpts,
	MIN_PASSAGE_BYTES,
	PassageIndex,
	passages,
	ReadIndex,
} from "../dedup.ts";
import type { ReadView } from "../views.ts";

function makeView(start: number, lines: string[]): ReadView {
	return { start, lines, body: lines.join("\n") };
}

function makeParagraph(tag: string, minBytes = MIN_PASSAGE_BYTES): string {
	const prefix = `[${tag}] `;
	const fillLen = Math.max(0, minBytes - Buffer.byteLength(prefix));
	return `${prefix}${"x".repeat(fillLen)}`;
}

function makeNumberedHunk(start: number, lines: readonly string[]): string {
	return lines
		.map((line: string, index: number) => `${start + index}\t${line}`)
		.join("\n");
}

describe("ReadIndex", () => {
	it("matches exact/partial overlaps, orders largest-then-newest, and rejects mismatches", () => {
		const index = new ReadIndex();
		const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);

		index.record("/repo/a.ts", "small-old", makeView(1, lines.slice(0, 4)));
		index.record("/repo/a.ts", "large-old", makeView(1, lines.slice(0, 8)));
		index.record("/repo/a.ts", "large-new", makeView(1, lines.slice(0, 8)));

		const overlaps = index.overlaps("/repo/a.ts", makeView(1, lines));
		assert.deepEqual(
			overlaps.map((o) => o.source.toolCallId),
			["large-new", "large-old", "small-old"],
		);

		const partial = index.overlaps(
			"/repo/a.ts",
			makeView(6, ["L6", "L7", "L8", "L9"]),
		);
		assert.equal(partial[0]?.from, 6);
		assert.equal(partial[0]?.to, 8);

		assert.deepEqual(
			index.overlaps("/repo/a.ts", makeView(5, ["L5", "MODIFIED", "L7"])),
			[],
		);
		assert.deepEqual(index.overlaps("/repo/other.ts", makeView(1, lines)), []);
	});

	it("tracks markReplaced/markPathReplaced/forcesFull, rejects out-of-band start sentinels, and evicts stale tails", () => {
		const index = new ReadIndex();
		const path = "/repo/a.ts";

		index.markReplaced("/repo/zero.ts", 0);
		assert.equal(index.forcesFull("/repo/zero.ts", 50), false);

		index.markReplaced(path, 50);
		index.markReplaced(path, 120);
		index.markReplaced(path, 200);
		index.record(
			path,
			"call-w",
			makeView(
				40,
				Array.from({ length: 21 }, (_, i) => `row-${40 + i}`),
			),
			120,
		);
		assert.equal(index.forcesFull(path, 50), false);
		assert.equal(index.forcesFull(path, 120), false);
		assert.equal(index.forcesFull(path, 200), true);

		index.markPathReplaced(path);
		assert.equal(index.forcesFull(path, 1), true);
		assert.equal(index.forcesFull(path, 250), true);
		index.record(path, "call-clear", makeView(195, Array(10).fill("x")));
		assert.equal(index.forcesFull(path, 1), false);
		assert.equal(index.forcesFull(path, 200), false);

		index.markPathReplaced(path);
		index.invalidate(path);
		assert.equal(index.forcesFull(path, 1), false);
		assert.deepEqual(
			index.overlaps(path, makeView(195, Array(10).fill("x"))),
			[],
		);

		const revertPath = "/repo/revert.ts";
		const v1 = makeView(1, ["a1", "a2", "a3"]);
		const v2 = makeView(1, ["a1", "CHANGED", "a3"]);
		index.record(revertPath, "v1", v1);
		index.record(revertPath, "v2", v2);
		assert.deepEqual(index.overlaps(revertPath, v1), []);

		const shrinkPath = "/repo/shrink.ts";
		const sLines = Array.from({ length: 10 }, (_, i) => `s-${i + 1}`);
		index.record(shrinkPath, "call-4", makeView(1, sLines.slice(0, 4)));
		index.record(shrinkPath, "call-10", makeView(1, sLines));
		index.truncate(shrinkPath, 5);
		assert.deepEqual(
			index
				.overlaps(shrinkPath, makeView(1, sLines.slice(0, 5)))
				.map((o) => o.source.toolCallId),
			["call-4"],
		);
	});
});

describe("passages / PassageIndex / dedupPassages", () => {
	it("enforces 256-byte UTF-8 floor, coalesces consecutive unfenced passages, and falls back to visible calls", () => {
		assert.deepEqual(
			passages(
				["a".repeat(255), "a".repeat(256), "€".repeat(85), "€".repeat(86)].join(
					"\n\n",
				),
			),
			["a".repeat(256), "€".repeat(86)],
		);

		const index = new PassageIndex();
		const p1 = makeParagraph("one");
		const p2 = makeParagraph("two");
		const p3 = makeParagraph("three");
		const call1Text = `${p1}\n\n${p2}`;
		const call2Text = `${p2}\n\n${p3}`;
		index.record("bash", "call-1", call1Text);
		index.record("bash", "call-2", call2Text);

		const ctx: ContextResults = new Map([
			["call-1", call1Text],
			["call-2", call2Text],
		]);
		const res = dedupPassages(
			"bash",
			[p1, p2, p3, "tail"].join("\n\n"),
			index,
			() => ctx,
		);
		assert.equal(res.omitted, 3);
		assert.ok(res.text.includes("2 passage(s)"));
		assert.ok(res.text.includes("tool call call-1"));
		assert.ok(res.text.includes("tool call call-2"));
		assert.ok(res.text.endsWith("\n\ntail"));

		// Context eviction fallback: call-2 missing -> falls back to visible call-1 for p2
		const ctxOnly1: ContextResults = new Map([["call-1", call1Text]]);
		const resFallback = dedupPassages(
			"bash",
			`${p2}\n\nfooter`,
			index,
			() => ctxOnly1,
		);
		assert.equal(resFallback.omitted, 1);
		assert.ok(resFallback.text.includes("tool call call-1"));
	});

	it("preserves CommonMark fence balance across fenced passages and skips unbalanced mid-paragraph fences", () => {
		const index = new PassageIndex();
		const plain = makeParagraph("plain");
		const fenced = makeParagraph("fenced");
		const nested = `\`\`\`\n${makeParagraph("nested")}\n\`\`\``;
		const doc = [
			plain,
			`\`\`\`ts\n${fenced}\n\`\`\``,
			`\`\`\`\`md\n${nested}\n\`\`\`\``,
			"done",
		].join("\n\n");

		index.record("mcp", "c1", doc);
		const ctx: ContextResults = new Map([["c1", doc]]);
		const res = dedupPassages("mcp", doc, index, () => ctx);
		assert.equal(res.omitted, 3);
		const parts = res.text.split("\n\n");
		assert.ok(parts[1]?.startsWith("```ts\n[rtk-pi-extended:"));
		assert.ok(parts[1]?.endsWith("\n```"));
		assert.ok(parts[2]?.startsWith("````md\n[rtk-pi-extended:"));
		assert.ok(parts[2]?.endsWith("\n````"));

		const unbalanced = `intro\n\`\`\`ts\n${makeParagraph("unbalanced")}\n\ntail`;
		index.record("mcp", "c2", unbalanced);
		const ctx2: ContextResults = new Map([["c2", unbalanced]]);
		assert.equal(
			dedupPassages("mcp", unbalanced, index, () => ctx2).omitted,
			0,
		);
	});
});

describe("dedupReadExcerpts", () => {
	const cwd = "/workspace/repo";
	const fileLines = Array.from(
		{ length: 20 },
		(_, i) => `const value_${i + 1} = "${"v".repeat(30)}";`,
	);
	const fullView = makeView(1, fileLines);

	it("deduplicates multi-hunk excerpts under file headings and clears currentPath on prose or multi-paragraph fence close", () => {
		const reads = new ReadIndex();
		reads.record(resolve(cwd, "src/app.ts"), "read-1", fullView);
		const ctx: ContextResults = new Map([["read-1", fullView.body]]);

		const hunk1 = makeNumberedHunk(1, fileLines.slice(0, 8));
		const hunk2 = makeNumberedHunk(11, fileLines.slice(10, 18));
		const multi = [
			"**`src/app.ts`**",
			`\`\`\`ts\n${hunk1}\n\`\`\``,
			`\`\`\`ts\n${hunk2}\n\`\`\``,
		].join("\n\n");
		const resMulti = dedupReadExcerpts(multi, cwd, reads, () => ctx);
		assert.equal(resMulti.omitted, 2);
		assert.ok(resMulti.text.includes("lines 1-8 omitted"));
		assert.ok(resMulti.text.includes("lines 11-18 omitted"));

		const withProse = [
			"**`src/app.ts`**",
			"Intervening prose clears currentPath.",
			`\`\`\`ts\n${hunk1}\n\`\`\``,
		].join("\n\n");
		assert.equal(
			dedupReadExcerpts(withProse, cwd, reads, () => ctx).omitted,
			0,
		);

		const multiParaFence = [
			"**`src/app.ts`**",
			`\`\`\`ts\n${hunk1}`,
			`${makeNumberedHunk(9, fileLines.slice(8, 16))}\n\`\`\``,
			`\`\`\`ts\n${hunk1}\n\`\`\``,
		].join("\n\n");
		const resClose = dedupReadExcerpts(multiParaFence, cwd, reads, () => ctx);
		assert.equal(resClose.omitted, 2);
		assert.ok(resClose.text.endsWith(`\`\`\`ts\n${hunk1}\n\`\`\``));
	});

	it("rejects mismatched lines, non-contiguous numbers, short/out-of-range hunks, and fenced headings", () => {
		const reads = new ReadIndex();
		const partialRead = makeView(1, fileLines.slice(0, 10));
		reads.record(resolve(cwd, "src/app.ts"), "read-1", partialRead);
		const ctx: ContextResults = new Map([["read-1", partialRead.body]]);

		const badLines = [...fileLines.slice(0, 8)];
		badLines[3] = "DIFFERENT";
		const nonContiguous = [
			`1\t${fileLines[0]}`,
			`3\t${fileLines[2]}`,
			...fileLines.slice(3, 10).map((l, i) => `${i + 4}\t${l}`),
		].join("\n");

		for (const hunk of [
			makeNumberedHunk(1, badLines),
			nonContiguous,
			makeNumberedHunk(0, fileLines.slice(0, 8)),
			makeNumberedHunk(1, fileLines.slice(0, 2)),
			makeNumberedHunk(5, fileLines.slice(4, 15)),
		]) {
			const input = `**\`src/app.ts\`**\n\n\`\`\`ts\n${hunk}\n\`\`\``;
			assert.equal(dedupReadExcerpts(input, cwd, reads, () => ctx).omitted, 0);
		}

		const validHunk = makeNumberedHunk(1, fileLines.slice(0, 8));
		const fencedHeading = `\`\`\`md\n**\`src/app.ts\`**\n\`\`\`\n\n\`\`\`ts\n${validHunk}\n\`\`\``;
		assert.equal(
			dedupReadExcerpts(fencedHeading, cwd, reads, () => ctx).omitted,
			0,
		);
	});
});
