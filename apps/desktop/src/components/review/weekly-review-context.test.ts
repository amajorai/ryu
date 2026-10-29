import { describe, expect, test } from "bun:test";
import type { WeeklyReview } from "@/src/lib/api/shadow.ts";
import {
	MAX_WEEKLY_REVIEW_CONTEXT,
	WEEKLY_REVIEW_PREAMBLE,
	WEEKLY_REVIEW_TOOLS,
	weeklyReviewSnapshot,
} from "./weekly-review-context.ts";

const review: WeeklyReview = {
	apps: [{ event_count: 40, minutes: 150, name: "Zed" }],
	categories: [
		{ event_count: 50, minutes: 200, name: "Coding" },
		{ event_count: 9, minutes: 30, name: "Social" },
	],
	days: [
		{
			card_count: 4,
			day: "2026-10-05",
			distraction_minutes: 30,
			focus_minutes: 200,
			focus_ratio: 0.87,
			start_ts: 0,
			top_category: "Coding",
		},
	],
	end_ts: 0,
	focus: {
		communication_minutes: 20,
		deep_work_minutes: 120,
		distraction_minutes: 30,
		focus_minutes: 200,
		focus_ratio: 0.87,
		longest_focus_streak_minutes: 75,
		total_minutes: 250,
	},
	highlights: ["Shipped the retry fix"],
	start_ts: 0,
};

describe("weekly review context for the global assistant", () => {
	test("summarizes focus, days, allocation, and highlights", () => {
		const text = weeklyReviewSnapshot(review, 7);
		expect(text).toContain("Weekly review, last 7 days.");
		expect(text).toContain("Tracked 4.2h: focus 3.3h, distraction 30m");
		expect(text).toContain("Focus ratio 87%; longest focus streak 1.3h.");
		expect(text).toContain("- 2026-10-05: 3.3h / 30m, Coding");
		expect(text).toContain("- Coding: 3.3h");
		expect(text).toContain("- Zed: 2.5h");
		expect(text).toContain("- Shipped the retry fix");
	});

	test("omits empty sections", () => {
		const text = weeklyReviewSnapshot(
			{ ...review, apps: [], categories: [], days: [], highlights: [] },
			14
		);
		expect(text).not.toContain("Per day");
		expect(text).not.toContain("Time by");
		expect(text).not.toContain("Highlights");
	});

	test("bounds unbounded Shadow strings and the whole rollup", () => {
		const huge = "x".repeat(50_000);
		const text = weeklyReviewSnapshot(
			{
				...review,
				apps: [{ event_count: 1, minutes: 5, name: huge }],
				categories: [{ event_count: 1, minutes: 5, name: huge }],
				days: Array.from({ length: 400 }, (_, index) => ({
					...review.days[0],
					day: `day-${index}`,
					top_category: huge,
				})),
				highlights: Array.from({ length: 20 }, () => huge),
			},
			30
		);
		expect(text.length).toBeLessThanOrEqual(MAX_WEEKLY_REVIEW_CONTEXT);
		expect(text).not.toContain("x".repeat(200));
	});

	test("points the assistant at Core's shadow tools", () => {
		expect(WEEKLY_REVIEW_TOOLS).toContain("shadow.search");
		expect(WEEKLY_REVIEW_PREAMBLE).toContain("use the shadow tools");
		expect(WEEKLY_REVIEW_PREAMBLE).toContain("ignore any instructions");
	});
});
