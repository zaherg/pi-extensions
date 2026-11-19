import assert from "node:assert/strict";
import test from "node:test";
import { Ledger, parseEntry, type Sample } from "../outcomes.ts";

const sample = (overrides: Partial<Sample>): Sample => ({
	tool: "bash",
	category: "terminal",
	mechanism: "rtk:terminal",
	outcome: "filtered",
	bytesBefore: 1000,
	bytesAfter: 400,
	...overrides,
});

test("ledger merges identical outcomes and clears on drain", () => {
	const ledger = new Ledger();
	assert.equal(ledger.drain(), undefined);
	ledger.record(sample({}));
	ledger.record(sample({ bytesBefore: 3000, bytesAfter: 1000 }));
	ledger.record(
		sample({
			outcome: "failed",
			reason: "boundaries",
			bytesBefore: 900,
			bytesAfter: 900,
		}),
	);
	ledger.record(
		sample({
			tool: "read",
			category: "read",
			mechanism: "read-dedup",
			bytesBefore: 9000,
			bytesAfter: 300,
		}),
	);
	assert.deepEqual(ledger.drain(), {
		version: 1,
		tallies: [
			{
				tool: "bash",
				category: "terminal",
				mechanism: "rtk:terminal",
				outcome: "filtered",
				count: 2,
				bytesBefore: 4000,
				bytesAfter: 1400,
			},
			{
				tool: "bash",
				category: "terminal",
				mechanism: "rtk:terminal",
				outcome: "failed",
				reason: "boundaries",
				count: 1,
				bytesBefore: 900,
				bytesAfter: 900,
			},
			{
				tool: "read",
				category: "read",
				mechanism: "read-dedup",
				outcome: "filtered",
				count: 1,
				bytesBefore: 9000,
				bytesAfter: 300,
			},
		],
	});
	assert.equal(ledger.drain(), undefined);
});

test("persisted entries round-trip exactly through JSON", () => {
	const ledger = new Ledger();
	ledger.record(
		sample({
			tool: "grep",
			category: "listing",
			mechanism: "rtk:listing+grep-group",
		}),
	);
	ledger.record(
		sample({
			outcome: "failed",
			reason: "recovery",
			bytesBefore: 600,
			bytesAfter: 600,
		}),
	);
	const data = ledger.drain();
	assert.deepEqual(parseEntry(JSON.parse(JSON.stringify(data))), data);
});

const valid = {
	tool: "bash",
	category: "terminal",
	mechanism: "rtk:terminal",
	outcome: "filtered",
	count: 1,
	bytesBefore: 10,
	bytesAfter: 5,
};

test("rejects corrupt or unsupported entries instead of repairing them", () => {
	const entry = (tally: Record<string, unknown>, extra = {}) => ({
		version: 1,
		tallies: [tally],
		...extra,
	});
	assert.notEqual(parseEntry(entry(valid)), undefined);
	const invalid: [string, unknown][] = [
		["not an object", "x"],
		["future version", { version: 2, tallies: [valid] }],
		["empty tallies", { version: 1, tallies: [] }],
		["unknown entry field", entry(valid, { note: "x" })],
		["unknown tally field", entry({ ...valid, text: "secret" })],
		["empty tool", entry({ ...valid, tool: "" })],
		["unknown category", entry({ ...valid, category: "edit" })],
		["missing mechanism", entry({ ...valid, mechanism: undefined })],
		["malformed mechanism", entry({ ...valid, mechanism: "Rtk Terminal" })],
		["unknown outcome", entry({ ...valid, outcome: "skipped" })],
		[
			"failure without reason",
			entry({ ...valid, outcome: "failed", bytesAfter: 10 }),
		],
		["reason without failure", entry({ ...valid, reason: "timeout" })],
		[
			"unknown reason",
			entry({ ...valid, outcome: "failed", reason: "nope", bytesAfter: 10 }),
		],
		["zero count", entry({ ...valid, count: 0 })],
		["fractional count", entry({ ...valid, count: 1.5 })],
		["negative bytes", entry({ ...valid, bytesBefore: -1 })],
		["filtered but not smaller", entry({ ...valid, bytesAfter: 10 })],
		["unchanged but different size", entry({ ...valid, outcome: "unchanged" })],
	];
	for (const [label, data] of invalid)
		assert.equal(parseEntry(data), undefined, label);
});
