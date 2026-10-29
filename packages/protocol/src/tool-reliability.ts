/**
 * Tool reliability evidence (Treg parity B9): how often a tool call worked,
 * how long it took, and when it last failed, folded from real calls.
 *
 * - A **tally** counts one tool's finished calls in a window: calls, failures,
 *   a fixed latency histogram (`LATENCY_BOUNDS_MS`), and the time and class of
 *   the latest success and failure. Tallies from different hours and sources
 *   merge by adding, so no raw sample is ever kept or sent.
 * - **Sources** are `connect` (calls hosted Connect ran) and `gateway` (calls
 *   Core made through the Gateway's tool plane, read from the Gateway audit
 *   rows the control plane ingests). Each source keeps its own tally; the
 *   evidence a caller sees is their sum, with the per-source sample counts.
 * - Only outcomes the tool is answerable for are counted: a call refused
 *   before it ran (credit, policy, a missing connection, a limit) is not an
 *   outcome. The tenant, the arguments and the answer are never recorded.
 * - **Evidence** reports a success rate and p50/p95 latency only once a tool
 *   has `MIN_RELIABILITY_SAMPLES` calls in the window; below that it reports
 *   the sample count and dates alone. Percentiles are bucket upper bounds.
 * - Evidence is keyed by catalog endpoint id where a tool has one
 *   (`composio.GITHUB_GET_AN_ISSUE` and Core's `composio__GITHUB_GET_AN_ISSUE`
 *   both key `github.GITHUB_GET_AN_ISSUE`), else by the tool id itself.
 *
 * Connect keeps a port of this module (`apps/connect/src/tool-reliability.ts`);
 * both are held to `fixtures/tool-reliability-cases-v1.json`.
 */

import { z } from "zod";

export const TOOL_RELIABILITY_CONTRACT_VERSION = 1;
export const TOOL_RELIABILITY_FEED_TYPE = "ryu.tool_reliability";
export const TOOL_RELIABILITY_REPORT_TYPE = "ryu.tool_reliability_report";

/**
 * Latency histogram bounds in milliseconds. Bucket `i` counts calls that took
 * at most `LATENCY_BOUNDS_MS[i]` and more than the bound before it; the last
 * bucket also holds every slower call.
 */
export const LATENCY_BOUNDS_MS = [
	100, 250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000, 120_000,
] as const;

/** Evidence covers calls in this many trailing days. */
export const RELIABILITY_WINDOW_DAYS = 7;
/** Below this many calls, evidence carries no rate or percentiles. */
export const MIN_RELIABILITY_SAMPLES = 5;
export const MAX_RELIABILITY_KEY_LEN = 160;
export const MAX_RELIABILITY_REPORT_ROWS = 5000;
export const MAX_RELIABILITY_FEED_ENTRIES = 50_000;

export const RELIABILITY_SOURCES = ["connect", "gateway"] as const;
export type ReliabilitySource = (typeof RELIABILITY_SOURCES)[number];

/**
 * Why a counted call failed: `timeout` (no answer in time), `upstream_error`
 * (the vendor answered with an error status), `tool_error` (the tool ran and
 * reported an error result) or `unavailable` (the vendor could not be reached).
 */
export const FAILURE_CLASSES = [
	"timeout",
	"upstream_error",
	"tool_error",
	"unavailable",
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const REPORTER = /^[a-z0-9][a-z0-9-]{7,63}$/u;
const HOUR_MS = 60 * 60_000;

const keySchema = z.string().max(MAX_RELIABILITY_KEY_LEN).regex(KEY);
const instantSchema = z.iso.datetime();
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const tallySchema = z.strictObject({
	calls: countSchema,
	failures: countSchema,
	lastFailure: z.enum(FAILURE_CLASSES).nullable(),
	lastFailureAt: instantSchema.nullable(),
	lastSuccessAt: instantSchema.nullable(),
	latency: z.array(countSchema).length(LATENCY_BOUNDS_MS.length),
});
export type ReliabilityTally = z.output<typeof tallySchema>;

export const outcomeSchema = z
	.strictObject({
		at: instantSchema,
		failure: z.enum(FAILURE_CLASSES).optional(),
		latencyMs: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
		ok: z.boolean(),
	})
	.refine((value) => value.ok === (value.failure === undefined), {
		message: "a failed outcome names its failure class; a success names none",
	});
export type CallOutcomeRecord = z.output<typeof outcomeSchema>;

export const evidenceSchema = z.strictObject({
	failures: countSchema,
	lastFailure: z.enum(FAILURE_CLASSES).nullable(),
	lastFailureAt: instantSchema.nullable(),
	lastSuccessAt: instantSchema.nullable(),
	p50Ms: countSchema.nullable(),
	p95Ms: countSchema.nullable(),
	samples: countSchema,
	sources: z.strictObject({
		connect: countSchema.optional(),
		gateway: countSchema.optional(),
	}),
	successRate: z.number().min(0).max(1).nullable(),
	sufficient: z.boolean(),
	windowDays: z.number().int().positive(),
});
export type ReliabilityEvidence = z.output<typeof evidenceSchema>;

const sourcesSchema = z.strictObject({
	connect: tallySchema.optional(),
	gateway: tallySchema.optional(),
});
export type SourceTallies = z.output<typeof sourcesSchema>;

export const reliabilityFeedSchema = z.strictObject({
	entries: z
		.array(
			z.strictObject({
				evidence: evidenceSchema,
				key: keySchema,
				sources: sourcesSchema,
			})
		)
		.max(MAX_RELIABILITY_FEED_ENTRIES),
	generatedAt: instantSchema,
	type: z.literal(TOOL_RELIABILITY_FEED_TYPE),
	version: z.number().int().nonnegative(),
	windowDays: z.number().int().positive(),
});
export type ReliabilityFeed = z.output<typeof reliabilityFeedSchema>;

/**
 * One reporter's hourly tallies. A row is the reporter's whole tally for
 * that key and hour so far, so a resent row replaces, never adds.
 */
export const reliabilityReportSchema = z.strictObject({
	reporter: z.string().regex(REPORTER),
	rows: z
		.array(
			z.strictObject({
				hourStart: instantSchema,
				key: keySchema,
				tally: tallySchema,
			})
		)
		.max(MAX_RELIABILITY_REPORT_ROWS),
	type: z.literal(TOOL_RELIABILITY_REPORT_TYPE),
});
export type ReliabilityReport = z.output<typeof reliabilityReportSchema>;

/** Whether `key` may key reliability evidence. */
export const isReliabilityKey = (key: string): boolean =>
	key.length <= MAX_RELIABILITY_KEY_LEN && KEY.test(key);

/**
 * The evidence key of a tool id: a Composio-shaped id (`composio.<SLUG>` or
 * Core's `composio__<SLUG>`) keys its catalog endpoint `<toolkit>.<SLUG>`,
 * whose toolkit is the slug's first word in lower case; any other valid id
 * keys itself. Null when the id cannot key evidence.
 */
export const reliabilityKeyOf = (toolId: string): string | null => {
	const prefix = ["composio.", "composio__"].find((candidate) =>
		toolId.startsWith(candidate)
	);
	if (prefix !== undefined) {
		const slug = toolId.slice(prefix.length);
		const toolkit = (slug.split("_", 1)[0] ?? "").toLowerCase();
		const key = `${toolkit}.${slug}`;
		return toolkit && slug && isReliabilityKey(key) ? key : null;
	}
	return isReliabilityKey(toolId) ? toolId : null;
};

/** A tally with no calls. */
export const emptyTally = (): ReliabilityTally => ({
	calls: 0,
	failures: 0,
	lastFailure: null,
	lastFailureAt: null,
	lastSuccessAt: null,
	latency: LATENCY_BOUNDS_MS.map(() => 0),
});

/** The histogram bucket a latency falls in. */
export const latencyBucket = (latencyMs: number): number => {
	const index = LATENCY_BOUNDS_MS.findIndex((bound) => latencyMs <= bound);
	return index === -1 ? LATENCY_BOUNDS_MS.length - 1 : index;
};

const later = (left: string | null, right: string | null): string | null => {
	if (left === null) {
		return right;
	}
	if (right === null) {
		return left;
	}
	return Date.parse(right) > Date.parse(left) ? right : left;
};

/** The first rule a tally breaks, or null. */
export const tallyProblem = (tally: ReliabilityTally): string | null => {
	if (tally.failures > tally.calls) {
		return "failures_exceed_calls";
	}
	if (tally.latency.reduce((sum, count) => sum + count, 0) !== tally.calls) {
		return "latency_count_mismatch";
	}
	if ((tally.lastFailure === null) !== (tally.lastFailureAt === null)) {
		return "last_failure_incomplete";
	}
	if (tally.lastFailureAt !== null && tally.failures === 0) {
		return "failure_date_without_failures";
	}
	if (tally.lastSuccessAt !== null && tally.calls === tally.failures) {
		return "success_date_without_successes";
	}
	return null;
};

/** `tally` with one more finished call. */
export const recordOutcome = (
	tally: ReliabilityTally,
	outcome: CallOutcomeRecord
): ReliabilityTally => {
	const latency = [...tally.latency];
	const bucket = latencyBucket(outcome.latencyMs);
	latency[bucket] = (latency[bucket] ?? 0) + 1;
	if (outcome.ok) {
		return {
			...tally,
			calls: tally.calls + 1,
			lastSuccessAt: later(tally.lastSuccessAt, outcome.at),
			latency,
		};
	}
	const newer = later(tally.lastFailureAt, outcome.at) !== tally.lastFailureAt;
	return {
		...tally,
		calls: tally.calls + 1,
		failures: tally.failures + 1,
		lastFailure: newer ? (outcome.failure ?? "tool_error") : tally.lastFailure,
		lastFailureAt: newer ? outcome.at : tally.lastFailureAt,
		latency,
	};
};

/** The sum of `tallies`; the latest dates win. */
export const mergeTallies = (
	...tallies: readonly ReliabilityTally[]
): ReliabilityTally => {
	let merged = emptyTally();
	for (const tally of tallies) {
		const newerFailure =
			later(merged.lastFailureAt, tally.lastFailureAt) !== merged.lastFailureAt;
		merged = {
			calls: merged.calls + tally.calls,
			failures: merged.failures + tally.failures,
			lastFailure: newerFailure ? tally.lastFailure : merged.lastFailure,
			lastFailureAt: newerFailure ? tally.lastFailureAt : merged.lastFailureAt,
			lastSuccessAt: later(merged.lastSuccessAt, tally.lastSuccessAt),
			latency: merged.latency.map(
				(count, index) => count + (tally.latency[index] ?? 0)
			),
		};
	}
	return merged;
};

/**
 * The latency at quantile `q` (0 to 1) as the upper bound of the bucket that
 * holds the `ceil(q * calls)`-th fastest call; null for no calls.
 */
export const percentileMs = (
	latency: readonly number[],
	q: number
): number | null => {
	const total = latency.reduce((sum, count) => sum + count, 0);
	if (total === 0) {
		return null;
	}
	const rank = Math.max(1, Math.ceil(q * total));
	let seen = 0;
	for (const [index, count] of latency.entries()) {
		seen += count;
		if (seen >= rank) {
			return LATENCY_BOUNDS_MS[index] ?? null;
		}
	}
	return LATENCY_BOUNDS_MS.at(-1) ?? null;
};

/** What a search or describe row says about a tool's real calls. */
export const summarizeReliability = (
	sources: SourceTallies,
	windowDays: number = RELIABILITY_WINDOW_DAYS
): ReliabilityEvidence => {
	const present = RELIABILITY_SOURCES.flatMap((source) => {
		const tally = sources[source];
		return tally ? [[source, tally] as const] : [];
	});
	const total = mergeTallies(...present.map(([, tally]) => tally));
	const sufficient = total.calls >= MIN_RELIABILITY_SAMPLES;
	const counts: ReliabilityEvidence["sources"] = {};
	for (const [source, tally] of present) {
		counts[source] = tally.calls;
	}
	return {
		failures: total.failures,
		lastFailure: total.lastFailure,
		lastFailureAt: total.lastFailureAt,
		lastSuccessAt: total.lastSuccessAt,
		p50Ms: sufficient ? percentileMs(total.latency, 0.5) : null,
		p95Ms: sufficient ? percentileMs(total.latency, 0.95) : null,
		samples: total.calls,
		sources: counts,
		successRate: sufficient
			? Math.round(((total.calls - total.failures) / total.calls) * 10_000) /
				10_000
			: null,
		sufficient,
		windowDays,
	};
};

/**
 * Order two tools for a comparison row: tools with enough evidence first,
 * then the higher success rate, then the lower p95. Zero means no preference.
 */
export const compareReliability = (
	left: ReliabilityEvidence | null | undefined,
	right: ReliabilityEvidence | null | undefined
): number => {
	const leftReady = left?.sufficient === true;
	const rightReady = right?.sufficient === true;
	if (leftReady !== rightReady) {
		return leftReady ? -1 : 1;
	}
	if (!(leftReady && left && right)) {
		return 0;
	}
	const rate = (right.successRate ?? 0) - (left.successRate ?? 0);
	if (rate !== 0) {
		return rate;
	}
	return (left.p95Ms ?? 0) - (right.p95Ms ?? 0);
};

/** The start of the UTC hour holding `at` (milliseconds since the epoch). */
export const hourStartOf = (at: number): string =>
	new Date(Math.floor(at / HOUR_MS) * HOUR_MS).toISOString();

/** Whether `value` is an instant on the hour. */
export const isHourStart = (value: string): boolean => {
	const at = Date.parse(value);
	return Number.isFinite(at) && at % HOUR_MS === 0;
};
