import { describe, expect, test } from "bun:test";
import {
	activePassTranslate,
	englishPassTranslate,
	formatPassDays,
	formatPassDecimalHours,
} from "./labels.ts";
import { formatPassHours, milestoneCardContent } from "./paint-referral.ts";

describe("pass labels", () => {
	test("keep English output identical without a provider", () => {
		expect(formatPassDecimalHours(2.5)).toBe("2.5h");
		expect(formatPassDecimalHours(1234.5)).toBe("1234.5h");
		expect(formatPassDays(12)).toBe("12d");
		expect(formatPassHours(1234.9)).toBe("1,234h");
		expect(
			activePassTranslate("{n, plural, one {# seat} other {# seats}}", { n: 2 })
		).toBe("2 seats");
		expect(englishPassTranslate("Issued by")).toBe("Issued by");
	});

	test("format numbers in a requested locale", () => {
		expect(formatPassDecimalHours(2.5, "de")).toBe(
			new Intl.NumberFormat("de", {
				maximumFractionDigits: 1,
				minimumFractionDigits: 1,
				style: "unit",
				unit: "hour",
				unitDisplay: "narrow",
				useGrouping: false,
			}).format(2.5)
		);
	});

	test("let a caller translate a card's labels", () => {
		const upper = (source: string) => source.toUpperCase();
		const content = milestoneCardContent(
			{
				hours: 1,
				inviteUrl: "https://example.test/r/A",
				seats: 2,
				seatsClaimed: 0,
				thresholdHours: 1,
			},
			upper
		);
		expect(content.stats.map((stat) => stat.label)).toEqual([
			"AGENT TIME",
			"SEATS",
			"SEATS LEFT",
			"JOINED",
		]);
	});
});
