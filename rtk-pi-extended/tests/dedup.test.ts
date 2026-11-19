import assert from "node:assert/strict";
import test from "node:test";
import {
	ANY_START,
	dedupPassages,
	MIN_PASSAGE_BYTES,
	PassageIndex,
	ReadIndex,
} from "../dedup.ts";
import type { ReadView } from "../views.ts";

function view(start: number, lines: string[]): ReadView {
	return { start, lines, body: lines.join("\n") };
}

const file = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
const range = (from: number, to: number) => file.slice(from - 1, to);

test("finds earlier reads that share identical lines, largest overlap first", () => {
	const index = new ReadIndex();
	index.record("/a", "first", view(1, range(1, 50)));
	index.record("/a", "second", view(40, range(40, 100)));
	index.record("/b", "other", view(1, range(1, 100)));
	const contained = index.overlaps("/a", view(10, range(10, 20)));
	assert.deepEqual(
		contained.map(({ source, from, to }) => [source.toolCallId, from, to]),
		[["first", 10, 20]],
	);
	const spanning = index.overlaps("/a", view(30, range(30, 70)));
	assert.deepEqual(
		spanning.map(({ source, from, to }) => [source.toolCallId, from, to]),
		[
			["second", 40, 70],
			["first", 30, 50],
		],
	);
	assert.deepEqual(index.overlaps("/a", view(101, ["x"])), []);
});

test("ignores reads whose shared lines differ", () => {
	const index = new ReadIndex();
	index.record("/a", "old", view(1, range(1, 50)));
	const changed = range(1, 50);
	changed[24] = "edited";
	assert.deepEqual(index.overlaps("/a", view(1, changed)), []);
	assert.equal(index.overlaps("/a", view(26, range(26, 50))).length, 1);
});

test("newest equal source wins", () => {
	const index = new ReadIndex();
	index.record("/a", "older", view(1, range(1, 10)));
	index.record("/a", "newer", view(1, range(1, 10)));
	assert.equal(
		index.overlaps("/a", view(1, range(1, 10)))[0]?.source.toolCallId,
		"newer",
	);
});

test("forces the exact text once after a replaced delivery", () => {
	const index = new ReadIndex();
	index.markReplaced("/a", 1);
	index.markReplaced("/a", 500);
	assert.equal(index.forcesFull("/a", 1), true);
	assert.equal(index.forcesFull("/a", 500), true);
	assert.equal(index.forcesFull("/a", 2), false);
	assert.equal(index.forcesFull("/b", 1), false);
	index.record("/a", "exact", view(1, ["x"]));
	assert.equal(index.forcesFull("/a", 1), false);
	assert.equal(index.forcesFull("/a", 500), true);
	// A Bash file view is followed by a read at any offset.
	index.markReplaced("/c", ANY_START);
	assert.equal(index.forcesFull("/c", 1234), true);
	index.record("/c", "exact", view(1234, ["y"]));
	assert.equal(index.forcesFull("/c", 7), false);
});

test("invalidation and clearing forget a path's reads and forced re-reads", () => {
	const index = new ReadIndex();
	index.record("/a", "first", view(1, range(1, 10)));
	index.record("/b", "other", view(1, range(1, 10)));
	index.markReplaced("/a", 1);
	index.invalidate("/a");
	assert.deepEqual(index.overlaps("/a", view(1, range(1, 10))), []);
	assert.equal(index.forcesFull("/a", 1), false);
	assert.equal(index.overlaps("/b", view(1, range(1, 10))).length, 1);
	index.clear();
	assert.deepEqual(index.overlaps("/b", view(1, range(1, 10))), []);
});

test("evicts the oldest reads beyond 16M indexed characters", () => {
	const index = new ReadIndex();
	const big = (tag: string) => [tag + "x".repeat(6 * 1024 * 1024)];
	index.record("/1", "one", view(1, big("1")));
	index.record("/2", "two", view(1, big("2")));
	index.record("/3", "three", view(1, big("3")));
	assert.deepEqual(index.overlaps("/1", view(1, big("1"))), []);
	assert.equal(index.overlaps("/2", view(1, big("2"))).length, 1);
	assert.equal(index.overlaps("/3", view(1, big("3"))).length, 1);
});

const passage = (tag: string) => `${tag} ${"p".repeat(MIN_PASSAGE_BYTES)}`;

test("omits long passages the model still sees in an earlier result of the same tool", () => {
	const index = new PassageIndex();
	const earlier = [passage("A"), passage("B"), "short"].join("\n\n");
	index.record("mcp__x", "call-1", earlier);
	const context = new Map([["call-1", earlier]]);
	const text = [
		passage("A"),
		passage("B"),
		"short",
		passage("C"),
		passage("A"),
	].join("\n\n");
	const result = dedupPassages("mcp__x", text, index, () => context);
	assert.equal(result.omitted, 2);
	const bytes = 2 * Buffer.byteLength(passage("A"));
	assert.equal(
		result.text,
		[
			`[rtk-pi-extended: 2 passage(s), ${bytes} bytes, omitted; identical text is in the mcp__x result of tool call call-1 earlier in this conversation]`,
			"short",
			passage("C"),
			// The final passage is always kept, so trailing notices survive.
			passage("A"),
		].join("\n\n"),
	);
});

test("attributes adjacent passages from different tool calls separately and extends matching ones", () => {
	const index = new PassageIndex();
	const a = passage("A");
	const b = passage("B");
	index.record("mcp__x", "call-1", [a, b].join("\n\n"));
	index.record("mcp__x", "call-2", b);
	const context = new Map([
		["call-1", [a, b].join("\n\n")],
		["call-2", b],
	]);
	// Both A and B are in call-1, so B extends call-1's marker instead of splitting to call-2.
	const merged = dedupPassages(
		"mcp__x",
		[a, b, "tail"].join("\n\n"),
		index,
		() => context,
	);
	assert.equal(merged.omitted, 2);
	const bytes = Buffer.byteLength(a);
	assert.equal(
		merged.text,
		[
			`[rtk-pi-extended: 2 passage(s), ${bytes * 2} bytes, omitted; identical text is in the mcp__x result of tool call call-1 earlier in this conversation]`,
			"tail",
		].join("\n\n"),
	);

	// When call-1 does NOT contain B, A and B emit separate markers for call-1 and call-2.
	const splitIndex = new PassageIndex();
	splitIndex.record("mcp__x", "call-1", a);
	splitIndex.record("mcp__x", "call-2", b);
	const splitContext = new Map([
		["call-1", a],
		["call-2", b],
	]);
	const split = dedupPassages(
		"mcp__x",
		[a, b, "tail"].join("\n\n"),
		splitIndex,
		() => splitContext,
	);
	assert.equal(split.omitted, 2);
	assert.equal(
		split.text,
		[
			`[rtk-pi-extended: 1 passage(s), ${bytes} bytes, omitted; identical text is in the mcp__x result of tool call call-1 earlier in this conversation]`,
			`[rtk-pi-extended: 1 passage(s), ${bytes} bytes, omitted; identical text is in the mcp__x result of tool call call-2 earlier in this conversation]`,
			"tail",
		].join("\n\n"),
	);
});

test("never points at results the model no longer sees or at another tool", () => {
	const index = new PassageIndex();
	index.record("mcp__x", "call-1", passage("A"));
	const text = [passage("A"), "end"].join("\n\n");
	assert.equal(
		dedupPassages("mcp__x", text, index, () => new Map()).omitted,
		0,
	);
	assert.equal(
		dedupPassages(
			"mcp__x",
			text,
			index,
			() => new Map([["call-1", "compacted"]]),
		).omitted,
		0,
	);
	assert.equal(
		dedupPassages(
			"mcp__y",
			text,
			index,
			() => new Map([["call-1", passage("A")]]),
		).omitted,
		0,
	);
	assert.equal(
		dedupPassages(
			"mcp__x",
			text,
			index,
			() => new Map([["call-1", passage("A")]]),
		).omitted,
		1,
	);
});
