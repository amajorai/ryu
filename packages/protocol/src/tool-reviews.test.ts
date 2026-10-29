import { describe, expect, test } from "bun:test";
import cases from "./fixtures/tool-reviews-cases-v1.json" with { type: "json" };
import {
	callReviewable,
	canonicalIssues,
	MIN_REVIEWERS_SHOWN,
	type ReviewRow,
	type ReviewSummary,
	reviewFeedSchema,
	reviewReportSchema,
	reviewRowSchema,
	reviewSubmissionSchema,
	summarizeReviews,
	TOOL_REVIEWS_CONTRACT_VERSION,
	TOOL_REVIEWS_FEED_TYPE,
	TOOL_REVIEWS_REPORT_TYPE,
} from "./tool-reviews.ts";

const DAY_MS = 24 * 60 * 60_000;
const now = Date.parse(cases.now);

describe("tool reviews shared cases", () => {
	test("the case file matches this contract version", () => {
		expect(cases.version).toBe(TOOL_REVIEWS_CONTRACT_VERSION);
	});

	for (const shared of cases.submissions) {
		test(`submission: ${shared.name}`, () => {
			expect(reviewSubmissionSchema.safeParse(shared.input).success).toBe(
				shared.ok
			);
		});
	}

	for (const shared of cases.reviewable) {
		test(`reviewable: ${shared.name}`, () => {
			expect(callReviewable(now - shared.callDaysAgo * DAY_MS, now)).toBe(
				shared.reviewable
			);
		});
	}

	for (const shared of cases.summaries) {
		test(`summary: ${shared.name}`, () => {
			const rows = shared.rows.map((row) => reviewRowSchema.parse(row));
			// JSON widens the issue names to strings; the values are compared.
			const expected = shared.summaries as unknown as Record<
				string,
				ReviewSummary
			>;
			expect(Object.fromEntries(summarizeReviews(rows, now))).toEqual(expected);
		});
	}
});

describe("tool reviews wire shapes", () => {
	const row: ReviewRow = {
		at: "2026-10-20T12:00:00.000Z",
		issues: ["slow"],
		key: "brave.web.search",
		outcome: "partial",
		rating: 3,
		reviewId: `rvw_${"a".repeat(32)}`,
		reviewer: "b".repeat(32),
		withdrawn: false,
	};

	test("a report carries rows without comments or tenants", () => {
		const report = {
			reporter: "connect-prod-1",
			rows: [row],
			type: TOOL_REVIEWS_REPORT_TYPE,
			version: TOOL_REVIEWS_CONTRACT_VERSION,
		};
		expect(reviewReportSchema.safeParse(report).success).toBe(true);
		expect(
			reviewReportSchema.safeParse({
				...report,
				rows: [{ ...row, comment: "secret" }],
			}).success
		).toBe(false);
		expect(
			reviewReportSchema.safeParse({
				...report,
				rows: [{ ...row, reviewer: "org_acme" }],
			}).success
		).toBe(false);
	});

	test("a feed holds summaries by key", () => {
		const feed = {
			entries: Object.fromEntries(
				summarizeReviews(
					Array.from({ length: MIN_REVIEWERS_SHOWN }, (_, index) => ({
						...row,
						reviewId: `rvw_${String(index).padStart(32, "0")}`,
						reviewer: String(index).padStart(32, "0"),
					})),
					now
				)
			),
			generatedAt: new Date(now).toISOString(),
			type: TOOL_REVIEWS_FEED_TYPE,
			version: TOOL_REVIEWS_CONTRACT_VERSION,
		};
		expect(reviewFeedSchema.safeParse(feed).success).toBe(true);
		expect(feed.entries["brave.web.search"]?.shown).toBe(true);
	});

	test("issues are canonical: sorted and unique", () => {
		expect(canonicalIssues(["stale", "error", "stale"])).toEqual([
			"error",
			"stale",
		]);
		expect(canonicalIssues(undefined)).toEqual([]);
	});
});
