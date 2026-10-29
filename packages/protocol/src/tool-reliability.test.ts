import { describe, expect, test } from "bun:test";
import cases from "./fixtures/tool-reliability-cases-v1.json" with {
	type: "json",
};
import {
	compareReliability,
	emptyTally,
	hourStartOf,
	isHourStart,
	latencyBucket,
	mergeTallies,
	outcomeSchema,
	percentileMs,
	recordOutcome,
	reliabilityFeedSchema,
	reliabilityKeyOf,
	reliabilityReportSchema,
	summarizeReliability,
	TOOL_RELIABILITY_CONTRACT_VERSION,
	tallyProblem,
	tallySchema,
} from "./tool-reliability.ts";

describe("tool reliability shared cases", () => {
	test("the case file matches this contract version", () => {
		expect(cases.version).toBe(TOOL_RELIABILITY_CONTRACT_VERSION);
	});

	for (const shared of cases.keys) {
		test(`key: ${JSON.stringify(shared.toolId)}`, () => {
			expect(reliabilityKeyOf(shared.toolId)).toBe(shared.key);
		});
	}

	for (const shared of cases.buckets) {
		test(`bucket: ${shared.latencyMs} ms`, () => {
			expect(latencyBucket(shared.latencyMs)).toBe(shared.bucket);
		});
	}

	for (const shared of cases.percentiles) {
		test(`percentile: ${shared.name}`, () => {
			expect(percentileMs(shared.latency, shared.q)).toBe(shared.ms);
		});
	}

	for (const shared of cases.validation) {
		test(`validation: ${shared.name}`, () => {
			const parsed = tallySchema.safeParse(shared.tally);
			const problem = parsed.success ? tallyProblem(parsed.data) : "shape";
			expect(problem).toBe(shared.problem);
		});
	}

	for (const shared of cases.records) {
		test(`record: ${shared.name}`, () => {
			let tally = emptyTally();
			for (const raw of shared.outcomes) {
				tally = recordOutcome(tally, outcomeSchema.parse(raw));
			}
			expect(tally).toStrictEqual(tallySchema.parse(shared.tally));
			expect(tallyProblem(tally)).toBeNull();
		});
	}

	for (const shared of cases.summaries) {
		test(`summary: ${shared.name}`, () => {
			const sources = Object.fromEntries(
				Object.entries(shared.sources).map(([source, tally]) => [
					source,
					tallySchema.parse(tally),
				])
			);
			expect(summarizeReliability(sources)).toStrictEqual(
				shared.evidence as ReturnType<typeof summarizeReliability>
			);
		});
	}
});

describe("tool reliability rules", () => {
	test("an outcome names a failure class exactly when it failed", () => {
		const at = "2026-10-21T10:00:00.000Z";
		expect(
			outcomeSchema.safeParse({ at, latencyMs: 1, ok: true }).success
		).toBe(true);
		expect(
			outcomeSchema.safeParse({
				at,
				failure: "timeout",
				latencyMs: 1,
				ok: true,
			}).success
		).toBe(false);
		expect(
			outcomeSchema.safeParse({ at, latencyMs: 1, ok: false }).success
		).toBe(false);
	});

	test("merging is order independent and keeps the newest failure", () => {
		const a = recordOutcome(emptyTally(), {
			at: "2026-10-21T10:00:00.000Z",
			failure: "timeout",
			latencyMs: 40_000,
			ok: false,
		});
		const b = recordOutcome(emptyTally(), {
			at: "2026-10-21T11:00:00.000Z",
			failure: "unavailable",
			latencyMs: 10,
			ok: false,
		});
		expect(mergeTallies(a, b)).toStrictEqual(mergeTallies(b, a));
		expect(mergeTallies(a, b).lastFailure).toBe("unavailable");
		expect(mergeTallies()).toStrictEqual(emptyTally());
	});

	test("comparison puts enough evidence first, then rate, then p95", () => {
		const ready = (successRate: number, p95Ms: number) => ({
			...summarizeReliability({}),
			p95Ms,
			samples: 10,
			successRate,
			sufficient: true,
		});
		expect(compareReliability(ready(0.5, 100), null)).toBeLessThan(0);
		expect(
			compareReliability(ready(0.9, 100), ready(0.99, 100))
		).toBeGreaterThan(0);
		expect(compareReliability(ready(0.9, 100), ready(0.9, 500))).toBeLessThan(
			0
		);
		expect(compareReliability(null, undefined)).toBe(0);
	});

	test("hour starts are UTC hours", () => {
		const at = Date.parse("2026-10-21T10:42:13.500Z");
		expect(hourStartOf(at)).toBe("2026-10-21T10:00:00.000Z");
		expect(isHourStart("2026-10-21T10:00:00.000Z")).toBe(true);
		expect(isHourStart("2026-10-21T10:00:01.000Z")).toBe(false);
	});

	test("feed and report shapes are strict", () => {
		const tally = emptyTally();
		const feed = {
			entries: [
				{
					evidence: summarizeReliability({ connect: tally }),
					key: "github.GITHUB_GET_AN_ISSUE",
					sources: { connect: tally },
				},
			],
			generatedAt: "2026-10-21T10:00:00.000Z",
			type: "ryu.tool_reliability",
			version: 3,
			windowDays: 7,
		};
		expect(reliabilityFeedSchema.safeParse(feed).success).toBe(true);
		expect(
			reliabilityFeedSchema.safeParse({ ...feed, tenants: [] }).success
		).toBe(false);
		const report = {
			reporter: "connect-1a2b3c4d",
			rows: [
				{
					hourStart: "2026-10-21T10:00:00.000Z",
					key: "exa.search.auto",
					tally,
				},
			],
			type: "ryu.tool_reliability_report",
		};
		expect(reliabilityReportSchema.safeParse(report).success).toBe(true);
		expect(
			reliabilityReportSchema.safeParse({ ...report, reporter: "X" }).success
		).toBe(false);
	});
});
