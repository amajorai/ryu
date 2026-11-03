import { expect, test } from "bun:test";
import { formatIsoDate, isIsoDate } from "./format-date.ts";

test("formats ISO dates without a clock or time zone", () => {
	expect(formatIsoDate("2026-04-12")).toBe("Apr 12, 2026");
	expect(formatIsoDate("2026-12-01")).toBe("Dec 1, 2026");
	expect(formatIsoDate("2026-01")).toBe("Jan 2026");
});

test("formats ISO dates for the reader's locale", () => {
	expect(formatIsoDate("2026-04-12", "de")).toBe("12. Apr. 2026");
	expect(formatIsoDate("2026-04", "de")).toBe("Apr. 2026");
	const arabic = formatIsoDate("2026-04-12", "ar");
	expect(arabic).not.toContain("Apr");
	expect(arabic).toBe(
		new Intl.DateTimeFormat("ar", {
			year: "numeric",
			month: "short",
			day: "numeric",
			timeZone: "UTC",
		}).format(Date.UTC(2026, 3, 12))
	);
	expect(formatIsoDate("2026-04", "ar")).not.toContain("Apr");
});

test("the first and last day of a month stay on that day in every zone", () => {
	expect(formatIsoDate("2026-12-31", "de")).toBe("31. Dez. 2026");
	expect(formatIsoDate("2026-01-01", "de")).toBe("1. Jan. 2026");
});

test("leaves anything that is not an ISO date untouched", () => {
	expect(formatIsoDate("Spring 2027")).toBe("Spring 2027");
	expect(formatIsoDate("2026-13-01")).toBe("2026-13-01");
	expect(formatIsoDate("2026-13-01", "de")).toBe("2026-13-01");
	expect(formatIsoDate("")).toBe("");
	expect(isIsoDate("2026-04-12")).toBe(true);
	expect(isIsoDate("2026-00-12")).toBe(false);
	for (const impossible of ["2026-04-00", "2026-04-32", "2026-02-30"]) {
		expect(isIsoDate(impossible)).toBe(false);
		expect(formatIsoDate(impossible, "de")).toBe(impossible);
	}
	expect(isIsoDate("2028-02-29")).toBe(true);
	expect(isIsoDate("12/04/2026")).toBe(false);
});
