import { FAILURES, type Failure } from "./bridge.ts";
import type { Category } from "./policy.ts";

/** Custom session entry type for persisted outcome tallies. */
export const ENTRY_TYPE = "rtk-pi-extended";
const ENTRY_VERSION = 1;
const CATEGORIES: readonly Category[] = [
	"read",
	"terminal",
	"listing",
	"generic",
];
const OUTCOMES = ["filtered", "unchanged", "failed"] as const;
// Match one or more mechanism names joined by `+`, such as `rtk:listing+grep-group`.
const MECHANISM = /^[a-z][a-z-]*(?::[a-z-]+)?(?:\+[a-z][a-z-]*(?::[a-z-]+)?)*$/;

export type Outcome = (typeof OUTCOMES)[number];

/** Aggregated byte and result counts for one tool, category, mechanism, and outcome. */
export interface Tally {
	tool: string;
	category: Category;
	/** Mechanism chain that produced or attempted the replacement. */
	mechanism: string;
	outcome: Outcome;
	reason?: Failure;
	count: number;
	/** UTF-8 bytes of the original result text. */
	bytesBefore: number;
	/** UTF-8 bytes of the retained result text. */
	bytesAfter: number;
}

export type Sample = Omit<Tally, "count">;

export interface EntryData {
	version: typeof ENTRY_VERSION;
	tallies: Tally[];
}

function key(tally: Sample): string {
	return JSON.stringify([
		tally.tool,
		tally.category,
		tally.mechanism,
		tally.outcome,
		tally.reason,
	]);
}

/** Merge a tally into the map by adding counts and byte totals for matching keys. */
export function mergeTallies(target: Map<string, Tally>, tally: Tally): void {
	const id = key(tally);
	const current = target.get(id);
	if (!current) {
		target.set(id, { ...tally });
		return;
	}
	current.count += tally.count;
	current.bytesBefore += tally.bytesBefore;
	current.bytesAfter += tally.bytesAfter;
}

/** Accumulates outcomes between turn boundaries. */
export class Ledger {
	readonly #tallies = new Map<string, Tally>();

	record(sample: Sample): void {
		mergeTallies(this.#tallies, { ...sample, count: 1 });
	}

	clear(): void {
		this.#tallies.clear();
	}

	/** Return pending tallies as entry data and clear them. */
	drain(): EntryData | undefined {
		if (this.#tallies.size === 0) return undefined;
		const tallies = [...this.#tallies.values()];
		this.#tallies.clear();
		return { version: ENTRY_VERSION, tallies };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const TALLY_FIELDS = new Set([
	"tool",
	"category",
	"mechanism",
	"outcome",
	"reason",
	"count",
	"bytesBefore",
	"bytesAfter",
]);

type Identity = Pick<
	Tally,
	"tool" | "category" | "mechanism" | "outcome" | "reason"
>;

function parseIdentity(value: Record<string, unknown>): Identity | undefined {
	const { tool, mechanism, reason } = value;
	const category = CATEGORIES.find(
		(candidate: Category) => candidate === value.category,
	);
	const outcome = OUTCOMES.find(
		(candidate: Outcome) => candidate === value.outcome,
	);
	const failure = FAILURES.find((candidate: Failure) => candidate === reason);
	if (typeof tool !== "string" || tool === "") return undefined;
	if (typeof mechanism !== "string" || !MECHANISM.test(mechanism))
		return undefined;
	if (category === undefined || outcome === undefined) return undefined;
	// Require known failure reasons exclusively on failed outcomes.
	if (reason !== undefined && failure === undefined) return undefined;
	if ((outcome === "failed") !== (failure !== undefined)) return undefined;
	const identity = { tool, category, mechanism, outcome };
	return failure === undefined ? identity : { ...identity, reason: failure };
}

function validSizes(outcome: Outcome, before: number, after: number): boolean {
	// Accepted replacements must shrink the output while other outcomes preserve size.
	return outcome === "filtered" ? after < before : after === before;
}

function parseTally(value: unknown): Tally | undefined {
	if (!isRecord(value)) return undefined;
	if (Object.keys(value).some((field: string) => !TALLY_FIELDS.has(field)))
		return undefined;
	const identity = parseIdentity(value);
	const { count, bytesBefore, bytesAfter } = value;
	if (
		!identity ||
		!isCount(count) ||
		count === 0 ||
		!isCount(bytesBefore) ||
		!isCount(bytesAfter) ||
		!validSizes(identity.outcome, bytesBefore, bytesAfter)
	)
		return undefined;
	return { ...identity, count, bytesBefore, bytesAfter };
}

/** Parse and validate persisted outcome entry data. */
export function parseEntry(data: unknown): EntryData | undefined {
	if (!isRecord(data) || data.version !== ENTRY_VERSION) return undefined;
	if (
		Object.keys(data).some(
			(field: string) => field !== "version" && field !== "tallies",
		)
	)
		return undefined;
	if (!Array.isArray(data.tallies) || data.tallies.length === 0)
		return undefined;
	const tallies: Tally[] = [];
	for (const value of data.tallies) {
		const tally = parseTally(value);
		if (!tally) return undefined;
		tallies.push(tally);
	}
	return { version: ENTRY_VERSION, tallies };
}
