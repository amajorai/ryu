import { expect, test } from "bun:test";
import { forecastDailyValues } from "./history-forecast.ts";

test("fills missing days with zero and projects from today", () => {
	const values = new Map<string, number>();
	for (let day = 1; day <= 12; day += 1) {
		if (day % 3 !== 0) {
			values.set(`2026-10-${String(day).padStart(2, "0")}`, 1000);
		}
	}
	values.set("2026-10-13", 5);
	const result = forecastDailyValues(values, "2026-10-13", 3);
	expect(result?.forecast.fittedSamples).toBe(12);
	expect(result?.bridgeDate).toBe("2026-10-12");
	expect(result?.bridgeValue).toBe(0);
	expect(result?.dates).toEqual(["2026-10-13", "2026-10-14", "2026-10-15"]);
	// Partial today is not fitted, so it cannot drag the projection to ~5.
	expect(result?.forecast.points[0]?.value ?? 0).toBeGreaterThan(100);
});

test("skips histories without recent completed activity", () => {
	expect(forecastDailyValues(new Map(), "2026-10-13")).toBeNull();
	expect(
		forecastDailyValues(new Map([["2026-10-13", 50]]), "2026-10-13")
	).toBeNull();
	const stale = new Map([
		["2026-06-01", 100],
		["2026-06-02", 100],
	]);
	expect(forecastDailyValues(stale, "2026-10-13")).toBeNull();
});
