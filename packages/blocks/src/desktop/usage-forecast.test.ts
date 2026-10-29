import { describe, expect, test } from "bun:test";
import {
	forecastUsageSeries,
	formatForecastChange,
	projectPeriodTotal,
	utcMonthBounds,
} from "./usage-forecast.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("forecastUsageSeries", () => {
	test("needs enough recent activity before projecting", () => {
		expect(forecastUsageSeries([], 7)).toBeNull();
		expect(forecastUsageSeries([5, 6, 7], 7)).toBeNull();
		expect(forecastUsageSeries([0, 0, 0, 0, 9, 0], 7)).toBeNull();
		expect(forecastUsageSeries([4, 5, 6, 7], 0)).toBeNull();
	});

	test("continues a steady series at its level with a tight range", () => {
		const forecast = forecastUsageSeries(
			Array.from({ length: 20 }, () => 100),
			7
		);
		expect(forecast).not.toBeNull();
		if (!forecast) {
			return;
		}
		expect(forecast.points).toHaveLength(7);
		for (const point of forecast.points) {
			expect(point.value).toBeCloseTo(100, 0);
			expect(point.upper - point.lower).toBeLessThan(1);
		}
		expect(forecast.total.value).toBeCloseTo(700, 0);
		expect(forecast.direction).toBe("flat");
		expect(formatForecastChange(forecast)).toBe("Steady");
	});

	test("extends a rising trend along its fitted slope", () => {
		const rising = Array.from({ length: 21 }, (_, day) => 10 + day * 5);
		const forecast = forecastUsageSeries(rising, 14);
		expect(forecast?.direction).toBe("up");
		const points = forecast?.points ?? [];
		expect(points[0]?.value).toBeCloseTo(115, 5);
		expect(points.at(-1)?.value).toBeCloseTo(180, 5);
		// A perfect line leaves no residual spread.
		expect((points[0]?.upper ?? 0) - (points[0]?.lower ?? 0)).toBeCloseTo(0, 5);
		expect(formatForecastChange(forecast ?? never())).toMatch(/^↑ \d+%$/);
	});

	test("averages out weekly cycles into the underlying trend", () => {
		const weekly = Array.from(
			{ length: 28 },
			(_, day) => 100 + day * 2 + (day % 7 >= 5 ? -60 : 15)
		);
		const forecast = forecastUsageSeries(weekly, 7);
		const firstStep =
			(forecast?.points[1]?.value ?? 0) - (forecast?.points[0]?.value ?? 0);
		expect(firstStep).toBeGreaterThan(0.5);
		expect(firstStep).toBeLessThan(3);
		// Projects the weekly average, not the weekend low it was read on.
		expect(forecast?.points[0]?.value ?? 0).toBeGreaterThan(120);
	});

	test("never projects negative usage on a falling series", () => {
		const falling = Array.from({ length: 14 }, (_, day) => 140 - day * 10);
		const forecast = forecastUsageSeries(falling, 30);
		expect(forecast?.direction).toBe("down");
		for (const point of forecast?.points ?? []) {
			expect(point.value).toBeGreaterThanOrEqual(0);
			expect(point.lower).toBeGreaterThanOrEqual(0);
			expect(point.upper).toBeGreaterThanOrEqual(point.value);
		}
	});

	test("widens the range with noisy usage and with distance", () => {
		const noisy = [10, 90, 20, 80, 15, 95, 25, 70, 30, 85, 12, 88];
		const forecast = forecastUsageSeries(noisy, 5);
		const points = forecast?.points ?? [];
		const firstWidth = (points[0]?.upper ?? 0) - (points[0]?.lower ?? 0);
		const lastWidth = (points.at(-1)?.upper ?? 0) - (points.at(-1)?.lower ?? 0);
		expect(firstWidth).toBeGreaterThan(20);
		expect(lastWidth).toBeGreaterThanOrEqual(firstWidth);
	});

	test("fits only the trailing window and ignores invalid samples", () => {
		const series = [
			...Array.from({ length: 60 }, () => 1000),
			...Array.from({ length: 10 }, () => 10),
		];
		const forecast = forecastUsageSeries(
			series.map((value, index) => (index === 65 ? Number.NaN : value)),
			3,
			{ fitWindow: 10 }
		);
		expect(forecast?.fittedSamples).toBe(10);
		expect(forecast?.points[0]?.value ?? 0).toBeLessThan(50);
	});
});

describe("projectPeriodTotal", () => {
	const start = Date.UTC(2026, 9, 1);
	const end = Date.UTC(2026, 10, 1);

	test("scales month-to-date by elapsed share of the month", () => {
		const projected = projectPeriodTotal(10, start, end, start + 10 * DAY_MS);
		expect(projected).toBeCloseTo(31, 5);
	});

	test("waits for an hour of data and stops at the period end", () => {
		expect(projectPeriodTotal(10, start, end, start + HOUR_MS / 2)).toBeNull();
		expect(projectPeriodTotal(10, start, end, end + DAY_MS)).toBe(10);
	});
});

describe("utcMonthBounds", () => {
	test("reads YYYY-MM keys and falls back to the current UTC month", () => {
		expect(utcMonthBounds("2026-12")).toEqual({
			end: Date.UTC(2027, 0, 1),
			start: Date.UTC(2026, 11, 1),
		});
		expect(utcMonthBounds("UTC", Date.UTC(2026, 1, 14, 12))).toEqual({
			end: Date.UTC(2026, 2, 1),
			start: Date.UTC(2026, 1, 1),
		});
	});
});

function never(): never {
	throw new Error("expected a forecast");
}
