import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	type Contribution,
	contributionHeading,
	DEFAULT_UNIT,
	describeDay,
	toMonthLabels,
} from "./github-activity-model.ts";

const tl: LiteralMessage = (source, values) => formatMessage(source, values);

function weeksFrom(start: string, count: number): Contribution[][] {
	const first = Date.parse(`${start}T00:00:00Z`);
	return Array.from({ length: count }, (_, week) => [
		{
			count: 0,
			date: new Date(first + week * 7 * 86_400_000).toISOString().slice(0, 10),
			level: 0,
		},
	]);
}

describe("toMonthLabels", () => {
	test("names months in the requested locale", () => {
		const weeks = weeksFrom("2026-01-04", 9);
		expect(toMonthLabels(weeks, "en")[0]).toBe("Jan");
		expect(toMonthLabels(weeks, "de")[0]).toBe(
			new Intl.DateTimeFormat("de", { month: "short", timeZone: "UTC" }).format(
				Date.UTC(2000, 0, 1)
			)
		);
	});
});

describe("describeDay", () => {
	test("pluralizes the default unit through ICU and formats the date", () => {
		const day: Contribution = { count: 1, date: "2026-10-30", level: 1 };
		expect(describeDay(day, DEFAULT_UNIT, tl, "en")).toBe(
			"1 contribution on Oct 30, 2026"
		);
		expect(describeDay({ ...day, count: 3 }, DEFAULT_UNIT, tl, "en")).toBe(
			"3 contributions on Oct 30, 2026"
		);
	});

	test("uses a caller's unit words", () => {
		const unit = { plural: "requests", singular: "request" };
		expect(
			describeDay({ count: 2, date: "2026-10-30", level: 1 }, unit, tl, "en")
		).toBe("2 requests on Oct 30, 2026");
	});
});

describe("contributionHeading", () => {
	test("names the year only when there is one", () => {
		expect(contributionHeading(1, DEFAULT_UNIT, 2026, tl)).toBe(
			"1 contribution in 2026"
		);
		expect(contributionHeading(1234, DEFAULT_UNIT, null, tl)).toBe(
			"1,234 contributions"
		);
	});
});
