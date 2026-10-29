import { afterEach, describe, expect, it } from "bun:test";
import {
	formatDate,
	resetTimezone,
	setTimezonePreference,
} from "./timezone.ts";

describe("formatDate", () => {
	afterEach(() => {
		resetTimezone();
	});

	it("adds the localized month when callers request only day and year", () => {
		setTimezonePreference("UTC");
		const date = new Date("2026-09-26T12:00:00.000Z");
		const localizedMonth = new Intl.DateTimeFormat(undefined, {
			month: "short",
			timeZone: "UTC",
		}).format(date);

		const formatted = formatDate(date, { day: "numeric", year: "numeric" });
		expect(formatted).toContain(localizedMonth);
		expect(formatted).toContain("2026");
		expect(formatted).not.toContain("(day:");
	});

	it("keeps explicit month formats and date-only values in UTC", () => {
		setTimezonePreference("Pacific/Honolulu");
		const options = {
			day: "numeric",
			month: "long",
			year: "numeric",
		} satisfies Intl.DateTimeFormatOptions;
		const expected = new Intl.DateTimeFormat(undefined, {
			...options,
			timeZone: "UTC",
		}).format(new Date("2026-09-26T12:00:00.000Z"));

		expect(
			formatDate("2026-09-26", {
				day: "numeric",
				year: "numeric",
			})
		).toContain("2026");
		expect(formatDate("2026-09-26", options)).toBe(expected);
	});
});
