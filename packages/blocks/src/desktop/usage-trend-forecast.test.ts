import { describe, expect, it } from "bun:test";
import {
	aggregateUsageEvents,
	type UsageEvent,
	usageForecastTimeline,
} from "./usage-analytics.ts";
import { buildUsageTrendChart } from "./usage-trend-forecast.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const FROM = new Date("2026-09-14T00:00:00.000Z");
const TO = new Date("2026-10-14T00:00:00.000Z");
/** Midday on the last day of the range: that bucket is still in progress. */
const NOW = Date.parse("2026-10-13T12:00:00.000Z");

function dailyEvents(): UsageEvent[] {
	const events: UsageEvent[] = [];
	for (let day = 0; day < 30; day += 1) {
		const timestamp = new Date(FROM.getTime() + day * DAY_MS + 3_600_000);
		events.push({
			costMicroUsd: 1000 + day * 100,
			inputTokens: 100,
			outputTokens: 50,
			provider: "openai",
			requestCount: 10 + day,
			timestamp: timestamp.toISOString(),
		});
		if (day % 2 === 0) {
			events.push({
				provider: "anthropic",
				requestCount: 5,
				timestamp: timestamp.toISOString(),
			});
		}
	}
	return events;
}

function analytics(events = dailyEvents(), to = TO) {
	return aggregateUsageEvents({
		caption: "",
		events,
		from: FROM,
		granularity: "daily",
		scope: "you",
		scopeLabel: "You",
		to,
	});
}

describe("aggregateUsageEvents provider series", () => {
	it("aligns top providers with buckets", () => {
		const data = analytics();
		const [openai, anthropic] = data.providerSeries ?? [];
		expect(openai?.key).toBe("openai");
		expect(openai?.requests).toHaveLength(data.buckets.length);
		expect(openai?.requests[0]).toBe(10);
		expect(openai?.spendMicroUsd[0]).toBe(1000);
		expect(anthropic?.requests.slice(0, 3)).toEqual([5, 0, 5]);
		expect(anthropic?.spendMicroUsd[0]).toBeNull();
	});
});

describe("usageForecastTimeline", () => {
	it("fits completed buckets and projects from the in-progress one", () => {
		const data = analytics();
		const timeline = usageForecastTimeline(data.buckets, "daily", NOW);
		expect(timeline?.fitCount).toBe(29);
		expect(timeline?.slots).toHaveLength(14);
		expect(timeline?.slots[0]?.bucketIndex).toBe(29);
		expect(timeline?.slots[1]?.bucketIndex).toBeNull();
		expect(timeline?.slots[1]?.start).toBe("2026-10-14T00:00:00.000Z");
	});

	it("skips ranges that ended before the current bucket", () => {
		const data = analytics(dailyEvents(), new Date("2026-10-01T00:00:00.000Z"));
		expect(usageForecastTimeline(data.buckets, "daily", NOW)).toBeNull();
	});
});

describe("buildUsageTrendChart", () => {
	it("adds a bridged forecast and range to the total view", () => {
		const model = buildUsageTrendChart({
			data: analytics(),
			forecast: true,
			metric: "requests",
			metricLabel: "Requests",
			now: NOW,
			view: "total",
		});
		expect(model.forecastGap).toBeNull();
		expect(model.rows).toHaveLength(30 + 13);
		const bridge = model.rows[28];
		const bridgeActual = Number(bridge?.actual);
		expect(bridgeActual).toBeGreaterThan(0);
		expect(Number(bridge?.actualForecast)).toBe(bridgeActual);
		expect(bridge?.band).toEqual([bridgeActual, bridgeActual]);
		const appended = model.rows.at(-1);
		expect(appended?.actual).toBeNull();
		expect(typeof appended?.actualForecast).toBe("number");
		expect(Array.isArray(appended?.band)).toBe(true);
		expect(model.series[0]?.forecast?.direction).toBe("up");
	});

	it("forecasts each provider separately", () => {
		const model = buildUsageTrendChart({
			data: analytics(),
			forecast: true,
			metric: "requests",
			metricLabel: "Requests",
			now: NOW,
			view: "provider",
		});
		expect(model.series.map((series) => series.key)).toEqual([
			"openai",
			"anthropic",
		]);
		expect(model.series[0]?.forecast?.total.value ?? 0).toBeGreaterThan(
			model.series[1]?.forecast?.total.value ?? 0
		);
		expect(model.rows.at(-1)?.band).toBeUndefined();
	});

	it("falls back to the total view when only totals are reported", () => {
		const { providerSeries: _omitted, ...data } = analytics();
		const model = buildUsageTrendChart({
			data,
			forecast: true,
			metric: "spend",
			metricLabel: "Credit spend",
			now: NOW,
			view: "provider",
		});
		expect(model.providerFallback).toBe(true);
		expect(model.view).toBe("total");
	});

	it("explains why a forecast is missing", () => {
		const base = {
			forecast: true,
			metric: "requests" as const,
			metricLabel: "Requests",
			now: NOW,
			view: "total" as const,
		};
		expect(
			buildUsageTrendChart({ ...base, data: analytics([]) }).forecastGap
		).toBe("insufficient-data");
		expect(
			buildUsageTrendChart({
				...base,
				data: analytics(dailyEvents(), new Date("2026-10-01T00:00:00.000Z")),
			}).forecastGap
		).toBe("range-ended");
		expect(
			buildUsageTrendChart({ ...base, data: analytics(), forecast: false })
				.forecastGap
		).toBe("disabled");
	});
});
