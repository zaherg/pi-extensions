import { FAILURES, type Failure } from "./bridge.ts";
import type { Category } from "./policy.ts";

/** Session entry type; entries never reach the model. */
export const ENTRY_TYPE = "rtk-pi-extended";
const ENTRY_VERSION = 1;
const CATEGORIES: readonly Category[] = [
	"read",
	"terminal",
	"listing",
	"generic",
];
const OUTCOMES = ["filtered", "unchanged", "failed"] as const;
// One or more mechanism names joined by `+`, such as `rtk:listing+grep-group`.
const MECHANISM = /^[a-z][a-z-]*(?::[a-z-]+)?(?:\+[a-z][a-z-]*(?::[a-z-]+)?)*$/;

export type Outcome = (typeof OUTCOMES)[number];

/**
 * Aggregated results for one tool, category, mechanism, outcome, and failure
 * reason. Only `filtered` tallies count as savings.
 */
export interface Tally {
	tool: string;
	category: Category;
	/** What produced (or would have produced) the replacement. */
	mechanism: string;
	outcome: Outcome;
	reason?: Failure;
	count: number;
	/** UTF-8 bytes of the original result text. */
	bytesBefore: number;
	/** UTF-8 bytes of the text Pi kept (the original unless filtered). */
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

/** Merge tallies with the same identity; counts and byte totals add. */
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
	const category = CATEGORIES.find((candidate) => candidate === value.category);
	const outcome = OUTCOMES.find((candidate) => candidate === value.outcome);
	const failure = FAILURES.find((candidate) => candidate === reason);
	if (typeof tool !== "string" || tool === "") return undefined;
	if (typeof mechanism !== "string" || !MECHANISM.test(mechanism))
		return undefined;
	if (category === undefined || outcome === undefined) return undefined;
	// Only failures carry a reason, and every failure has a known one.
	if (reason !== undefined && failure === undefined) return undefined;
	if ((outcome === "failed") !== (failure !== undefined)) return undefined;
	const identity = { tool, category, mechanism, outcome };
	return failure === undefined ? identity : { ...identity, reason: failure };
}

function validSizes(outcome: Outcome, before: number, after: number): boolean {
	// Only accepted replacements are smaller; other outcomes keep the original.
	return outcome === "filtered" ? after < before : after === before;
}

function parseTally(value: unknown): Tally | undefined {
	if (!isRecord(value)) return undefined;
	if (Object.keys(value).some((field) => !TALLY_FIELDS.has(field)))
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

/** Validate persisted entry data; `undefined` marks an unsupported or corrupt entry. */
export function parseEntry(data: unknown): EntryData | undefined {
	if (!isRecord(data) || data.version !== ENTRY_VERSION) return undefined;
	if (
		Object.keys(data).some(
			(field) => field !== "version" && field !== "tallies",
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
