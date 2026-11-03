import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { dayHeading, dayTick, forecastLabel } from "./usage-chart-format.ts";

// 2026-11-03T00:00:00Z, the start of a UTC usage bucket.
const NOV_3 = Date.UTC(2026, 10, 3);

describe("usage chart dates", () => {
	test("ticks use the locale's short date, not an ISO slice", () => {
		expect(dayTick("de", NOV_3)).toBe("3. Nov.");
		expect(dayTick("en", NOV_3)).toBe("Nov 3");
		expect(dayTick("de", NOV_3)).not.toBe("11-03");
	});

	test("the tooltip heading uses the locale's medium date", () => {
		expect(dayHeading("de", NOV_3)).toBe("03.11.2026");
		expect(dayHeading("en", NOV_3)).toBe("Nov 3, 2026");
	});

	test("ja and ar use their own date order and month names", () => {
		expect(dayTick("ja", NOV_3)).toBe("11月3日");
		expect(dayHeading("ja", NOV_3)).toBe("2026/11/03");
		expect(dayTick("ar", NOV_3)).toContain("نوفمبر");
		expect(dayHeading("ar", NOV_3)).not.toBe("2026-11-03");
	});

	test("dates stay on the UTC bucket day at its last millisecond", () => {
		const lastMs = Date.UTC(2026, 10, 3, 23, 59, 59, 999);
		expect(dayTick("en", lastMs)).toBe("Nov 3");
	});

	test("a missing timestamp gives an empty label", () => {
		expect(dayTick("de", Number.NaN)).toBe("");
		expect(dayHeading("de", Number.NaN)).toBe("");
	});
});

describe("forecastLabel", () => {
	test("asks the catalog for one whole message", () => {
		const calls: [string, unknown][] = [];
		const tl: LiteralMessage = (source, values) => {
			calls.push([source, values]);
			return `Prognose für ${String(
				(values as { source?: string } | undefined)?.source
			)}`;
		};
		expect(forecastLabel(tl, "Claude Code")).toBe("Prognose für Claude Code");
		expect(calls).toEqual([["{source} forecast", { source: "Claude Code" }]]);
	});
});
