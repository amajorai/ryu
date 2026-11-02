import { describe, expect, it } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import { formatDocumentDate } from "./desktop/spaces-document-format.ts";
import { formatBucketLabel } from "./desktop/usage-analytics.ts";
import { approximateCount } from "./web/pricing-credit-estimates.ts";
import { depositFeeAmounts } from "./web/pricing-deposit-fee-format.ts";
import { formatJoined } from "./web/profile-settings-stats-format.ts";
import { formatPublicationDate } from "./web/publication-date.ts";

// The blocks outside interfaces/ and agent-elements/ format dates, counts and
// plurals for the UI locale they are given, never a hard-coded en-US or the
// operating system's locale.

const MARCH_15 = Date.UTC(2026, 2, 15, 12);

describe("locale-aware blocks formatting", () => {
	it("keeps the English output", () => {
		expect(formatDocumentDate(MARCH_15, "en")).toBe("Mar 15, 2026");
		expect(formatJoined("2026-03-15T12:00:00.000Z", "en")).toBe("March 2026");
		expect(formatPublicationDate("2026-03-15", "short", "en")).toBe(
			"Mar 15, 2026"
		);
		expect(approximateCount(9727.6, "en")).toBe("9,700");
		expect(depositFeeAmounts("en").depositFeeMinimum).toBe("$5");
	});

	it("follows ja, ar and de", () => {
		expect(formatDocumentDate(MARCH_15, "ja")).toBe("2026年3月15日");
		expect(formatJoined("2026-03-15T12:00:00.000Z", "ja")).toBe("2026年3月");
		expect(formatPublicationDate("2026-03-15", "long", "de")).toBe(
			"15. März 2026"
		);
		expect(formatBucketLabel(new Date(MARCH_15), "monthly", "ja")).toBe(
			"2026年3月"
		);
		expect(formatDocumentDate(MARCH_15, "ar")).not.toBe(
			formatDocumentDate(MARCH_15, "en")
		);
		expect(approximateCount(9727.6, "de")).toBe("9.700");
		expect(depositFeeAmounts("de").depositFeeMinimum).not.toBe("$5");
	});

	it("picks whole-sentence plural forms per locale", () => {
		const runs = "{runCount, plural, one {# run} other {# runs}}";
		expect(formatMessage(runs, { runCount: 1 }, "en")).toBe("1 run");
		expect(formatMessage(runs, { runCount: 3 }, "en")).toBe("3 runs");
		const steps =
			"{count, plural, one {~{countText} step} other {~{countText} steps}}";
		expect(
			formatMessage(steps, { count: 9700, countText: "9,700" }, "en")
		).toBe("~9,700 steps");
		// Arabic has more categories than English; the "other" branch is still
		// a whole sentence, not an English suffix glued onto a number.
		expect(formatMessage(runs, { runCount: 11 }, "ar")).toContain("runs");
	});
});
