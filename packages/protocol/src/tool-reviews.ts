/**
 * Agent usefulness reviews of tool endpoints (Treg parity C7).
 *
 * - A **review** rates one real call: the caller names the Connect call id
 *   (`call_<32 hex>`) of a call it made, and Connect accepts the review only
 *   when its own call journal holds that call for that caller and endpoint.
 *   One review per call; a resubmission replaces it, a withdrawal hides it.
 * - A review carries a 1-5 `rating`, an `outcome` (`useful`, `partial`,
 *   `not_useful`), up to four `issues` from a fixed list and an optional
 *   comment. The comment never leaves the Connect that took it: reports and
 *   feeds carry ratings, outcomes and issues only.
 * - **Reviewers** are opaque: Connect reports a keyed hash of the reviewing
 *   organization (a team tenant counts as its organization), never a tenant
 *   id. Every reviewer weighs the same in a summary however many calls they
 *   reviewed, so one organization cannot outvote others by calling more.
 * - A **summary** covers the trailing `REVIEW_WINDOW_DAYS`. Its rating,
 *   outcome shares and issue shares are shown only once `MIN_REVIEWERS_SHOWN`
 *   distinct reviewers rated the endpoint; below that only the counts are.
 *
 * Connect keeps a copy of this module (`apps/connect/src/tool-reviews.ts`)
 * held identical below the header, and both answer the shared cases in
 * `fixtures/tool-reviews-cases-v1.json`.
 */

import { z } from "zod";

export const TOOL_REVIEWS_CONTRACT_VERSION = 1;
export const TOOL_REVIEWS_FEED_TYPE = "ryu.tool_reviews";
export const TOOL_REVIEWS_REPORT_TYPE = "ryu.tool_review_report";

/** What the call did for the reviewer. */
export const REVIEW_OUTCOMES = ["useful", "partial", "not_useful"] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

/** Structured problems a reviewer may flag. */
export const REVIEW_ISSUES = [
	"bad_format",
	"error",
	"incomplete",
	"overpriced",
	"slow",
	"stale",
	"wrong_results",
] as const;
export type ReviewIssue = (typeof REVIEW_ISSUES)[number];

/** Below this many distinct reviewers a summary shows counts only. */
export const MIN_REVIEWERS_SHOWN = 5;
/** Summaries cover reviews written in this many trailing days. */
export const REVIEW_WINDOW_DAYS = 90;
/** A call may be reviewed for this many days after it ran. */
export const REVIEWABLE_CALL_DAYS = 30;
export const MAX_REVIEW_ISSUES = 4;
export const MAX_REVIEW_COMMENT_LENGTH = 500;
export const MAX_REVIEW_KEY_LEN = 160;
export const MAX_REVIEW_REPORT_ROWS = 5000;
export const MAX_REVIEW_FEED_ENTRIES = 50_000;
/** Issues listed in a shown summary, most flagged first. */
export const MAX_SUMMARY_ISSUES = 3;

const DAY_MS = 24 * 60 * 60_000;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const CALL_ID = /^call_[0-9a-f]{32}$/u;
const REVIEW_ID = /^rvw_[0-9a-f]{32}$/u;
const REVIEWER = /^[0-9a-f]{32}$/u;
const REPORTER = /^[a-z0-9][a-z0-9-]{7,63}$/u;

export const reviewKeySchema = z
	.string()
	.min(1)
	.max(MAX_REVIEW_KEY_LEN)
	.regex(KEY);

const issuesSchema = z
	.array(z.enum(REVIEW_ISSUES))
	.max(MAX_REVIEW_ISSUES)
	.refine((issues) => new Set(issues).size === issues.length, {
		message: "issues must not repeat",
	});

/** What a caller submits: `POST /v1/reviews` on Connect. */
export const reviewSubmissionSchema = z.strictObject({
	callId: z.string().regex(CALL_ID),
	comment: z.string().trim().min(1).max(MAX_REVIEW_COMMENT_LENGTH).optional(),
	issues: issuesSchema.optional(),
	outcome: z.enum(REVIEW_OUTCOMES),
	rating: z.number().int().min(1).max(5),
});
export type ReviewSubmission = z.output<typeof reviewSubmissionSchema>;

/** One review as reports carry it: no comment, no tenant. */
export const reviewRowSchema = z.strictObject({
	at: z.iso.datetime(),
	issues: issuesSchema,
	key: reviewKeySchema,
	outcome: z.enum(REVIEW_OUTCOMES),
	rating: z.number().int().min(1).max(5),
	reviewId: z.string().regex(REVIEW_ID),
	reviewer: z.string().regex(REVIEWER),
	withdrawn: z.boolean(),
});
export type ReviewRow = z.output<typeof reviewRowSchema>;

/** Connect's report of reviews that changed since its last report. */
export const reviewReportSchema = z.strictObject({
	reporter: z.string().regex(REPORTER),
	rows: z.array(reviewRowSchema).max(MAX_REVIEW_REPORT_ROWS),
	type: z.literal(TOOL_REVIEWS_REPORT_TYPE),
	version: z.literal(TOOL_REVIEWS_CONTRACT_VERSION),
});
export type ReviewReport = z.output<typeof reviewReportSchema>;

const shareSchema = z.number().min(0).max(1);

export const reviewSummarySchema = z.strictObject({
	issues: z
		.array(z.strictObject({ issue: z.enum(REVIEW_ISSUES), share: shareSchema }))
		.max(MAX_SUMMARY_ISSUES)
		.nullable(),
	lastReviewAt: z.iso.datetime().nullable(),
	minReviewers: z.number().int().positive(),
	outcomes: z
		.strictObject({
			not_useful: shareSchema,
			partial: shareSchema,
			useful: shareSchema,
		})
		.nullable(),
	rating: z.number().min(1).max(5).nullable(),
	reviewers: z.number().int().nonnegative(),
	reviews: z.number().int().nonnegative(),
	shown: z.boolean(),
});
export type ReviewSummary = z.output<typeof reviewSummarySchema>;

/** The control plane's folded summaries (`GET /api/tool-catalog/reviews`). */
export const reviewFeedSchema = z.strictObject({
	entries: z
		.record(reviewKeySchema, reviewSummarySchema)
		.refine(
			(entries) => Object.keys(entries).length <= MAX_REVIEW_FEED_ENTRIES,
			{ message: "too many entries" }
		),
	generatedAt: z.iso.datetime(),
	type: z.literal(TOOL_REVIEWS_FEED_TYPE),
	version: z.literal(TOOL_REVIEWS_CONTRACT_VERSION),
});
export type ReviewFeed = z.output<typeof reviewFeedSchema>;

/** A submission's issues in canonical order (sorted, as rows carry them). */
export const canonicalIssues = (
	issues: readonly ReviewIssue[] | undefined
): ReviewIssue[] => [...new Set(issues ?? [])].sort();

/** Whether a call that ran at `callAtMs` may still be reviewed at `nowMs`. */
export const callReviewable = (callAtMs: number, nowMs: number): boolean =>
	nowMs - callAtMs <= REVIEWABLE_CALL_DAYS * DAY_MS && callAtMs <= nowMs;

const roundTo = (value: number, step: number): number =>
	Math.round(value / step) * step;

/** Rounded to one decimal, without float noise (`4.3`, not `4.300000001`). */
const oneDecimal = (value: number): number =>
	Number(roundTo(value, 0.1).toFixed(1));
const twoDecimals = (value: number): number =>
	Number(roundTo(value, 0.01).toFixed(2));

/** The summary of an endpoint nobody reviewed. */
export const emptyReviewSummary = (): ReviewSummary => ({
	issues: null,
	lastReviewAt: null,
	minReviewers: MIN_REVIEWERS_SHOWN,
	outcomes: null,
	rating: null,
	reviewers: 0,
	reviews: 0,
	shown: false,
});

/**
 * Fold review rows into one summary per key. Withdrawn rows and rows outside
 * the trailing window (or more than an hour ahead of `nowMs`) are ignored; a
 * repeated `reviewId` keeps its last row. Each reviewer's reviews are averaged
 * first, then reviewers are averaged, so every reviewer weighs the same.
 */
export const summarizeReviews = (
	rows: readonly ReviewRow[],
	nowMs: number
): Map<string, ReviewSummary> => {
	const latest = new Map<string, ReviewRow>();
	for (const row of rows) {
		latest.set(row.reviewId, row);
	}
	const from = nowMs - REVIEW_WINDOW_DAYS * DAY_MS;
	const to = nowMs + 60 * 60_000;
	const byKey = new Map<string, Map<string, ReviewRow[]>>();
	for (const row of latest.values()) {
		const at = Date.parse(row.at);
		if (row.withdrawn || !(at >= from && at <= to)) {
			continue;
		}
		const reviewers = byKey.get(row.key) ?? new Map<string, ReviewRow[]>();
		const own = reviewers.get(row.reviewer) ?? [];
		own.push(row);
		reviewers.set(row.reviewer, own);
		byKey.set(row.key, reviewers);
	}
	const out = new Map<string, ReviewSummary>();
	for (const [key, reviewers] of [...byKey].sort(([a], [b]) =>
		a < b ? -1 : 1
	)) {
		let reviews = 0;
		let lastAt = 0;
		for (const own of reviewers.values()) {
			reviews += own.length;
			for (const row of own) {
				lastAt = Math.max(lastAt, Date.parse(row.at));
			}
		}
		const count = reviewers.size;
		if (count < MIN_REVIEWERS_SHOWN) {
			out.set(key, {
				...emptyReviewSummary(),
				reviewers: count,
				reviews,
			});
			continue;
		}
		let ratingSum = 0;
		const outcomeSum: Record<ReviewOutcome, number> = {
			not_useful: 0,
			partial: 0,
			useful: 0,
		};
		const flagged = new Map<ReviewIssue, number>();
		for (const own of reviewers.values()) {
			ratingSum += own.reduce((sum, row) => sum + row.rating, 0) / own.length;
			for (const outcome of REVIEW_OUTCOMES) {
				outcomeSum[outcome] +=
					own.filter((row) => row.outcome === outcome).length / own.length;
			}
			for (const issue of new Set(own.flatMap((row) => row.issues))) {
				flagged.set(issue, (flagged.get(issue) ?? 0) + 1);
			}
		}
		out.set(key, {
			issues: [...flagged]
				.sort(([a, left], [b, right]) => right - left || (a < b ? -1 : 1))
				.slice(0, MAX_SUMMARY_ISSUES)
				.map(([issue, reviewersFlagging]) => ({
					issue,
					share: twoDecimals(reviewersFlagging / count),
				})),
			lastReviewAt: new Date(lastAt).toISOString(),
			minReviewers: MIN_REVIEWERS_SHOWN,
			outcomes: {
				not_useful: twoDecimals(outcomeSum.not_useful / count),
				partial: twoDecimals(outcomeSum.partial / count),
				useful: twoDecimals(outcomeSum.useful / count),
			},
			rating: oneDecimal(ratingSum / count),
			reviewers: count,
			reviews,
			shown: true,
		});
	}
	return out;
};
